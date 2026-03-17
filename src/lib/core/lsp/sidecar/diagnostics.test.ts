import { beforeEach, describe, expect, it, vi } from 'vitest';

const problemsStoreMock = {
  setProblemsForFile: vi.fn(),
  clearProblemsForFile: vi.fn(),
  markSourceFresh: vi.fn(),
  markSourceStale: vi.fn(),
};

vi.mock('$shared/stores/problems.svelte', () => ({
  problemsStore: problemsStoreMock,
}));

describe('diagnostics coordinator', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('ignores stale generations when setting problems', async () => {
    const diagnostics = await import('./diagnostics');

    const generation1 = diagnostics.startSourceSession('typescript');
    const generation2 = diagnostics.startSourceSession('typescript');

    expect(generation2).toBeGreaterThan(generation1);

    const accepted = diagnostics.setSourceProblemsForFile({
      source: 'typescript',
      generation: generation1,
      filePath: 'C:/repo/app.ts',
      problems: [],
    });

    expect(accepted).toBe(false);
    expect(problemsStoreMock.setProblemsForFile).not.toHaveBeenCalled();
  });

  it('accepts current generations and marks readiness', async () => {
    const diagnostics = await import('./diagnostics');

    const generation = diagnostics.startSourceSession('yaml');

    const accepted = diagnostics.setSourceProblemsForFile({
      source: 'yaml',
      generation,
      filePath: 'C:/repo/pubspec.yaml',
      problems: [
        {
          id: '1',
          file: 'C:/repo/pubspec.yaml',
          fileName: 'pubspec.yaml',
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 2,
          message: 'problem',
          severity: 'warning',
          source: 'yaml-language-server',
        },
      ],
    });

    expect(accepted).toBe(true);
    expect(problemsStoreMock.setProblemsForFile).toHaveBeenCalledWith(
      'C:/repo/pubspec.yaml',
      [
        expect.objectContaining({
          source: 'yaml',
        }),
      ],
      'yaml',
    );

    expect(diagnostics.markSourceSessionReady('yaml', generation)).toBe(true);
    expect(problemsStoreMock.markSourceFresh).toHaveBeenCalledWith('yaml');
  });
});
