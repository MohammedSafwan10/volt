import { describe, expect, it } from 'vitest';

import { extractQueryWindow, scoreSnippetCandidate } from './context-v2-helpers';

describe('context-v2 helpers', () => {
  it('extracts focused query window with hit count', () => {
    const content = [
      'line1',
      'line2',
      'function handleLogin() {',
      '  const result = loginService(user);',
      '  return result;',
      '}',
      'line7',
    ].join('\n');

    const window = extractQueryWindow(content, 'login');
    expect(window).not.toBeNull();
    expect(window?.hitCount).toBeGreaterThan(0);
    expect(window?.content.toLowerCase()).toContain('login');
  });

  it('returns null when query has no matches', () => {
    const window = extractQueryWindow('a\nb\nc', 'not-here');
    expect(window).toBeNull();
  });

  it('scores selection higher than generic query lane', () => {
    const selection = scoreSnippetCandidate('selection', 0);
    const query = scoreSnippetCandidate('query', 0);
    expect(selection).toBeGreaterThan(query);
  });
});
