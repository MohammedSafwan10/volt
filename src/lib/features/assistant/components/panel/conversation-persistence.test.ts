import { describe, expect, it, vi } from 'vitest';

import { saveConversationToHistory, serializeMessageMetadata } from './conversation-persistence';
import type { Conversation } from '$features/assistant/stores/assistant.svelte';

describe('conversation-persistence', () => {
  it('serializes full persistence metadata consistently', () => {
    const metadata = JSON.parse(serializeMessageMetadata({
      id: 'm1',
      role: 'assistant',
      content: 'hello',
      timestamp: 123,
      attachments: [{ id: 'a1', type: 'folder', label: 'src', path: 'src' }],
      toolCalls: [{
        id: 'tc1',
        name: 'run_command',
        arguments: { command: 'npm test' },
        status: 'completed',
        output: 'ok',
        meta: { exitCode: 0 },
        data: { sample: true },
        startTime: 1,
        endTime: 2,
        requiresApproval: true,
        thoughtSignature: 'sig',
        streamingProgress: { charsWritten: 1, totalChars: 2, linesWritten: 1, totalLines: 1, percent: 50 },
        reviewStatus: 'accepted',
      }],
      inlineToolCalls: [{
        id: 'tc2',
        name: 'read_file',
        arguments: { path: 'src/main.ts' },
        status: 'completed',
      }],
      contentParts: [
        { type: 'text', text: 'hello' },
        {
          type: 'tool',
          toolCall: {
            id: 'tc3',
            name: 'workspace_search',
            arguments: { query: 'foo' },
            status: 'completed',
          },
        },
      ],
      thinking: 'thinking',
      smartContextBlock: 'ctx',
      contextMentions: [],
      isSummary: true,
      endTime: 999,
      streamState: 'completed',
      streamIssue: 'none',
    } as unknown as import('$features/assistant/stores/assistant.svelte').AssistantMessage));

    expect(metadata.isSummary).toBe(true);
    expect(metadata.endTime).toBe(999);
    expect(metadata.streamState).toBe('completed');
    expect(metadata.toolCalls[0].meta).toEqual({ exitCode: 0 });
    expect(metadata.contentParts[1].toolCall.name).toBe('workspace_search');
  });

  it('uses the conversation mode and saves every message', async () => {
    const createConversation = vi.fn(async () => ({}));
    const saveMessage = vi.fn(async () => ({}));
    const store = {
      activeConversationId: null,
      createConversation,
      saveMessage,
    };

    const conversation: Conversation = {
      id: 'conv-1',
      createdAt: 1,
      mode: 'plan',
      messages: [
        { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'world', timestamp: 2, streamState: 'completed' },
      ],
    };

    await saveConversationToHistory(store, conversation, 'agent');

    expect(createConversation).toHaveBeenCalledWith('conv-1', 'plan');
    expect(saveMessage).toHaveBeenCalledTimes(2);
    expect(store.activeConversationId).toBe('conv-1');
  });

  it('throws when conversation creation fails', async () => {
    const store = {
      activeConversationId: null,
      createConversation: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
      saveMessage: vi.fn(async () => ({})),
    };

    await expect(saveConversationToHistory(store, {
      id: 'conv-1',
      createdAt: 1,
      mode: 'agent',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
    }, 'agent')).rejects.toThrow('db unavailable');

    expect(store.saveMessage).not.toHaveBeenCalled();
  });
});
