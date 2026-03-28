import type { ToolResult } from '$core/ai/tools';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';
import {
  createToolRuntimeContext,
  getInitialToolLiveStatus,
} from './tool-live-updates';

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
  reviewStatus?: 'pending' | 'accepted' | 'rejected';
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
  applyNativeDecision?: (decision: unknown) => void;
  buildNativeDecision?: (params: {
    operation: string;
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
  getMessages: () => MessageState[];
  updateToolCallInMessage: (
    msgId: string,
    toolId: string,
    patch: Record<string, unknown>,
  ) => void;
  executeToolCall: (
    toolName: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; idempotencyKey: string; runtime?: ToolRuntimeContext },
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
  publishToolPatch?: (toolId: string, patch: Record<string, unknown>) => void | Promise<void>;
  getCurrentToolCallState?: (
    messageId: string,
    toolId: string,
  ) => {
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    reviewStatus?: 'pending' | 'accepted' | 'rejected';
    error?: string;
    meta?: Record<string, unknown>;
  } | undefined;
  resolveApprovalAuthority?: (
    messageId: string,
    toolIds: string[],
  ) => Promise<{
    shouldAbort: boolean;
    reason?: string;
    approvedToolIds: string[];
    deniedToolIds: string[];
    unresolvedToolIds: string[];
  } | null>;
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
    deps.applyNativeDecision?.(
      await deps.buildNativeDecision?.({
        operation: 'waiting_approval',
        payload: {
          requestedLoopState: 'waiting_approval',
          requestedLoopMeta: {
            pendingApprovals: otherTools.length,
            toolIds: otherTools.map((toolCall) => toolCall.id),
          },
        },
      }),
    );
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
    deps.applyNativeDecision?.(
      await deps.buildNativeDecision?.({
        operation: 'approval_resumed',
        payload: {
          requestedLoopState: 'running',
          requestedLoopMeta: {
            resumedAfterApproval: true,
            toolIds: otherTools.map((toolCall) => toolCall.id),
          },
        },
      }),
    );
    const approvalAuthority =
      (await deps.resolveApprovalAuthority?.(
        messageId,
        otherTools.map((toolCall) => toolCall.id),
      )) ?? null;
    if (approvalAuthority?.shouldAbort) {
      return false;
    }
    const approvedToolIds = new Set(
      approvalAuthority?.approvedToolIds ?? otherTools.map((toolCall) => toolCall.id),
    );
    const deniedToolIds = new Set(approvalAuthority?.deniedToolIds ?? []);

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

      if (currentToolCall?.status === 'cancelled' || deniedToolIds.has(toolCall.id)) {
        toolResults.push({
          id: toolCall.id,
          name: toolCall.name,
          result: { success: false, error: 'Tool execution denied by user' },
        });
        continue;
      }

      if (!approvedToolIds.has(toolCall.id)) {
        toolResults.push({
          id: toolCall.id,
          name: toolCall.name,
          result: { success: false, error: 'Tool execution denied by native runtime policy' },
        });
        deps.updateToolCallInMessage(messageId, toolCall.id, {
          status: 'failed',
          error: 'Tool execution denied by native runtime policy',
          endTime: Date.now(),
        });
        void deps.publishToolPatch?.(toolCall.id, {
          status: 'failed',
          error: 'Tool execution denied by native runtime policy',
        });
        continue;
      }

      const existingToolState = deps.getCurrentToolCallState?.(messageId, toolCall.id);
      deps.updateToolCallInMessage(messageId, toolCall.id, {
        status: 'running',
        startTime: Date.now(),
        meta: {
          ...(existingToolState?.meta ?? {}),
          liveStatus: getInitialToolLiveStatus(toolCall.name),
        },
      });
      void deps.publishToolPatch?.(toolCall.id, {
        status: 'running',
        meta: {
          ...(existingToolState?.meta ?? {}),
          liveStatus: getInitialToolLiveStatus(toolCall.name),
        },
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
          runtime: createToolRuntimeContext((patch) => {
            deps.updateToolCallInMessage(messageId, toolCall.id, patch);
            void deps.publishToolPatch?.(toolCall.id, patch);
          }),
        });
        toolResults.push({ id: toolCall.id, name: toolCall.name, result });
        deps.updateToolCallInMessage(messageId, toolCall.id, {
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
        void deps.publishToolPatch?.(toolCall.id, {
          status: result.success ? 'completed' : 'failed',
          output: result.output,
          error: result.error ?? existingToolState?.error,
          meta: {
            ...(existingToolState?.meta ?? {}),
            ...(result.meta ?? {}),
            liveStatus: undefined,
          },
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
          meta: {
            ...(existingToolState?.meta ?? {}),
            liveStatus: undefined,
          },
          endTime: Date.now(),
          streamingProgress: undefined,
        });
        void deps.publishToolPatch?.(toolCall.id, {
          status: 'failed',
          error,
          meta: {
            ...(existingToolState?.meta ?? {}),
            liveStatus: undefined,
          },
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
      void deps.publishToolPatch?.(toolCall.id, {
        status: 'failed',
        error: 'Skipped: A previous command failed.',
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
    const approvalAuthority =
      (await deps.resolveApprovalAuthority?.(messageId, [toolCall.id])) ?? null;
    if (approvalAuthority?.shouldAbort) {
      return false;
    }
    const approvedToolIds = new Set(approvalAuthority?.approvedToolIds ?? [toolCall.id]);
    const deniedToolIds = new Set(approvalAuthority?.deniedToolIds ?? []);
    deps.applyNativeDecision?.(
      await deps.buildNativeDecision?.({
        operation: 'approval_resumed',
        payload: {
          requestedLoopState: 'running',
          requestedLoopMeta: {
            resumedAfterApproval: true,
            toolIds: [toolCall.id],
          },
        },
      }),
    );

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

    if (currentToolCall?.status === 'cancelled' || deniedToolIds.has(toolCall.id)) {
      toolResults.push({
        id: toolCall.id,
        name: toolCall.name,
        result: { success: false, error: 'Tool execution denied by user' },
      });
      previousTerminalFailed = true;
      continue;
    }

    if (!approvedToolIds.has(toolCall.id)) {
      toolResults.push({
        id: toolCall.id,
        name: toolCall.name,
        result: { success: false, error: 'Tool execution denied by native runtime policy' },
      });
      deps.updateToolCallInMessage(messageId, toolCall.id, {
        status: 'failed',
        error: 'Tool execution denied by native runtime policy',
        endTime: Date.now(),
      });
      void deps.publishToolPatch?.(toolCall.id, {
        status: 'failed',
        error: 'Tool execution denied by native runtime policy',
      });
      previousTerminalFailed = true;
      continue;
    }

    const existingTerminalState = deps.getCurrentToolCallState?.(messageId, toolCall.id);
    deps.updateToolCallInMessage(messageId, toolCall.id, {
      status: 'running',
      startTime: Date.now(),
      meta: {
        ...(existingTerminalState?.meta ?? {}),
        liveStatus: getInitialToolLiveStatus(toolCall.name),
      },
    });
    void deps.publishToolPatch?.(toolCall.id, {
      status: 'running',
      meta: {
        ...(existingTerminalState?.meta ?? {}),
        liveStatus: getInitialToolLiveStatus(toolCall.name),
      },
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
        runtime: createToolRuntimeContext((patch) => {
          deps.updateToolCallInMessage(messageId, toolCall.id, patch);
          void deps.publishToolPatch?.(toolCall.id, patch);
        }),
      });
      toolResults.push({ id: toolCall.id, name: toolCall.name, result });
      deps.updateToolCallInMessage(messageId, toolCall.id, {
        status: result.success ? 'completed' : 'failed',
        output: result.output,
        error: result.error ?? existingTerminalState?.error,
        meta: {
          ...(existingTerminalState?.meta ?? {}),
          ...(result.meta ?? {}),
          liveStatus: undefined,
        },
        data: result.data,
        endTime: Date.now(),
        streamingProgress: undefined,
      });
      void deps.publishToolPatch?.(toolCall.id, {
        status: result.success ? 'completed' : 'failed',
        output: result.output,
        error: result.error ?? existingTerminalState?.error,
        meta: {
          ...(existingTerminalState?.meta ?? {}),
          ...(result.meta ?? {}),
          liveStatus: undefined,
        },
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
        meta: {
          ...(existingTerminalState?.meta ?? {}),
          liveStatus: undefined,
        },
        endTime: Date.now(),
        streamingProgress: undefined,
      });
      void deps.publishToolPatch?.(toolCall.id, {
        status: 'failed',
        error,
        meta: {
          ...(existingTerminalState?.meta ?? {}),
          liveStatus: undefined,
        },
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
