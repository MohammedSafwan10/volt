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

describe('backend diagnostics bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('maps backend diagnostics into the problems store', async () => {
    const diagnostics = await import('./diagnostics');

    diagnostics.applyBackendDiagnostics({
      serverId: 'typescript',
      source: 'typescript',
      filePath: 'C:/repo/app.ts',
      problems: [
        {
          file: 'C:/repo/app.ts',
          fileName: 'app.ts',
          line: 4,
          column: 2,
          endLine: 4,
          endColumn: 5,
          message: 'Unexpected any',
          severity: 'warning',
          code: 'no-explicit-any',
        },
      ],
    });

    expect(problemsStoreMock.setProblemsForFile).toHaveBeenCalledWith(
      'C:/repo/app.ts',
      [
        expect.objectContaining({
          id: 'typescript:C:/repo/app.ts:4:2:0',
          source: 'typescript',
          message: 'Unexpected any',
        }),
      ],
      'typescript',
    );
  });

  it('clears backend diagnostics for a file', async () => {
    const diagnostics = await import('./diagnostics');

    diagnostics.clearBackendDiagnosticsFile({
      serverId: 'yaml',
      source: 'yaml',
      filePath: 'C:/repo/pubspec.yaml',
    });

    expect(problemsStoreMock.clearProblemsForFile).toHaveBeenCalledWith(
      'C:/repo/pubspec.yaml',
      'yaml',
    );
  });

  it('marks backend source state from lifecycle events', async () => {
    const diagnostics = await import('./diagnostics');

    diagnostics.applyBackendDiagnosticsSourceState({
      serverId: 'css',
      source: 'css',
      state: 'fresh',
    });

    diagnostics.applyBackendDiagnosticsSourceState({
      serverId: 'css',
      source: 'css',
      state: 'stale',
    });

    expect(problemsStoreMock.markSourceFresh).toHaveBeenCalledWith('css');
    expect(problemsStoreMock.markSourceStale).toHaveBeenCalledWith('css');
  });
});
