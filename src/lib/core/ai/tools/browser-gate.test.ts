import { describe, expect, it } from 'vitest';

import { isBrowserToolBlocked } from '$core/ai/tools/browser-gate';

describe('isBrowserToolBlocked', () => {
  it('blocks browser tools when browser access is disabled', () => {
    expect(isBrowserToolBlocked('browser_get_summary', false)).toBe(true);
  });

  it('does not block browser tools when browser access is enabled', () => {
    expect(isBrowserToolBlocked('browser_get_summary', true)).toBe(false);
  });

  it('never blocks non-browser tools', () => {
    expect(isBrowserToolBlocked('read_file', false)).toBe(false);
  });
});
