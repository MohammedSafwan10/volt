import { describe, expect, it } from 'vitest';

import { ensureGeminiContents } from './gemini';

describe('gemini provider payloads', () => {
  it('adds a fallback user content block when all messages collapse away', () => {
    const contents = ensureGeminiContents([
      { role: 'system', content: 'system only' } as any,
      { role: 'user', content: '   ' } as any,
    ]);

    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts[0]?.text).toBe('Please continue.');
  });
});
