import { describe, expect, it } from 'vitest';

import { evaluateCompletionGate } from './completion-gate';

describe('completion gate', () => {
  it('blocks on stale diagnostics before completion', () => {
    const result = evaluateCompletionGate({
      errorCount: 0,
      freshness: { status: 'stale', staleSources: ['typescript'] },
      structuralMutationPaths: [],
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.code).toBe('COMPLETION_BLOCKED_BY_STALE_DIAGNOSTICS');
  });

  it('blocks structural mutations even without diagnostics errors', () => {
    const result = evaluateCompletionGate({
      errorCount: 0,
      freshness: { status: 'fresh' },
      structuralMutationPaths: ['src/renamed.ts'],
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.code).toBe('COMPLETION_BLOCKED_BY_STRUCTURAL_MUTATION');
  });
});
