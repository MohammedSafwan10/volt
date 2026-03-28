import type { AssistantDispatchStepResponse } from "$features/assistant/runtime/native-runtime";
import type {
  QueuedFileEditTool,
  QueuedNonFileTool,
  ToolExecutionResult,
} from "./loop-executor";

export interface NativeDispatchSchedulingDecision {
  executionStages?: string[];
  deferUntilFileEditsComplete: boolean;
  fileEditConcurrency?: number;
  orderedFileQueueKeys?: string[];
  orderedEagerToolIds?: string[];
  orderedDeferredToolIds?: string[];
  pendingApprovalToolIds?: string[];
}

export interface NativeDispatchAuthority {
  setPlan: (params: {
    executionStages: string[];
    eagerToolIds: string[];
    deferredToolIds: string[];
    fileQueueKeys: string[];
    fileEditConcurrency?: number;
    pendingApprovalToolIds: string[];
  }) => Promise<AssistantDispatchStepResponse>;
  claimNextStep: () => Promise<AssistantDispatchStepResponse>;
  completeStep: (
    stepId: string,
    meta?: Record<string, unknown>,
  ) => Promise<AssistantDispatchStepResponse>;
}

export function reorderQueuedToolsByIds<T extends { id: string }>(
  tools: T[],
  orderedIds: string[] | undefined,
): T[] {
  if (!orderedIds?.length) return tools;
  const byId = new Map(tools.map((tool) => [tool.id, tool] as const));
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const tool = byId.get(id);
    if (!tool) continue;
    ordered.push(tool);
    byId.delete(id);
  }
  return [...ordered, ...byId.values()];
}

export function reorderFileEditTasksByKeys(
  tasks: Array<[string, QueuedFileEditTool[]]>,
  orderedKeys: string[] | undefined,
): Array<[string, QueuedFileEditTool[]]> {
  if (!orderedKeys?.length) return tasks;
  const byKey = new Map(tasks);
  const ordered: Array<[string, QueuedFileEditTool[]]> = [];
  for (const key of orderedKeys) {
    const task = byKey.get(key);
    if (!task) continue;
    ordered.push([key, task]);
    byKey.delete(key);
  }
  return [...ordered, ...byKey.entries()];
}

export function resolveExecutionStages(params: {
  nativeStages?: string[];
  hasEagerTools: boolean;
  hasDeferredTools: boolean;
  hasFileEdits: boolean;
  deferUntilFileEditsComplete: boolean;
}): string[] {
  if (params.nativeStages?.length) return params.nativeStages;

  const stages: string[] = [];
  if (params.hasEagerTools) {
    stages.push("eager_tools");
  }
  if (params.hasDeferredTools && !params.deferUntilFileEditsComplete) {
    stages.push("deferred_tools");
  }
  if (params.hasFileEdits) {
    stages.push("file_edits");
  }
  if (params.hasDeferredTools && params.deferUntilFileEditsComplete) {
    stages.push("deferred_tools");
  }
  return stages;
}

export async function executeNativeDispatchPlan(params: {
  schedulingDecision: NativeDispatchSchedulingDecision;
  eagerTools: QueuedNonFileTool[];
  deferredTools: QueuedNonFileTool[];
  fileEditTasks: Array<[string, QueuedFileEditTool[]]>;
  authority?: NativeDispatchAuthority;
  runQueuedNonFileStage: (
    toolsToRun: QueuedNonFileTool[],
  ) => Promise<ToolExecutionResult[]>;
  runFileEditStage: (
    fileEditTasks: Array<[string, QueuedFileEditTool[]]>,
    concurrency: number,
  ) => Promise<ToolExecutionResult[]>;
}): Promise<ToolExecutionResult[]> {
  const orderedEagerTools = reorderQueuedToolsByIds(
    params.eagerTools,
    params.schedulingDecision.orderedEagerToolIds,
  );
  const orderedDeferredTools = reorderQueuedToolsByIds(
    params.deferredTools,
    params.schedulingDecision.orderedDeferredToolIds,
  );
  const orderedFileEditTasks = reorderFileEditTasksByKeys(
    params.fileEditTasks,
    params.schedulingDecision.orderedFileQueueKeys,
  );
  const fileEditConcurrency =
    params.schedulingDecision.fileEditConcurrency ??
    Math.min(4, Math.max(1, orderedFileEditTasks.length));
  const executionStages = resolveExecutionStages({
    nativeStages: params.schedulingDecision.executionStages,
    hasEagerTools: orderedEagerTools.length > 0,
    hasDeferredTools: orderedDeferredTools.length > 0,
    hasFileEdits: orderedFileEditTasks.length > 0,
    deferUntilFileEditsComplete: params.schedulingDecision.deferUntilFileEditsComplete,
  });

  const executeStageLocally = async (stage: string): Promise<ToolExecutionResult[]> => {
    if (stage === "eager_tools" && orderedEagerTools.length > 0) {
      return params.runQueuedNonFileStage(orderedEagerTools);
    }
    if (stage === "file_edits" && orderedFileEditTasks.length > 0) {
      return params.runFileEditStage(orderedFileEditTasks, fileEditConcurrency);
    }
    if (stage === "deferred_tools" && orderedDeferredTools.length > 0) {
      return params.runQueuedNonFileStage(orderedDeferredTools);
    }
    return [];
  };

  if (!params.authority) {
    const fallbackResults: ToolExecutionResult[] = [];
    for (const stage of executionStages) {
      fallbackResults.push(...(await executeStageLocally(stage)));
    }
    return fallbackResults;
  }

  let planned: AssistantDispatchStepResponse;
  try {
    planned = await params.authority.setPlan({
      executionStages,
      eagerToolIds: orderedEagerTools.map((tool) => tool.id),
      deferredToolIds: orderedDeferredTools.map((tool) => tool.id),
      fileQueueKeys: orderedFileEditTasks.map(([queueKey]) => queueKey),
      fileEditConcurrency,
      pendingApprovalToolIds: params.schedulingDecision.pendingApprovalToolIds ?? [],
    });
  } catch {
    const fallbackResults: ToolExecutionResult[] = [];
    for (const stage of executionStages) {
      fallbackResults.push(...(await executeStageLocally(stage)));
    }
    return fallbackResults;
  }

  if (!planned.success) {
    const fallbackResults: ToolExecutionResult[] = [];
    for (const stage of executionStages) {
      fallbackResults.push(...(await executeStageLocally(stage)));
    }
    return fallbackResults;
  }

  const results: ToolExecutionResult[] = [];
  while (true) {
    let next: AssistantDispatchStepResponse;
    try {
      next = await params.authority.claimNextStep();
    } catch {
      break;
    }
    const step = next.activeStep;
    if (!step) {
      break;
    }

    if (step.blockedReason) {
      break;
    }

    const stageResults = await executeStageLocally(step.stage);
    results.push(...stageResults);
    try {
      await params.authority.completeStep(step.stepId, {
        stage: step.stage,
        resultCount: stageResults.length,
      });
    } catch {
      break;
    }
  }

  return results;
}
