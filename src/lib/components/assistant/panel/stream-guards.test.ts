import { describe, expect, it } from 'vitest';

import { createStreamGuards } from './stream-guards';

describe('createStreamGuards', () => {
  it('flags repeated paragraph loops in a short window', () => {
    const guards = createStreamGuards();
    const paragraph =
      "Edit 1: index.html Adding the blink animation. Edit 2: game.js Applying logic fixes. I'll start with index.html.";

    let triggered = false;
    let text = '';
    for (let i = 0; i < 5; i++) {
      text += `${paragraph}\n\n`;
      if (guards.isDegenerateLineRepeat(text)) {
        triggered = true;
        break;
      }
    }

    expect(triggered).toBe(true);
  });

  it('does not flag normal progressive content', () => {
    const guards = createStreamGuards();
    const chunks = [
      'I checked the code and found a rendering bug.',
      'Root cause is stale state in the canvas resize handler.',
      'I will patch the handler and run tests next.',
      'Patch applied; now validating with unit tests.',
    ];

    let text = '';
    for (const chunk of chunks) {
      text += `${chunk}\n\n`;
      expect(guards.isDegenerateLineRepeat(text)).toBe(false);
    }
  });

  it('does not flag a single paragraph being streamed incrementally', () => {
    const guards = createStreamGuards();
    const chunks = [
      'I investigated the issue and found the root cause in the streaming guard.',
      ' The paragraph is still in progress and should not count as repeated.',
      ' I am now applying a fix so loop detection only reacts to true repetition.',
      ' After patching this, we can continue with validation and cleanup.',
    ];

    let text = '';
    for (const chunk of chunks) {
      text += chunk;
      expect(guards.isDegenerateLineRepeat(text)).toBe(false);
    }
  });
});
