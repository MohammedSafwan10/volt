import { describe, expect, it } from 'vitest';
import { toProviderMessages } from './provider-messages';
import type { AssistantMessage } from '$features/assistant/stores/assistant.svelte';

describe('toProviderMessages', () => {
  it('preserves non-browser attachments while omitting retired element attachments from provider context', () => {
    const messages = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Please review these',
        timestamp: Date.now(),
        attachments: [
          {
            id: 'selection-1',
            type: 'selection',
            label: 'src/lib/foo.ts:1-3',
            path: 'src/lib/foo.ts',
            startLine: 1,
            endLine: 3,
            content: 'const a = 1;',
          },
          {
            id: 'legacy-element-1',
            type: 'element',
            label: '<button.primary>',
            tagName: 'button',
            selector: 'button.primary',
            html: '<button class=\"primary\">Run</button>',
            css: { color: 'red' },
            rect: { x: 10, y: 10, width: 50, height: 20 },
          },
        ],
      } as unknown as AssistantMessage,
    ];

    const providerMessages = toProviderMessages(messages);

    expect(providerMessages).toHaveLength(1);
    expect(providerMessages[0]).toMatchObject({
      role: 'user',
      content: 'Please review these',
    });
    const parts = providerMessages[0]?.parts ?? [];
    expect(parts.some((part) => part.type === 'text' && part.text.includes('<selected_element>'))).toBe(false);
  });
});
