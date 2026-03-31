import { invoke } from "@tauri-apps/api/core";

import type { AIMode } from "$features/assistant/stores/ai.svelte";
import type { AgentLoopState } from "$features/assistant/stores/assistant/loop-state";
import {
  assistantRunCancel,
  assistantRunClaimDispatchStep,
  assistantRunCompleteDispatchStep,
  assistantRunGetSnapshot,
  assistantRunResolveApprovals,
  assistantRunSetDispatchPlan,
  assistantRunStart,
  assistantRuntimePublishEvent,
  type AssistantRunSnapshot,
  type AssistantRuntimeEventPayload,
} from "$features/assistant/runtime/native-runtime";
import type { NativeRuntimeCommandResult } from "$features/assistant/runtime/agent-runtime";

interface AssistantStoreLike {
  agentLoopState: AgentLoopState;
  autoApproveAllTools: boolean;
  currentConversation?: { id: string } | null;
  setAgentLoopState: (state: AgentLoopState, meta?: Record<string, unknown>) => void;
  updateToolCallInMessage: (
    messageId: string,
    toolCallId: string,
    patch: Record<string, unknown>,
  ) => void;
  markAssistantMessageStreamState: (
    messageId: string,
    state: "completed" | "failed" | "cancelled" | "interrupted",
    issue?: string,
  ) => void;
  getRuntimeSnapshot: (conversationId: string) => unknown;
  applyNativeRuntimeSnapshot: (snapshot: AssistantRunSnapshot) => void;
}

interface AgentTelemetryStoreLike {
  record: (payload: {
    type: "agent.loop.state_transition";
    timestamp: number;
    from: AgentLoopState | null;
    to: AgentLoopState;
    meta?: Record<string, unknown>;
  }) => void;
}

interface RunIdMapLike {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}

const AGENT_LOOP_STATES: readonly AgentLoopState[] = [
  "running",
  "waiting_approval",
  "waiting_tool",
  "completing",
  "completed",
  "failed",
  "cancelled",
] as const;

export function normalizeAgentLoopState(value: unknown): AgentLoopState | undefined {
  if (typeof value !== "string") return undefined;
  return AGENT_LOOP_STATES.includes(value as AgentLoopState)
    ? (value as AgentLoopState)
    : undefined;
}

