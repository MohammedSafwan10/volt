import type { ToolResult } from '$core/ai/tools';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';
import {
  createToolRuntimeContext,
  getInitialToolLiveStatus,
} from './tool-live-updates';

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

function isRetryableEditTool(name: string): boolean {
  return (
    name === 'str_replace' ||
    name === 'multi_replace' ||
    name === 'replace_lines' ||
    name === 'apply_patch'
  );
}

function isRetryableEditFailure(errorText: string): boolean {
  const message = errorText.toLowerCase();
  return (
    message.includes('no match') ||
    message.includes('content changed on disk') ||
    message.includes('version conflict') ||
    message.includes('patch apply failed')
  );
}

interface NonFileExecutorDeps {
  executeToolCall: (
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; idempotencyKey: string; runtime?: ToolRuntimeContext },
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
  publishToolPatch?: (toolId: string, patch: Record<string, unknown>) => void | Promise<void>;
  getCurrentToolCallState?: (
    messageId: string,
    toolId: string,
  ) => { status?: string; error?: string; meta?: Record<string, unknown> } | undefined;
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
    const existingToolState = deps.getCurrentToolCallState?.(deps.messageId, queued.id);
    if (
      existingToolState?.status === 'failed' ||
      existingToolState?.status === 'completed' ||
      existingToolState?.status === 'cancelled'
    ) {
      continue;
    }
    deps.updateToolCallInMessage(deps.messageId, queued.id, {
      status: 'running',
      startTime: Date.now(),
      meta: {
        ...(existingToolState?.meta ?? {}),
        liveStatus: getInitialToolLiveStatus(queued.name),
      },
    });
    void deps.publishToolPatch?.(queued.id, {
      status: 'running',
      meta: {
        ...(existingToolState?.meta ?? {}),
        liveStatus: getInitialToolLiveStatus(queued.name),
      },
    });
  }

  const promises = toolsToRun.map((queued) =>
    {
      const existingToolState = deps.getCurrentToolCallState?.(deps.messageId, queued.id);
      if (
        existingToolState?.status === 'failed' ||
        existingToolState?.status === 'completed' ||
        existingToolState?.status === 'cancelled'
      ) {
        return Promise.resolve({
          id: queued.id,
          name: queued.name,
          result: {
            success: existingToolState.status === 'completed',
            error:
              existingToolState.status === 'failed'
                ? existingToolState.error
                : existingToolState.status === 'cancelled'
                  ? 'Tool execution cancelled'
                  : undefined,
          } as ToolResult,
        });
      }

      return deps
      .executeToolCall(queued.name, queued.args, {
        signal: deps.signal,
        idempotencyKey: deps.getToolIdempotencyKey(
          deps.toolRunScope,
          queued.id,
          queued.name,
          queued.args,
        ),
        runtime: createToolRuntimeContext((patch) => {
          deps.updateToolCallInMessage(deps.messageId, queued.id, patch);
          void deps.publishToolPatch?.(queued.id, patch);
        }),
      })
      .then((result) => {
        if (!result.success) {
          console.warn('[AssistantLoop] tool failed (non-file)', {
            toolId: queued.id,
            tool: queued.name,
            error: result.error,
            meta: result.meta,
          });
        }
        deps.updateToolCallInMessage(deps.messageId, queued.id, {
          status: result.success ? 'completed' : 'failed',
          output: result.output,
          error: result.error ?? existingToolState?.error,
          meta: {
            ...(existingToolState?.meta ?? {}),
            ...(result.meta ?? {}),
            liveStatus: undefined,
          },
          data: result.data,
          endTime: Date.now(),
          streamingProgress: undefined,
        });
        void deps.publishToolPatch?.(queued.id, {
          status: result.success ? 'completed' : 'failed',
          output: result.output,
          error: result.error ?? existingToolState?.error,
          meta: {
            ...(existingToolState?.meta ?? {}),
            ...(result.meta ?? {}),
            liveStatus: undefined,
          },
        });
        deps.trackToolOutcome(queued.name, queued.args, result);
        const signature = deps.getFailureSignature(queued.name, queued.args, result);
        if (signature) deps.onFailureSignature(signature);
        return { id: queued.id, name: queued.name, result };
      })
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        console.error('[AssistantLoop] tool crashed (non-file)', {
          toolId: queued.id,
          tool: queued.name,
          error,
        });
        deps.updateToolCallInMessage(deps.messageId, queued.id, {
          status: 'failed',
          error,
          meta: {
            ...(existingToolState?.meta ?? {}),
            liveStatus: undefined,
          },
          endTime: Date.now(),
          streamingProgress: undefined,
        });
        void deps.publishToolPatch?.(queued.id, {
          status: 'failed',
          error,
          meta: {
            ...(existingToolState?.meta ?? {}),
            liveStatus: undefined,
          },
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
      });
    },
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
          void deps.publishToolPatch?.(edit.id, {
            status: 'failed',
            error: 'Skipped: A previous edit to this file failed.',
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
          meta: {
            editPhase: 'writing',
            queueIndex: edit.queueIndex,
            liveStatus: getInitialToolLiveStatus(edit.name),
          },
        });
        void deps.publishToolPatch?.(edit.id, {
          status: 'running',
          meta: {
            editPhase: 'writing',
            queueIndex: edit.queueIndex,
            liveStatus: getInitialToolLiveStatus(edit.name),
          },
        });

        try {
          const args: Record<string, unknown> = {
            ...edit.args,
            postEditDiagnostics: false,
          };
          let result = await deps.executeToolCall(edit.name, args, {
            signal: deps.signal,
            idempotencyKey: deps.getToolIdempotencyKey(
              deps.toolRunScope,
              edit.id,
              edit.name,
              args,
            ),
            runtime: createToolRuntimeContext((patch) => {
              deps.updateToolCallInMessage(deps.messageId, edit.id, patch);
              void deps.publishToolPatch?.(edit.id, patch);
            }),
          });
          let retried = false;
          if (
            !result.success &&
            isRetryableEditTool(edit.name) &&
            isRetryableEditFailure(String(result.error ?? result.output ?? ''))
          ) {
            retried = true;
            const retryArgs: Record<string, unknown> = {
              ...args,
              auto_retry_once: true,
            };
            const retryResult = await deps.executeToolCall(edit.name, retryArgs, {
              signal: deps.signal,
              idempotencyKey: deps.getToolIdempotencyKey(
                deps.toolRunScope,
                `${edit.id}:retry1`,
                edit.name,
                retryArgs,
              ),
              runtime: createToolRuntimeContext((patch) => {
                deps.updateToolCallInMessage(deps.messageId, edit.id, patch);
                void deps.publishToolPatch?.(edit.id, patch);
              }),
            });
            if (!retryResult.success) {
              retryResult.error = `${retryResult.error ?? 'Retry exhausted'}\n\nRetry exhausted after one automatic re-read/retry attempt.`;
              retryResult.meta = {
                ...(retryResult.meta ?? {}),
                code: 'EDIT_RETRY_EXHAUSTED',
              };
            } else {
              retryResult.meta = {
                ...(retryResult.meta ?? {}),
                autoRetrySucceeded: true,
              };
            }
            result = retryResult;
            console.warn('[AssistantLoop] edit auto-retry', {
              toolId: edit.id,
              tool: edit.name,
              retrySucceeded: retryResult.success,
              error: retryResult.error,
            });
          }

          if (!result.success) {
            console.warn('[AssistantLoop] tool failed (file-edit)', {
              toolId: edit.id,
              tool: edit.name,
              error: result.error,
              meta: result.meta,
            });
          }

          deps.updateToolCallInMessage(deps.messageId, edit.id, {
            status: result.success ? 'completed' : 'failed',
            output: result.output,
            error: result.error,
            meta: {
              ...(result.meta || {}),
              editPhase: result.success ? 'done' : 'failed',
              queueIndex: edit.queueIndex,
              autoRetried: retried,
              liveStatus: undefined,
            },
            data: result.data,
            endTime: Date.now(),
            streamingProgress: undefined,
          });
          void deps.publishToolPatch?.(edit.id, {
            status: result.success ? 'completed' : 'failed',
            output: result.output,
            error: result.error,
            meta: {
              ...(result.meta || {}),
              editPhase: result.success ? 'done' : 'failed',
              queueIndex: edit.queueIndex,
              autoRetried: retried,
              liveStatus: undefined,
            },
          });
          deps.trackToolOutcome(edit.name, edit.args, result);
          const signature = deps.getFailureSignature(edit.name, edit.args, result);
          if (signature) deps.onFailureSignature(signature);

          results.push({ id: edit.id, name: edit.name, result });
          if (!result.success) previousFailed = true;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error('[AssistantLoop] tool crashed (file-edit)', {
            toolId: edit.id,
            tool: edit.name,
            error,
          });
          deps.updateToolCallInMessage(deps.messageId, edit.id, {
            status: 'failed',
            error,
            endTime: Date.now(),
            meta: { editPhase: 'failed', queueIndex: edit.queueIndex, liveStatus: undefined },
            streamingProgress: undefined,
          });
          void deps.publishToolPatch?.(edit.id, {
            status: 'failed',
            error,
            meta: { editPhase: 'failed', queueIndex: edit.queueIndex, liveStatus: undefined },
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
