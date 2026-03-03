import type { ToolCall } from '$features/assistant/stores/assistant.svelte';

type SummaryMessage = {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: ToolCall[];
};

export function formatMessageForSummary(message: SummaryMessage): string {
  if (message.role === 'system') {
    return `SYSTEM: ${message.content}`;
  }
  if (message.role === 'tool') {
    const toolLines = (message.toolCalls || []).map((toolCall) => {
      const output =
        toolCall.output ??
        (toolCall.data ? JSON.stringify(toolCall.data) : undefined) ??
        toolCall.error ??
        'No output';
      return `TOOL ${toolCall.name} (${toolCall.status}): ${output}`;
    });
    return toolLines.join('\n');
  }
  if (message.role === 'assistant') {
    return `ASSISTANT: ${message.content || ''}`.trim();
  }
  return `USER: ${message.content || ''}`.trim();
}

export function buildSummaryInput(messages: SummaryMessage[], existingSummary?: string): string {
  const transcript = messages
    .map((message) => formatMessageForSummary(message))
    .filter(Boolean)
    .join('\n');

  const summaryHeader = existingSummary
    ? `Existing summary (update it, do NOT repeat verbatim):\n${existingSummary}\n\n`
    : '';

  return (
    `${summaryHeader}Summarize the conversation segment below in a structured, factual format.\n\n` +
    `Format:\n` +
    `Goals:\n- ...\n` +
    `Key Decisions:\n- ...\n` +
    `Files Changed:\n- path - what/why\n` +
    `Open TODOs:\n- ...\n` +
    `Constraints/Preferences:\n- ...\n` +
    `Risks/Unknowns:\n- ...\n\n` +
    `Rules:\n- Use facts only. If uncertain, write "Unknown".\n` +
    `- Include file paths and tool outputs when relevant.\n` +
    `- Keep it compact and precise.\n\n` +
    `Conversation segment:\n${transcript}`
  );
}