export function createAssistantPanelNativeRuntimeBridge(deps: {
  assistantStore: AssistantStoreLike;
  agentTelemetryStore: AgentTelemetryStoreLike;
  nativeRunIds: RunIdMapLike;
}) {
  const applyNativeRuntimeCommand = async (
    operation: string,
    conversationId: string,
    payload: Record<string, unknown>,
  ): Promise<NativeRuntimeCommandResult | null> => {
    try {
      return await invoke<NativeRuntimeCommandResult>("agent_runtime_apply", {
        request: {
          operation,
          conversationId,
          payload,
        },
      });
    } catch (error) {
      console.warn("[AssistantPanel] Native runtime bridge unavailable", {
        operation,
        error,
      });
      return null;
    }
  };

  const buildNativeRuntimeDecision = async (
    operation: string,
    conversationId: string,
    payload: Record<string, unknown>,
  ): Promise<NativeRuntimeCommandResult | null> => {
    const decision = await applyNativeRuntimeCommand(operation, conversationId, payload);
    if (!decision) return null;
    return {
      ...decision,
      loopState: normalizeAgentLoopState(decision.loopState),
    };
  };

  const applyNativeRuntimeDecision = (
    decision: NativeRuntimeCommandResult | null,
    fallbackState?: AgentLoopState,
    fallbackMeta: Record<string, unknown> = {},
  ): void => {
    if (!decision?.shouldApply) {
      if (fallbackState) {
        deps.assistantStore.setAgentLoopState(fallbackState, fallbackMeta);
      }
      return;
    }

    if (decision.auditEntry) {
      deps.agentTelemetryStore.record({
        type: "agent.loop.state_transition",
        timestamp: decision.auditEntry.timestampMs,
        from: deps.assistantStore.agentLoopState,
        to:
          normalizeAgentLoopState(decision.loopState) ??
          fallbackState ??
          deps.assistantStore.agentLoopState,
        meta: {
          source: "native_runtime_audit",
          operation: decision.auditEntry.operation,
          conversationId: decision.auditEntry.conversationId,
          ...(decision.auditEntry.meta ?? {}),
        },
      });
    }

    // Native tool patches are audit-only. Live tool card state is owned by the local assistant store.

    if (decision.messagePatch?.messageId && decision.messagePatch.streamState) {
      deps.assistantStore.markAssistantMessageStreamState(
        decision.messagePatch.messageId,
        decision.messagePatch.streamState,
        decision.messagePatch.streamIssue,
      );
    }

    deps.assistantStore.setAgentLoopState(
      decision.loopState ?? fallbackState ?? "running",
      {
        ...fallbackMeta,
        ...(decision.loopMeta ?? {}),
      },
    );
  };

  const applySnapshotForConversation = (
    conversationId: string,
    snapshot: AssistantRunSnapshot | null | undefined,
  ): void => {
    if (!snapshot) return;
    deps.nativeRunIds.set(conversationId, snapshot.runId);
    deps.assistantStore.applyNativeRuntimeSnapshot(snapshot);
  };

  const startNativeAssistantRun = async (params: {
    conversationId: string;
    mode: AIMode;
    modelId: string;
    systemPrompt: string;
  }): Promise<string | null> => {
    try {
      const response = await assistantRunStart({
        conversationId: params.conversationId,
        mode: params.mode,
        modelId: params.modelId,
        systemPrompt: params.systemPrompt,
        runtimeSnapshot:
          (deps.assistantStore.getRuntimeSnapshot(params.conversationId) as Record<string, unknown> | null) ??
          undefined,
        autoApproveAllTools: deps.assistantStore.autoApproveAllTools,
      });
      if (!response.accepted) return null;
      applySnapshotForConversation(params.conversationId, response.snapshot);
      return response.runId;
    } catch (error) {
      console.warn("[AssistantPanel] Failed to start native assistant run", {
        conversationId: params.conversationId,
        error,
      });
      return null;
    }
  };

  const hydrateNativeAssistantSnapshot = async (conversationId: string): Promise<void> => {
    try {
      const snapshot = await assistantRunGetSnapshot(conversationId);
      if (!snapshot || snapshot.conversationId !== conversationId) return;
      applySnapshotForConversation(conversationId, snapshot);
    } catch (error) {
      console.warn("[AssistantPanel] Failed to hydrate native assistant snapshot", {
        conversationId,
        error,
      });
    }
  };

  const publishNativeAssistantEvent = async (
    conversationId: string,
    kind: string,
    loopState?: AgentLoopState,
    payload: AssistantRuntimeEventPayload = {},
  ): Promise<void> => {
    const runId = deps.nativeRunIds.get(conversationId);
    if (!runId) return;
    try {
      await assistantRuntimePublishEvent({
        conversationId,
        runId,
        kind,
        loopState,
        payload,
      });
    } catch (error) {
      console.warn("[AssistantPanel] Failed to publish native assistant event", {
        conversationId,
        kind,
        error,
      });
    }
  };

  const publishNativeToolPatch = (
    conversationId: string,
    messageId: string,
    toolCallId: string,
    patch: Record<string, unknown>,
  ): Promise<void> =>
    publishNativeAssistantEvent(conversationId, "tool_call_updated", undefined, {
      toolPatch: {
        messageId,
        toolCallId,
        status: typeof patch.status === "string" ? patch.status : undefined,
        error: typeof patch.error === "string" ? patch.error : undefined,
        output: typeof patch.output === "string" ? patch.output : undefined,
        meta:
          patch.meta && typeof patch.meta === "object"
            ? (patch.meta as Record<string, unknown>)
            : undefined,
      },
    });

  const createNativeDispatchAuthority = (conversationId: string) => ({
    setPlan: async (params: {
      executionStages: string[];
      eagerToolIds: string[];
      deferredToolIds: string[];
      fileQueueKeys: string[];
      fileEditConcurrency?: number;
      pendingApprovalToolIds: string[];
    }) => {
      const response = await assistantRunSetDispatchPlan({
        conversationId,
        runId: deps.nativeRunIds.get(conversationId),
        executionStages: params.executionStages,
        eagerToolIds: params.eagerToolIds,
        deferredToolIds: params.deferredToolIds,
        fileQueueKeys: params.fileQueueKeys,
        fileEditConcurrency: params.fileEditConcurrency,
        pendingApprovalToolIds: params.pendingApprovalToolIds,
      });
      applySnapshotForConversation(conversationId, response.snapshot);
      return response;
    },
    claimNextStep: async () => {
      const response = await assistantRunClaimDispatchStep({
        conversationId,
        runId: deps.nativeRunIds.get(conversationId),
      });
      applySnapshotForConversation(conversationId, response.snapshot);
      return response;
    },
    completeStep: async (stepId: string, meta?: Record<string, unknown>) => {
      const response = await assistantRunCompleteDispatchStep({
        conversationId,
        runId: deps.nativeRunIds.get(conversationId),
        stepId,
        meta,
      });
      applySnapshotForConversation(conversationId, response.snapshot);
      return response;
    },
  });

  const resolveNativeApprovalAuthority = async (
    conversationId: string,
    toolIds?: string[],
  ): Promise<{
    shouldAbort: boolean;
    reason?: string;
    approvedToolIds: string[];
    deniedToolIds: string[];
    unresolvedToolIds: string[];
  } | null> => {
    try {
      const response = await assistantRunResolveApprovals({
        conversationId,
        runId: deps.nativeRunIds.get(conversationId),
      });
      applySnapshotForConversation(conversationId, response.snapshot);
      const approvedToolIds = toolIds?.length
        ? response.approvedToolIds.filter((toolId) => toolIds.includes(toolId))
        : response.approvedToolIds;
      const deniedToolIds = toolIds?.length
        ? response.deniedToolIds.filter((toolId) => toolIds.includes(toolId))
        : response.deniedToolIds;
      const unresolvedToolIds = toolIds?.length
        ? response.unresolvedToolIds.filter((toolId) => toolIds.includes(toolId))
        : response.unresolvedToolIds;
      return {
        shouldAbort: unresolvedToolIds.length > 0,
        reason: unresolvedToolIds.length > 0 ? "approval_flow_incomplete" : undefined,
        approvedToolIds,
        deniedToolIds,
        unresolvedToolIds,
      };
    } catch (error) {
      console.warn("[AssistantPanel] Failed to resolve native approvals", {
        conversationId,
        error,
      });
      return null;
    }
  };

  const waitForNativeToolApprovals = async (
    messageId: string,
    toolIds: string[],
    signal: AbortSignal,
    _getMessages: () => Array<{ id: string }>,
    updateToolCallInMessage: (
      msgId: string,
      toolId: string,
      patch: { status: "failed"; error: string; endTime: number },
    ) => void,
    maxWaitMs = 10 * 60 * 1000,
  ): Promise<boolean> => {
    const conversationId = deps.assistantStore.currentConversation?.id;
    if (!conversationId) return false;
    const startedAt = Date.now();

    while (!signal.aborted) {
      if (Date.now() - startedAt > maxWaitMs) {
        for (const toolId of toolIds) {
          updateToolCallInMessage(messageId, toolId, {
            status: "failed",
            error: `Approval timed out after ${Math.round(maxWaitMs / 1000)}s`,
            endTime: Date.now(),
          });
        }
        return false;
      }

      const resolution = await resolveNativeApprovalAuthority(conversationId, toolIds);
      if (resolution && resolution.unresolvedToolIds.length === 0) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    return false;
  };

  const cancelNativeAssistantRun = async (
    conversationId: string,
    reason: string,
    meta?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      const response = await assistantRunCancel({
        conversationId,
        runId: deps.nativeRunIds.get(conversationId),
        reason,
        meta,
      });
      applySnapshotForConversation(conversationId, response.snapshot);
    } catch (error) {
      console.warn("[AssistantPanel] Failed to cancel native assistant run", {
        conversationId,
        error,
      });
    }
  };

  return {
    applyNativeRuntimeCommand,
    buildNativeRuntimeDecision,
    applyNativeRuntimeDecision,
    startNativeAssistantRun,
    hydrateNativeAssistantSnapshot,
    publishNativeAssistantEvent,
    publishNativeToolPatch,
    createNativeDispatchAuthority,
    resolveNativeApprovalAuthority,
    waitForNativeToolApprovals,
    cancelNativeAssistantRun,
  };
}
