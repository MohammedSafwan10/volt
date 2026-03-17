import { describe, expect, it } from 'vitest';

import {
  findConversationIdByMessageId,
  sanitizeVisibleAssistantText,
  stripSystemReminderTags,
} from './assistant-message-routing';

describe('assistant message routing helpers', () => {
  it('finds owning conversation for active and background messages', () => {
    const message = { id: 'm1' } as any;
    const background = { id: 'm2' } as any;

    expect(
      findConversationIdByMessageId('m1', 'active', [message], {
        other: { messages: [background] },
      }),
    ).toBe('active');

    expect(
      findConversationIdByMessageId('m2', 'active', [message], {
        other: { messages: [background] },
      }),
    ).toBe('other');
  });

  it('strips system reminders from visible content while preserving hidden block', () => {
    const result = stripSystemReminderTags(
      'Hello\n<system-reminder>\nSecret mode switch\n</system-reminder>\nWorld',
    );

    expect(result.visibleContent).toBe('Hello\n\nWorld');
    expect(result.hiddenReminderBlock).toBe('Secret mode switch');
  });

  it('sanitizes internal assistant control blocks from visible text', () => {
    expect(
      sanitizeVisibleAssistantText(
        'Hi\n<system_context>secret</system_context>\n<smart_context>more</smart_context>\n<system-reminder>x</system-reminder>\nDone',
      ),
    ).toBe('Hi\n\nDone');
  });
});
