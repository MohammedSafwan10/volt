import type { AssistantMessage } from './assistant.svelte';

export function findConversationIdByMessageId(
  messageId: string,
  currentConversationId: string | null,
  activeMessages: AssistantMessage[],
  conversationRuntimeState: Record<string, { messages: AssistantMessage[] }>,
): string | null {
  if (activeMessages.some((message) => message.id === messageId)) {
    return currentConversationId;
  }

  for (const [conversationId, runtime] of Object.entries(conversationRuntimeState)) {
    if (runtime.messages.some((message) => message.id === messageId)) {
      return conversationId;
    }
  }

  return null;
}

export function stripSystemReminderTags(content: string): {
  visibleContent: string;
  hiddenReminderBlock: string;
} {
  const reminders: string[] = [];
  const visibleContent = content
    .replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/gi, (_, body: string) => {
      const trimmed = body.trim();
      if (trimmed) reminders.push(trimmed);
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    visibleContent,
    hiddenReminderBlock: reminders.join('\n\n'),
  };
}

export function sanitizeVisibleAssistantText(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<system_context>[\s\S]*?<\/system_context>/gi, '')
    .replace(/<smart_context>[\s\S]*?<\/smart_context>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
