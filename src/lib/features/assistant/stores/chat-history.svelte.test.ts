import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('./assistant-message-routing', () => ({
  sanitizeVisibleAssistantText: (content: string) => content,
}));

describe('chatHistoryStore persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'chat_create_conversation':
          if (!args) throw new Error('Missing args');
          return {
            id: args.id,
            title: 'New Chat',
            createdAt: 1,
            updatedAt: 1,
            messageCount: 0,
            firstUserMessage: null,
            isPinned: false,
            mode: args.mode,
          };
        case 'chat_save_message':
          return undefined;
        case 'chat_get_conversation':
          if (!args) throw new Error('Missing args');
          return {
            id: args.conversationId,
            title: 'New Chat',
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            mode: 'agent',
            messages: [],
          };
        default:
          return [];
      }
    });
  });

  it('does not reload the full conversation after creating or saving streamed messages', async () => {
    const { chatHistoryStore } = await import('./chat-history.svelte');

    await chatHistoryStore.createConversation('conv-1', 'agent');
    await chatHistoryStore.saveMessage('conv-1', {
      id: 'msg-1',
      role: 'assistant',
      content: 'hello',
      timestamp: 1,
      metadata: '{}',
    });
    await chatHistoryStore.saveMessage('conv-1', {
      id: 'msg-1',
      role: 'assistant',
      content: 'hello again',
      timestamp: 1,
      metadata: '{}',
    });

    expect(invokeMock).not.toHaveBeenCalledWith('chat_get_conversation', expect.anything());
    expect(chatHistoryStore.conversations[0]?.messageCount).toBe(1);
  });
});
