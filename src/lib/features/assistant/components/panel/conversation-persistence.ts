import type { AIMode } from '$features/assistant/stores/ai.svelte';
import type {
  AssistantMessage,
  ContentPart,
  Conversation,
  ToolCall,
} from '$features/assistant/stores/assistant.svelte';
import { sanitizeMessageAttachments } from '$features/assistant/stores/assistant.svelte';

interface ChatHistoryStoreLike {
  activeConversationId: string | null;
  createConversation: (id: string, mode: AIMode) => Promise<unknown>;
  saveMessage: (
    conversationId: string,
    message: {
      id: string;
      role: 'user' | 'assistant' | 'tool' | 'system';
      content: string;
      timestamp: number;
      metadata: string;
    },
  ) => Promise<unknown>;
}

function sanitizeToolCalls(calls?: ToolCall[]): ToolCall[] | undefined {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments ?? {},
    status: tc.status,
    output: tc.output,
    error: tc.error,
    meta: tc.meta ? { ...tc.meta } : undefined,
    data: tc.data ? { ...tc.data } : undefined,
    startTime: tc.startTime,
    endTime: tc.endTime,
    requiresApproval: tc.requiresApproval,
    thoughtSignature: tc.thoughtSignature,
    streamingProgress: tc.streamingProgress ? { ...tc.streamingProgress } : undefined,
    reviewStatus: tc.reviewStatus,
  }));
}

function sanitizeContentParts(parts?: ContentPart[]): ContentPart[] | undefined {
  if (!parts || parts.length === 0) return undefined;
  return parts.map((part) => {
    if (part.type === 'tool') {
      const tc = part.toolCall;
      return {
        type: 'tool' as const,
        toolCall: {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments ?? {},
          status: tc.status,
          output: tc.output,
          error: tc.error,
          meta: tc.meta ? { ...tc.meta } : undefined,
          data: tc.data ? { ...tc.data } : undefined,
          startTime: tc.startTime,
          endTime: tc.endTime,
          requiresApproval: tc.requiresApproval,
          thoughtSignature: tc.thoughtSignature,
          streamingProgress: tc.streamingProgress ? { ...tc.streamingProgress } : undefined,
          reviewStatus: tc.reviewStatus,
        },
      };
    }
    return part;
  });
}

export function serializeMessageMetadata(msg: AssistantMessage): string {
  const sanitizedAttachments = sanitizeMessageAttachments(msg.attachments);
  return JSON.stringify({
    attachments: sanitizedAttachments,
    toolCalls: sanitizeToolCalls(msg.toolCalls),
    inlineToolCalls: sanitizeToolCalls(msg.inlineToolCalls),
    contentParts: sanitizeContentParts(msg.contentParts),
    thinking: msg.thinking,
    smartContextBlock: msg.smartContextBlock,
    contextMentions: msg.contextMentions,
    syntheticPrompt: msg.syntheticPrompt,
    isSummary: msg.isSummary || undefined,
    endTime: msg.endTime,
    streamState: msg.streamState,
    streamIssue: msg.streamIssue,
  });
}

export async function saveConversationToHistory(
  chatHistoryStore: ChatHistoryStoreLike,
  conversation: Conversation | null,
  mode: AIMode,
): Promise<void> {
  if (!conversation || conversation.messages.length === 0) return;

  try {
    await chatHistoryStore.createConversation(conversation.id, (conversation.mode as AIMode) || mode);
    chatHistoryStore.activeConversationId = conversation.id;

    for (const msg of conversation.messages) {
      await chatHistoryStore.saveMessage(conversation.id, {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        metadata: serializeMessageMetadata(msg),
      });
    }
  } catch (err) {
    console.error('[AssistantPanel] Failed to save conversation:', err);
    throw err;
  }
}
