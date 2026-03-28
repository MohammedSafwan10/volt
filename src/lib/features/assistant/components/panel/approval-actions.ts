import type { ToolCall } from "$features/assistant/stores/assistant.svelte";
import type { AIMode } from "$features/assistant/stores/ai.svelte";
import type { AssistantRunSnapshot } from "$features/assistant/runtime/native-runtime";

interface AssistantStoreLike {
  currentMode: AIMode;
  updateToolCallInMessage: (
    messageId: string,
    toolCallId: string,
    patch: Record<string, unknown>,
  ) => void;
  applyNativeRuntimeSnapshot: (snapshot: AssistantRunSnapshot) => void;
}

interface RunIdMapLike {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}

export async function approveToolInMessage(params: {
  assistantStore: AssistantStoreLike;
  nativeRunIds: RunIdMapLike;
  conversationId: string;
  messageId: string;
  toolCall: ToolCall;
  validateTool: (
    name: string,
    args: Record<string, unknown>,
    mode: AIMode,
  ) => { valid: boolean; error?: string };
  normalizeToolArgumentsForWorkspace: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  isTerminalToolName: (toolName: string) => boolean;
  showToast: (params: { message: string; type: "warning" | "error" | "success" }) => void;
  updateApproval: (params: {
    conversationId: string;
    runId?: string;
    messageId: string;
    toolCallId: string;
    reviewStatus: string;
    status: string;
  }) => Promise<{ snapshot?: AssistantRunSnapshot | null }>;
}): Promise<void> {
  const validation = params.validateTool(
    params.toolCall.name,
    params.toolCall.arguments,
    params.assistantStore.currentMode,
  );
  if (!validation.valid) {
    params.showToast({
      message: validation.error ?? "Tool call is not allowed",
      type: "warning",
    });
    params.assistantStore.updateToolCallInMessage(params.messageId, params.toolCall.id, {
      status: "cancelled",
      error: validation.error,
      endTime: Date.now(),
    });
    await params
      .updateApproval({
        conversationId: params.conversationId,
        runId: params.nativeRunIds.get(params.conversationId),
        messageId: params.messageId,
        toolCallId: params.toolCall.id,
        reviewStatus: "rejected",
        status: "cancelled",
      })
      .catch(() => undefined);
    return;
  }

  const approvedArguments = params.normalizeToolArgumentsForWorkspace(
    params.toolCall.name,
    params.toolCall.arguments,
  );

  params.assistantStore.updateToolCallInMessage(params.messageId, params.toolCall.id, {
    arguments: approvedArguments,
    reviewStatus: "accepted",
    meta: {
      approvedAt: Date.now(),
      liveStatus: params.isTerminalToolName(params.toolCall.name)
        ? "Queued..."
        : "Approved...",
    },
  });

  await params
    .updateApproval({
      conversationId: params.conversationId,
      runId: params.nativeRunIds.get(params.conversationId),
      messageId: params.messageId,
      toolCallId: params.toolCall.id,
      reviewStatus: "accepted",
      status: "pending",
    })
    .then((response) => {
      if (response.snapshot) {
        params.nativeRunIds.set(params.conversationId, response.snapshot.runId);
        params.assistantStore.applyNativeRuntimeSnapshot(response.snapshot);
      }
    });
}

export async function denyToolInMessage(params: {
  assistantStore: AssistantStoreLike;
  nativeRunIds: RunIdMapLike;
  conversationId: string;
  messageId: string;
  toolCall: ToolCall;
  updateApproval: (params: {
    conversationId: string;
    runId?: string;
    messageId: string;
    toolCallId: string;
    reviewStatus: string;
    status: string;
  }) => Promise<{ snapshot?: AssistantRunSnapshot | null }>;
}): Promise<void> {
  params.assistantStore.updateToolCallInMessage(params.messageId, params.toolCall.id, {
    status: "cancelled",
    reviewStatus: "rejected",
    endTime: Date.now(),
  });
  await params
    .updateApproval({
      conversationId: params.conversationId,
      runId: params.nativeRunIds.get(params.conversationId),
      messageId: params.messageId,
      toolCallId: params.toolCall.id,
      reviewStatus: "rejected",
      status: "cancelled",
    })
    .then((response) => {
      if (response.snapshot) {
        params.nativeRunIds.set(params.conversationId, response.snapshot.runId);
        params.assistantStore.applyNativeRuntimeSnapshot(response.snapshot);
      }
    });
}
