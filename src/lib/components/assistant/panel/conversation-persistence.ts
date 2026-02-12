import type { AIMode } from '$lib/stores/ai.svelte';
import type { Conversation } from '$lib/stores/assistant.svelte';

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

export async function saveConversationToHistory(
  chatHistoryStore: ChatHistoryStoreLike,
  conversation: Conversation | null,
  mode: AIMode,
): Promise<void> {
  if (!conversation || conversation.messages.length === 0) return;

  try {
    try {
      await chatHistoryStore.createConversation(conversation.id, mode);
      chatHistoryStore.activeConversationId = conversation.id;
    } catch (createErr) {
      console.log('[AssistantPanel] Conversation may already exist:', createErr);
    }

    for (const msg of conversation.messages) {
      const metadata = JSON.stringify({
        attachments: msg.attachments,
        toolCalls: msg.toolCalls,
        inlineToolCalls: msg.inlineToolCalls,
        contentParts: msg.contentParts,
        thinking: msg.thinking,
        smartContextBlock: msg.smartContextBlock,
        contextMentions: msg.contextMentions,
        isSummary: msg.isSummary,
      });

      try {
        await chatHistoryStore.saveMessage(conversation.id, {
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          metadata,
        });
      } catch (msgErr) {
        console.log('[AssistantPanel] Message may already exist:', msgErr);
      }
    }

    console.log(
      '[AssistantPanel] Saved conversation:',
      conversation.id,
      'with',
      conversation.messages.length,
      'messages',
    );
  } catch (err) {
    console.error('[AssistantPanel] Failed to save conversation:', err);
  }
}
