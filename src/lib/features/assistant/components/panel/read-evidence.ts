import type { AssistantMessage } from '$features/assistant/stores/assistant.svelte';
import type { ToolLoopState } from './tool-loop-state';

function isCompletedToolCall(toolCall: { status?: string }): boolean {
  return toolCall.status === 'completed';
}

export function seedToolLoopReadEvidence(
  toolLoopState: ToolLoopState,
  messages: AssistantMessage[],
): void {
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === 'file' || attachment.type === 'selection') {
        if (attachment.path) {
          toolLoopState.markRead(attachment.path, { kind: 'read' }, message.timestamp);
        }
      }
    }

    for (const context of message.contextMentions ?? []) {
      if (context.path) {
        toolLoopState.markRead(context.path, { kind: 'read' }, message.timestamp);
      }
    }

    const toolCalls = [
      ...(message.toolCalls ?? []),
      ...(message.inlineToolCalls ?? []),
    ];
    for (const toolCall of toolCalls) {
      if (!isCompletedToolCall(toolCall)) continue;
      toolLoopState.recordToolOutcome(
        toolCall.name,
        toolCall.arguments ?? {},
        { success: true },
        toolCall.endTime ?? toolCall.startTime ?? message.timestamp,
      );
    }
  }
}
