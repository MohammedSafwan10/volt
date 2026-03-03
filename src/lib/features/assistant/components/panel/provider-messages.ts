import type {
  ChatMessage,
  ContentPart,
  FunctionResponsePart,
} from '$core/ai';
import type {
  AssistantMessage,
  ElementAttachment,
  ImageAttachment,
} from '$features/assistant/stores/assistant.svelte';

export function toProviderMessages(messages: AssistantMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];

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
      const hasToolCalls = msg.inlineToolCalls && msg.inlineToolCalls.length > 0;

      if (hasToolCalls) {
        const parts: ContentPart[] = [];

        if (msg.content && msg.content.trim()) {
          parts.push({ type: 'text', text: msg.content });
        }

        if (msg.inlineToolCalls) {
          for (const tc of msg.inlineToolCalls) {
            parts.push({
              type: 'function_call',
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              thoughtSignature: tc.thoughtSignature,
            });
          }
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
    const elementAttachments = attachments.filter(
      (a) => a.type === 'element',
    ) as ElementAttachment[];

    const parts: ContentPart[] = [];

    if (msg.smartContextBlock) {
      parts.push({
        type: 'text',
        text: `<system_context>\n${msg.smartContextBlock}\n</system_context>`,
      });
    }

    for (const el of elementAttachments) {
      const elementContext = `<selected_element>
Element: <${el.tagName}${el.selector ? ` selector="${el.selector}"` : ''}>
HTML:
\`\`\`html
${el.html}
\`\`\`
CSS Properties:
${Object.entries(el.css)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join('\n')}
Dimensions: ${Math.round(el.rect.width)}x${Math.round(el.rect.height)} at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)})
</selected_element>`;
      parts.push({ type: 'text', text: elementContext });
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
