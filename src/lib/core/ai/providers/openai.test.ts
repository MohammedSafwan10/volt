import { describe, expect, it } from 'vitest';

import { toOpenAIMessages } from './openai';

describe('openai provider payloads', () => {
  it('preserves text and image parts for multimodal user messages', () => {
    const messages = toOpenAIMessages([
      {
        role: 'user',
        content: 'Describe this screenshot',
        parts: [
          { type: 'text', text: 'Describe this screenshot' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'abc123base64',
          },
        ],
      } as any,
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'Describe this screenshot' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,abc123base64',
          detail: 'auto',
        },
      },
    ]);
  });

  it('keeps assistant tool-call turns as text plus tool calls', () => {
    const messages = toOpenAIMessages([
      {
        role: 'assistant',
        content: 'Checking the file now.',
        parts: [
          { type: 'text', text: 'Checking the file now.' },
          {
            type: 'function_call',
            id: 'call_1',
            name: 'read_file',
            arguments: { path: 'src/app.ts' },
          },
        ],
      } as any,
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Checking the file now.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'src/app.ts' }),
          },
        },
      ],
    });
  });
});
