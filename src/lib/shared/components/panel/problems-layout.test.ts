import { afterEach, describe, expect, it, vi } from 'vitest';

import { problemsStore } from '$shared/stores/problems.svelte';

describe('ProblemsView layout guards', () => {
  afterEach(() => {
    vi.useRealTimers();
    problemsStore.clearAll();
  });

  it('reports a stable empty-state contract when no problems are visible', () => {
    problemsStore.clearAll();

    expect(problemsStore.totalCount).toBe(0);
    expect(problemsStore.totalUnfilteredCount).toBe(0);
    expect(problemsStore.searchQuery).toBe('');
  });

  it('reports filtered-empty behavior from store state instead of compiled component strings', () => {
    problemsStore.clearAll();
    problemsStore.setProblemsForFile(
      'c:/repo/src/main.ts',
      [
        {
          id: 'problem-1',
          file: 'c:/repo/src/main.ts',
          fileName: 'main.ts',
          line: 3,
          column: 5,
          endLine: 3,
          endColumn: 12,
          message: 'Type mismatch',
          severity: 'error',
          source: 'typescript',
          code: 'TS2322'
        }
      ],
      'typescript'
    );

    problemsStore.setSearchQuery('not-present');

    expect(problemsStore.totalUnfilteredCount).toBe(1);
    expect(problemsStore.totalCount).toBe(0);
    expect(problemsStore.allProblemsUnfiltered[0]).toMatchObject({
      file: 'c:/repo/src/main.ts',
      severity: 'error',
      source: 'typescript',
      code: 'TS2322'
    });
  });


  it('tracks diagnostics basis separately from freshness', () => {
    problemsStore.clearAll();
    problemsStore.setDiagnosticsBasis('staged_tool_output');
    problemsStore.markSourceStale('typescript');

    expect(problemsStore.diagnosticsBasis).toBe('staged_tool_output');
    expect(problemsStore.diagnosticsFreshness.status).toBe('stale');
  });

  it('clears pending update activity state during clearAll', () => {
    vi.useFakeTimers();

    problemsStore.setProblemsForFile(
      'c:/repo/src/main.ts',
      [
        {
          id: 'problem-1',
          file: 'c:/repo/src/main.ts',
          fileName: 'main.ts',
          line: 3,
          column: 5,
          endLine: 3,
          endColumn: 12,
          message: 'Type mismatch',
          severity: 'error',
          source: 'typescript',
          code: 'TS2322'
        }
      ],
      'typescript'
    );

    expect(problemsStore.isUpdating).toBe(true);

    problemsStore.clearAll();
    vi.runAllTimers();

    expect(problemsStore.isUpdating).toBe(false);
    expect(problemsStore.totalUnfilteredCount).toBe(0);
    expect(problemsStore.diagnosticsFreshness).toMatchObject({
      status: 'idle',
      activeSources: [],
      sourceStatuses: [],
      staleSources: [],
      isUpdating: false
    });
  });
});
