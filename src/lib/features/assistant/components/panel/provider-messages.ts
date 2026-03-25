import type {
  ChatMessage,
  ContentPart,
  FunctionResponsePart,
} from '$core/ai';
import type {
  AssistantMessage,
  ImageAttachment,
} from '$features/assistant/stores/assistant.svelte';

export function toProviderMessages(messages: AssistantMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const completedToolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'tool' || !msg.toolCalls?.length) continue;
    for (const tc of msg.toolCalls) {
      if (tc.id?.trim()) {
        completedToolResultIds.add(tc.id);
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content });
      continue;
    }

    if (msg.role === 'tool' && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        const responsePart: FunctionResponsePart = {
          type: 'function_response',
          id: tc.id,
          name: tc.name,
          response: {
            success: tc.status === 'completed',
            output:
              tc.output ??
              (tc.data ? JSON.stringify(tc.data) : undefined) ??
              tc.error ??
              'No output',
            error: tc.error ?? '',
            meta: tc.meta ?? {},
            data: tc.data,
            warnings: Array.isArray((tc.meta as any)?.warnings)
              ? (tc.meta as any).warnings
              : [],
          },
        };
        out.push({
          role: 'user',
          content: '',
          parts: [responsePart],
        });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const resolvedToolCalls =
        msg.inlineToolCalls?.filter(
          (tc) => tc.id?.trim() && completedToolResultIds.has(tc.id),
        ) ?? [];
      const hasToolCalls = resolvedToolCalls.length > 0;

      if (hasToolCalls) {
        const parts: ContentPart[] = [];

        if (msg.content && msg.content.trim()) {
          parts.push({ type: 'text', text: msg.content });
        }

        for (const tc of resolvedToolCalls) {
            parts.push({
              type: 'function_call',
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              thoughtSignature: tc.thoughtSignature,
            });
        }

        out.push({ role: 'assistant', content: msg.content, parts });
      } else {
        out.push({ role: 'assistant', content: msg.content });
      }
      continue;
    }

    if (msg.role !== 'user') continue;

    const attachments = msg.attachments ?? [];
    const imageAttachments = attachments.filter(
      (a) => a.type === 'image',
    ) as ImageAttachment[];
    const parts: ContentPart[] = [];

    if (msg.smartContextBlock) {
      parts.push({
        type: 'text',
        text: `<system_context>\n${msg.smartContextBlock}\n</system_context>`,
      });
    }

    if (msg.content && msg.content.trim()) {
      parts.push({ type: 'text', text: msg.content });
    }

    for (const img of imageAttachments) {
      parts.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    }

    if (parts.length === 1 && parts[0].type === 'text' && !msg.smartContextBlock) {
      out.push({ role: 'user', content: msg.content });
    } else if (parts.length > 0) {
      out.push({ role: 'user', content: msg.content, parts });
    }
  }

  return out;
}
