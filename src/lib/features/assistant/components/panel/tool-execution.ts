import type { ToolResult } from '$core/ai/tools';
import type { ToolCall } from '$features/assistant/stores/assistant.svelte';

interface ExecuteToolWithUpdatesParams {
  toolCall: ToolCall;
  signal?: AbortSignal;
  idScope: string;
  executeToolCall: (
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; idempotencyKey: string },
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
    });

    updateToolCall(toolCall.id, {
      status: result.success ? 'completed' : 'failed',
      output: result.output,
      error: result.error,
      meta: result.meta,
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
      endTime: Date.now(),
      streamingProgress: undefined,
    });
    return { success: false, error };
  }
}
