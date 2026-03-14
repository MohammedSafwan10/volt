import { describe, expect, it } from 'vitest';

import {
  resolveConversationFallbackOnClose,
  shouldCreateInitialConversation,
} from './assistant-tab-flow';

describe('assistant tab flow', () => {
  it('prefers another open tab before history when closing current tab', () => {
    const result = resolveConversationFallbackOnClose({
      closingConversationId: 'a',
      openConversationIds: ['b', 'c'],
      historyConversationIds: ['d'],
    });

    expect(result).toEqual({ action: 'switch_open', conversationId: 'c' });
  });

  it('falls back to history before creating a new chat', () => {
    const result = resolveConversationFallbackOnClose({
      closingConversationId: 'a',
      openConversationIds: [],
      historyConversationIds: ['a', 'b'],
    });

    expect(result).toEqual({ action: 'switch_history', conversationId: 'b' });
  });

  it('only creates a startup conversation when nothing can be restored', () => {
    expect(
      shouldCreateInitialConversation({
        currentConversationId: null,
        storedConversationId: null,
        openConversationIds: [],
      }),
    ).toBe(true);

    expect(
      shouldCreateInitialConversation({
        currentConversationId: null,
        storedConversationId: 'saved',
        openConversationIds: [],
      }),
    ).toBe(false);
  });
});
