import type { ToolResult } from '$lib/services/ai/tools';

export interface QueuedNonFileTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
  runAfterFileEdits: boolean;
}

export interface QueuedFileEditTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
  queueIndex: number;
}

export interface ToolExecutionResult {
  id: string;
  name: string;
  result: ToolResult;
}

interface NonFileExecutorDeps {
  executeToolCall: (
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; idempotencyKey: string },
  ) => Promise<ToolResult>;
  signal: AbortSignal;
  toolRunScope: string;
  getToolIdempotencyKey: (
    scope: string,
    id: string,
    name: string,
    args: Record<string, unknown>,
  ) => string;
  updateToolCallInMessage: (
    messageId: string,
    toolId: string,
    patch: Record<string, unknown>,
  ) => void;
  messageId: string;
  trackToolOutcome: (toolName: string, args: Record<string, unknown>, result: ToolResult) => void;
  getFailureSignature: (
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean; error?: string; output?: string },
  ) => string | null;
  onFailureSignature: (signature: string) => void;
}

interface FileEditExecutorDeps extends NonFileExecutorDeps {
  mapWithConcurrency: <T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ) => Promise<R[]>;
}

export async function executeQueuedNonFileTools(
  toolsToRun: QueuedNonFileTool[],
  deps: NonFileExecutorDeps,
): Promise<ToolExecutionResult[]> {
  for (const queued of toolsToRun) {
    deps.updateToolCallInMessage(deps.messageId, queued.id, {
      status: 'running',
      startTime: Date.now(),
    });
  }

  const promises = toolsToRun.map((queued) =>
    deps
      .executeToolCall(queued.name, queued.args, {
        signal: deps.signal,
        idempotencyKey: deps.getToolIdempotencyKey(
          deps.toolRunScope,
          queued.id,
          queued.name,
          queued.args,
        ),
      })
      .then((result) => {
        deps.updateToolCallInMessage(deps.messageId, queued.id, {
          status: result.success ? 'completed' : 'failed',
          output: result.output,
          error: result.error,
          meta: result.meta,
          data: result.data,
          endTime: Date.now(),
        });
        deps.trackToolOutcome(queued.name, queued.args, result);
        const signature = deps.getFailureSignature(queued.name, queued.args, result);
        if (signature) deps.onFailureSignature(signature);
        return { id: queued.id, name: queued.name, result };
      })
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        deps.updateToolCallInMessage(deps.messageId, queued.id, {
          status: 'failed',
          error,
          endTime: Date.now(),
        });
        const signature = deps.getFailureSignature(queued.name, queued.args, {
          success: false,
          error,
        });
        if (signature) deps.onFailureSignature(signature);
        return {
          id: queued.id,
          name: queued.name,
          result: { success: false, error } as ToolResult,
        };
      }),
  );

  return Promise.all(promises);
}

export async function executeFileEditQueues(
  fileEditTasks: Array<[string, QueuedFileEditTool[]]>,
  concurrency: number,
  deps: FileEditExecutorDeps,
): Promise<ToolExecutionResult[]> {
  const nested = await deps.mapWithConcurrency(
    fileEditTasks,
    concurrency,
    async ([, edits]) => {
      let previousFailed = false;
      const results: ToolExecutionResult[] = [];

      for (const edit of edits) {
        if (previousFailed) {
          deps.updateToolCallInMessage(deps.messageId, edit.id, {
            status: 'failed',
            error: 'Skipped: A previous edit to this file failed.',
            endTime: Date.now(),
            meta: { editPhase: 'failed', queueIndex: edit.queueIndex },
          });
          results.push({
            id: edit.id,
            name: edit.name,
            result: {
              success: false,
              error: 'Skipped: A previous edit to this file failed.',
            } as ToolResult,
          });
          continue;
        }

        deps.updateToolCallInMessage(deps.messageId, edit.id, {
          status: 'running',
          startTime: Date.now(),
          meta: { editPhase: 'writing', queueIndex: edit.queueIndex },
        });

        try {
          const isLastEditForPath = edit.queueIndex === edits.length;
          const args = {
            ...edit.args,
            postEditDiagnostics: isLastEditForPath,
          };
          const result = await deps.executeToolCall(edit.name, args, {
            signal: deps.signal,
            idempotencyKey: deps.getToolIdempotencyKey(
              deps.toolRunScope,
              edit.id,
              edit.name,
              args,
            ),
          });

          deps.updateToolCallInMessage(deps.messageId, edit.id, {
            status: result.success ? 'completed' : 'failed',
            output: result.output,
            error: result.error,
            meta: {
              ...(result.meta || {}),
              editPhase: result.success ? 'done' : 'failed',
              queueIndex: edit.queueIndex,
            },
            data: result.data,
            endTime: Date.now(),
          });
          deps.trackToolOutcome(edit.name, edit.args, result);
          const signature = deps.getFailureSignature(edit.name, edit.args, result);
          if (signature) deps.onFailureSignature(signature);

          results.push({ id: edit.id, name: edit.name, result });
          if (!result.success) previousFailed = true;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          deps.updateToolCallInMessage(deps.messageId, edit.id, {
            status: 'failed',
            error,
            endTime: Date.now(),
            meta: { editPhase: 'failed', queueIndex: edit.queueIndex },
          });
          results.push({
            id: edit.id,
            name: edit.name,
            result: { success: false, error } as ToolResult,
          });
          const signature = deps.getFailureSignature(edit.name, edit.args, {
            success: false,
            error,
          });
          if (signature) deps.onFailureSignature(signature);
          previousFailed = true;
        }
      }

      return results;
    },
  );

  return nested.flat();
}
