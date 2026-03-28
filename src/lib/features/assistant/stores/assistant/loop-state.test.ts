import { describe, expect, it } from 'vitest';
import { isValidLoopTransition } from './loop-state';

describe('loop-state transitions', () => {
  it('allows valid transitions', () => {
    expect(isValidLoopTransition('running', 'waiting_tool')).toBe(true);
    expect(isValidLoopTransition('waiting_tool', 'completing')).toBe(true);
    expect(isValidLoopTransition('waiting_tool', 'completed')).toBe(true);
    expect(isValidLoopTransition('completing', 'completed')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(isValidLoopTransition('completed', 'completed')).toBe(false);
    expect(isValidLoopTransition('failed', 'completed')).toBe(false);
    expect(isValidLoopTransition('waiting_approval', 'completed')).toBe(false);
  });
});
