import type { ToolResult } from '$core/ai/tools';

type ToolCallState = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  reviewStatus?: 'pending' | 'accepted' | 'rejected';
};

type MessageState = {
  id: string;
  inlineToolCalls?: ToolCallState[];
};

type ToolResultEntry = {
  id: string;
  name: string;
  result: ToolResult;
};

type ToolCallRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export function addToolResultsToConversation(
  toolCalls: ToolCallRequest[],
  results: ToolResultEntry[],
  addToolMessage: (message: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    status: 'completed' | 'failed';
    output?: string;
    error?: string;
    meta?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }) => void,
): void {
  const resultById = new Map<string, ToolResultEntry>();
  for (const result of results) {
    resultById.set(result.id, result);
  }

  for (const toolCall of toolCalls) {
    const result = resultById.get(toolCall.id);
    if (!result) continue;

    addToolMessage({
      id: result.id,
      name: result.name,
      arguments: toolCall.arguments,
      status: result.result.success ? 'completed' : 'failed',
      output: result.result.output,
      error: result.result.error,
      meta: {
        ...(result.result.meta ?? {}),
        warnings: result.result.warnings ?? [],
      },
      data: result.result.data,
    });
  }
}

export function waitForToolApprovals(
  messageId: string,
  toolIds: string[],
  signal: AbortSignal,
  getMessages: () => MessageState[],
  updateToolCallInMessage: (
    msgId: string,
    toolId: string,
    patch: { status: 'failed'; error: string; endTime: number },
  ) => void,
  maxWaitMs = 10 * 60 * 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let finished = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      if (checkTimer) {
        clearTimeout(checkTimer);
        checkTimer = null;
      }
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };

    const onAbort = (): void => finish(false);

    const check = (): void => {
      if (finished) return;
      if (signal.aborted) {
        finish(false);
        return;
      }

      if (Date.now() - startedAt > maxWaitMs) {
        for (const toolId of toolIds) {
          updateToolCallInMessage(messageId, toolId, {
            status: 'failed',
            error: `Approval timed out after ${Math.round(maxWaitMs / 1000)}s`,
            endTime: Date.now(),
          });
        }
        finish(false);
        return;
      }

      const message = getMessages().find((entry) => entry.id === messageId);
      if (!message?.inlineToolCalls) {
        finish(false);
        return;
      }

      const allResolved = toolIds.every((toolId) => {
        const tool = message.inlineToolCalls?.find((entry) => entry.id === toolId);
        return (
          !!tool &&
          (tool.status !== 'pending' ||
            tool.reviewStatus === 'accepted' ||
            tool.reviewStatus === 'rejected')
        );
      });

      if (allResolved) {
        finish(true);
        return;
      }

      checkTimer = setTimeout(check, 120);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

export function waitForToolCompletion(
  messageId: string,
  toolId: string,
  signal: AbortSignal,
  getMessages: () => MessageState[],
  updateToolCallInMessage: (
    msgId: string,
    callId: string,
    patch: { status: 'failed'; error: string; endTime: number },
  ) => void,
  maxWaitMs = 5 * 60 * 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let finished = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      if (checkTimer) {
        clearTimeout(checkTimer);
        checkTimer = null;
      }
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };

    const onAbort = (): void => finish(false);

    const check = (): void => {
      if (finished) return;
      if (signal.aborted) {
        finish(false);
        return;
      }

      if (Date.now() - startedAt > maxWaitMs) {
        updateToolCallInMessage(messageId, toolId, {
          status: 'failed',
          error: `Execution timed out after ${Math.round(maxWaitMs / 1000)}s`,
          endTime: Date.now(),
        });
        finish(false);
        return;
      }

      const message = getMessages().find((entry) => entry.id === messageId);
      const tool = message?.inlineToolCalls?.find((entry) => entry.id === toolId);
      if (!tool || tool.status !== 'running') {
        finish(true);
        return;
      }

      checkTimer = setTimeout(check, 120);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}
