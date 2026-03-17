import type { ToolResult } from '$core/ai/tools';
import type { ToolCall } from '$features/assistant/stores/assistant.svelte';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';
import {
  createToolRuntimeContext,
  getInitialToolLiveStatus,
} from './tool-live-updates';

interface ExecuteToolWithUpdatesParams {
  toolCall: ToolCall;
  signal?: AbortSignal;
  idScope: string;
  executeToolCall: (
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; idempotencyKey: string; runtime?: ToolRuntimeContext },
  ) => Promise<ToolResult>;
  getToolIdempotencyKey: (
    scope: string,
    id: string,
    name: string,
    args: Record<string, unknown>,
  ) => string;
  updateToolCall: (
    toolCallId: string,
    patch: Record<string, unknown>,
  ) => void;
}

export async function executeToolWithUpdates(
  params: ExecuteToolWithUpdatesParams,
): Promise<ToolResult> {
  const {
    toolCall,
    signal,
    idScope,
    executeToolCall,
    getToolIdempotencyKey,
    updateToolCall,
  } = params;

  updateToolCall(toolCall.id, {
    status: 'running',
    startTime: Date.now(),
    meta: {
      liveStatus: getInitialToolLiveStatus(toolCall.name),
    },
  });

  try {
    const result = await executeToolCall(toolCall.name, toolCall.arguments, {
      signal,
      idempotencyKey: getToolIdempotencyKey(
        idScope,
        toolCall.id,
        toolCall.name,
        toolCall.arguments,
      ),
      runtime: createToolRuntimeContext((patch) => {
        updateToolCall(toolCall.id, patch);
      }),
    });

    updateToolCall(toolCall.id, {
      status: result.success ? 'completed' : 'failed',
      output: result.output,
      error: result.error,
      meta: {
        ...(result.meta ?? {}),
        liveStatus: undefined,
      },
      data: result.data,
      endTime: Date.now(),
      streamingProgress: undefined,
    });

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateToolCall(toolCall.id, {
      status: 'failed',
      error,
      meta: {
        liveStatus: undefined,
      },
      endTime: Date.now(),
      streamingProgress: undefined,
    });
    return { success: false, error };
  }
}
