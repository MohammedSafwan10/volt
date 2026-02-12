import type { ToolResult } from '$lib/services/ai/tools';

export interface PendingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface ToolExecutionResult {
  id: string;
  name: string;
  result: ToolResult;
}

interface MessageToolState {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

interface MessageState {
  id: string;
  inlineToolCalls?: MessageToolState[];
}

interface ApprovalExecutorDeps {
  isTerminalToolName: (toolName: string) => boolean;
  getToolCapabilities: (toolName: string) => { requiresApproval: boolean };
  waitForToolApprovals: (
    messageId: string,
    toolIds: string[],
    signal: AbortSignal,
    getMessages: () => MessageState[],
    updateToolCallInMessage: (
      msgId: string,
      toolId: string,
      patch: { status: 'failed'; error: string; endTime: number },
    ) => void,
    maxWaitMs?: number,
  ) => Promise<boolean>;
  waitForToolCompletion: (
    messageId: string,
    toolId: string,
    signal: AbortSignal,
    getMessages: () => MessageState[],
    updateToolCallInMessage: (
      msgId: string,
      toolId: string,
      patch: { status: 'failed'; error: string; endTime: number },
    ) => void,
    maxWaitMs?: number,
  ) => Promise<boolean>;
  getMessages: () => MessageState[];
  updateToolCallInMessage: (
    msgId: string,
    toolId: string,
    patch: Record<string, unknown>,
  ) => void;
  executeToolCall: (
    toolName: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; idempotencyKey: string },
  ) => Promise<ToolResult>;
  getToolIdempotencyKey: (
    scope: string,
    id: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => string;
  toolRunScope: string;
  signal: AbortSignal;
  trackToolOutcome: (toolName: string, args: Record<string, unknown>, result: ToolResult) => void;
  getFailureSignature: (
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean; error?: string; output?: string },
  ) => string | null;
  onFailureSignature: (signature: string) => void;
}

