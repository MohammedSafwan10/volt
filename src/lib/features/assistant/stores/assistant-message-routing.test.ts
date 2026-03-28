import { describe, expect, it } from 'vitest';

import {
  findConversationIdByMessageId,
  sanitizeVisibleAssistantText,
  stripSystemReminderTags,
} from './assistant-message-routing';
import type { AssistantMessage } from './assistant.svelte';

describe('assistant message routing helpers', () => {
  it('finds owning conversation for active and background messages', () => {
    const message = { id: 'm1' } as AssistantMessage;
    const background = { id: 'm2' } as AssistantMessage;

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
        'Hi\n<system_context>secret</system_context>\n<smart_context>more</smart_context>\n<system-reminder>x</system-reminder>\n<volt-spec-verify-json>{"verdict":"pass"}</volt-spec-verify-json>\nDone',
      ),
    ).toBe('Hi\n\nDone');
  });

  it('repairs malformed fenced-code closers in finalized assistant text', () => {
    expect(
      sanitizeVisibleAssistantText(
        [
          'Before',
          '',
          '```ts',
          'const value = 1;',
          '``',
          '',
          '## After',
        ].join('\n'),
      ),
    ).toBe(
      [
        'Before',
        '',
        '```ts',
        'const value = 1;',
        '```',
        '',
        '## After',
      ].join('\n'),
    );
  });
});
