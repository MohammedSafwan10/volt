import { describe, expect, it } from 'vitest';

import {
  getStaleSourceFiles,
  hasProblemsFromSource,
} from './diagnostics-source-utils';

describe('diagnostics-source-utils', () => {
  it('detects source-owned diagnostics without affecting other sources', () => {
    expect(
      hasProblemsFromSource(
        [
          { source: 'TypeScript (build)' },
          { source: 'eslint' },
        ] as any,
        'TypeScript (build)',
      ),
    ).toBe(true);

    expect(
      hasProblemsFromSource(
        [
          { source: 'eslint' },
          { source: 'svelte' },
        ] as any,
        'TypeScript (build)',
      ),
    ).toBe(false);
  });

  it('finds stale build-source files that disappeared from the latest run', () => {
    expect(
      getStaleSourceFiles(
        ['c:/repo/src/old.ts', 'c:/repo/src/keep.ts'],
        ['c:/repo/src/keep.ts', 'c:/repo/src/new.ts'],
      ),
    ).toEqual(['c:/repo/src/old.ts']);
  });
});