export async function processToolsNeedingApproval(
  messageId: string,
  toolsNeedingApproval: PendingToolCall[],
  toolResults: ToolExecutionResult[],
  deps: ApprovalExecutorDeps,
): Promise<boolean> {
  const terminalTools = toolsNeedingApproval.filter(
    (toolCall) =>
      deps.isTerminalToolName(toolCall.name) &&
      deps.getToolCapabilities(toolCall.name).requiresApproval,
  );
  const otherTools = toolsNeedingApproval.filter(
    (toolCall) =>
      !(deps.isTerminalToolName(toolCall.name) &&
        deps.getToolCapabilities(toolCall.name).requiresApproval),
  );

  if (otherTools.length > 0) {
    const approvalsResolved = await deps.waitForToolApprovals(
      messageId,
      otherTools.map((toolCall) => toolCall.id),
      deps.signal,
      deps.getMessages,
      deps.updateToolCallInMessage as (
        msgId: string,
        toolId: string,
        patch: { status: 'failed'; error: string; endTime: number },
      ) => void,
    );
    if (deps.signal.aborted || !approvalsResolved) return false;

    for (const toolCall of otherTools) {
      let currentMessage = deps.getMessages().find((m) => m.id === messageId);
      let currentToolCall = currentMessage?.inlineToolCalls?.find(
        (entry) => entry.id === toolCall.id,
      );

      if (currentToolCall?.status === 'running') {
        const completed = await deps.waitForToolCompletion(
          messageId,
          toolCall.id,
          deps.signal,
          deps.getMessages,
          deps.updateToolCallInMessage as (
            msgId: string,
            toolId: string,
            patch: { status: 'failed'; error: string; endTime: number },
          ) => void,
        );
        if (!completed) return false;
        currentMessage = deps.getMessages().find((m) => m.id === messageId);
        currentToolCall = currentMessage?.inlineToolCalls?.find(
          (entry) => entry.id === toolCall.id,
        );
      }

      if (currentToolCall?.status === 'completed' || currentToolCall?.status === 'failed') {
        continue;
      }

      if (currentToolCall?.status === 'cancelled') {
        toolResults.push({
          id: toolCall.id,
          name: toolCall.name,
          result: { success: false, error: 'Tool execution denied by user' },
        });
        continue;
      }

      deps.updateToolCallInMessage(messageId, toolCall.id, {
        status: 'running',
        startTime: Date.now(),
      });

      try {
        const result = await deps.executeToolCall(toolCall.name, toolCall.arguments, {
          signal: deps.signal,
          idempotencyKey: deps.getToolIdempotencyKey(
            deps.toolRunScope,
            toolCall.id,
            toolCall.name,
            toolCall.arguments,
          ),
        });
        toolResults.push({ id: toolCall.id, name: toolCall.name, result });
        deps.updateToolCallInMessage(messageId, toolCall.id, {
          status: result.success ? 'completed' : 'failed',
          output: result.output,
          error: result.error,
          meta: result.meta,
          data: result.data,
          endTime: Date.now(),
          streamingProgress: undefined,
        });
        deps.trackToolOutcome(toolCall.name, toolCall.arguments, result);
        const signature = deps.getFailureSignature(toolCall.name, toolCall.arguments, result);
        if (signature) deps.onFailureSignature(signature);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        toolResults.push({
          id: toolCall.id,
          name: toolCall.name,
          result: { success: false, error },
        });
        deps.updateToolCallInMessage(messageId, toolCall.id, {
          status: 'failed',
          error,
          endTime: Date.now(),
        });
        const signature = deps.getFailureSignature(toolCall.name, toolCall.arguments, {
          success: false,
          error,
        });
        if (signature) deps.onFailureSignature(signature);
      }
    }
  }

  let previousTerminalFailed = false;
  for (const toolCall of terminalTools) {
    let currentMessage = deps.getMessages().find((m) => m.id === messageId);
    let currentToolCall = currentMessage?.inlineToolCalls?.find(
      (entry) => entry.id === toolCall.id,
    );

    if (currentToolCall?.status === 'completed' || currentToolCall?.status === 'failed') {
      continue;
    }

    if (previousTerminalFailed) {
      deps.updateToolCallInMessage(messageId, toolCall.id, {
        status: 'failed',
        error: 'Skipped: A previous command failed.',
        endTime: Date.now(),
      });
      toolResults.push({
        id: toolCall.id,
        name: toolCall.name,
        result: { success: false, error: 'Skipped: A previous command failed.' },
      });
      continue;
    }

    const approvalResolved = await deps.waitForToolApprovals(
      messageId,
      [toolCall.id],
      deps.signal,
      deps.getMessages,
      deps.updateToolCallInMessage as (
        msgId: string,
        toolId: string,
        patch: { status: 'failed'; error: string; endTime: number },
      ) => void,
    );
    if (deps.signal.aborted || !approvalResolved) return false;

    currentMessage = deps.getMessages().find((m) => m.id === messageId);
    currentToolCall = currentMessage?.inlineToolCalls?.find(
      (entry) => entry.id === toolCall.id,
    );

    if (currentToolCall?.status === 'running') {
      const completed = await deps.waitForToolCompletion(
        messageId,
        toolCall.id,
        deps.signal,
        deps.getMessages,
        deps.updateToolCallInMessage as (
          msgId: string,
          toolId: string,
          patch: { status: 'failed'; error: string; endTime: number },
        ) => void,
      );
      if (!completed) return false;
      currentMessage = deps.getMessages().find((m) => m.id === messageId);
      currentToolCall = currentMessage?.inlineToolCalls?.find(
        (entry) => entry.id === toolCall.id,
      );
    }

    if (currentToolCall?.status === 'completed' || currentToolCall?.status === 'failed') {
      continue;
    }

    if (currentToolCall?.status === 'cancelled') {
      toolResults.push({
        id: toolCall.id,
        name: toolCall.name,
        result: { success: false, error: 'Tool execution denied by user' },
      });
      previousTerminalFailed = true;
      continue;
    }

    deps.updateToolCallInMessage(messageId, toolCall.id, {
      status: 'running',
      startTime: Date.now(),
    });

    try {
      const result = await deps.executeToolCall(toolCall.name, toolCall.arguments, {
        signal: deps.signal,
        idempotencyKey: deps.getToolIdempotencyKey(
          deps.toolRunScope,
          toolCall.id,
          toolCall.name,
          toolCall.arguments,
        ),
      });
      toolResults.push({ id: toolCall.id, name: toolCall.name, result });
      deps.updateToolCallInMessage(messageId, toolCall.id, {
        status: result.success ? 'completed' : 'failed',
        output: result.output,
        error: result.error,
        meta: result.meta,
        data: result.data,
        endTime: Date.now(),
      });
      deps.trackToolOutcome(toolCall.name, toolCall.arguments, result);
      const signature = deps.getFailureSignature(toolCall.name, toolCall.arguments, result);
      if (signature) deps.onFailureSignature(signature);
      if (!result.success) previousTerminalFailed = true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      toolResults.push({
        id: toolCall.id,
        name: toolCall.name,
        result: { success: false, error },
      });
      deps.updateToolCallInMessage(messageId, toolCall.id, {
        status: 'failed',
        error,
        endTime: Date.now(),
      });
      const signature = deps.getFailureSignature(toolCall.name, toolCall.arguments, {
        success: false,
        error,
      });
      if (signature) deps.onFailureSignature(signature);
      previousTerminalFailed = true;
    }
  }

  return true;
}
