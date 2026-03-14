export function resolveConversationFallbackOnClose(params: {
  closingConversationId: string;
  openConversationIds: string[];
  historyConversationIds: string[];
}):
  | { action: 'switch_open'; conversationId: string }
  | { action: 'switch_history'; conversationId: string }
  | { action: 'create_new' } {
  const fallbackOpenId = params.openConversationIds.at(-1) ?? null;
  if (fallbackOpenId && fallbackOpenId !== params.closingConversationId) {
    return { action: 'switch_open', conversationId: fallbackOpenId };
  }

  const historyFallbackId =
    params.historyConversationIds.find((id) => id !== params.closingConversationId) ?? null;
  if (historyFallbackId) {
    return { action: 'switch_history', conversationId: historyFallbackId };
  }

  return { action: 'create_new' };
}

export function shouldCreateInitialConversation(params: {
  currentConversationId: string | null;
  storedConversationId: string | null;
  openConversationIds: string[];
}): boolean {
  if (params.currentConversationId) return false;
  if (params.storedConversationId) return false;
  if (params.openConversationIds.length > 0) return false;
  return true;
}
