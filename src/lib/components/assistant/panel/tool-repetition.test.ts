import { describe, expect, it } from 'vitest';
import { ToolRepetitionDetector } from './tool-repetition';

describe('ToolRepetitionDetector', () => {
  it('blocks repeated signatures after threshold', () => {
    const detector = new ToolRepetitionDetector(2);
    const first = detector.recordAndShouldBlock('read_file', { path: 'a.ts' });
    const second = detector.recordAndShouldBlock('read_file', { path: 'a.ts' });
    const third = detector.recordAndShouldBlock('read_file', { path: 'a.ts' });

    expect(first.blocked).toBe(false);
    expect(second.blocked).toBe(false);
    expect(third.blocked).toBe(true);
    expect(third.count).toBe(3);
  });

  it('uses higher threshold for exempt polling tools', () => {
    const detector = new ToolRepetitionDetector(2);
    let blocked = false;
    for (let i = 0; i < 6; i++) {
      blocked = detector.recordAndShouldBlock('browser_wait_for', { selector: '#app' }).blocked;
    }
    expect(blocked).toBe(false);
    blocked = detector.recordAndShouldBlock('browser_wait_for', { selector: '#app' }).blocked;
    expect(blocked).toBe(true);
  });
});

