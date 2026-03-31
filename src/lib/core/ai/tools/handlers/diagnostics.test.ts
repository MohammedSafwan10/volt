import { beforeEach, describe, expect, it, vi } from 'vitest';

const diagnosticsFreshness = {
  status: 'fresh',
  activeSources: ['typescript'],
  staleSources: [],
  sourceStatuses: [],
  isUpdating: false,
  hasWarmingSources: false,
};

const fileReadMock = vi.fn();
const mockedProblems = [
  {
    id: 'problem-1',
    file: 'c:/workspace/src/app.ts',
    fileName: 'app.ts',
    line: 2,
    column: 4,
    endLine: 2,
    endColumn: 8,
    message: 'Broken',
    severity: 'error',
    source: 'typescript',
    code: 'TS1000',
  },
];

vi.mock('$shared/stores/problems.svelte', () => ({
  problemsStore: {
    diagnosticsFreshness,
    diagnosticsBasis: 'staged_tool_output',
    allProblemsUnfiltered: mockedProblems,
    filesWithProblems: ['c:/workspace/src/app.ts'],
  },
}));

vi.mock('$shared/stores/project.svelte', () => ({
  projectStore: {
    rootPath: 'C:/workspace',
  },
}));

vi.mock('$features/assistant/stores/tool-observability.svelte', () => ({
  toolObservabilityStore: {
    toolAggregates: [],
    topFailingSignatures: [],
    topSlowTools: [],
    recentSlowEvents: [],
    totalExecutions: 0,
    successRate: 1,
  },
}));

vi.mock('$core/ai/tools/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$core/ai/tools/utils')>();
  return {
    ...actual,
    truncateOutput: (output: string) => ({ text: output, truncated: false }),
  };
});

vi.mock('$core/services/file-service', () => ({
  fileService: {
    read: fileReadMock,
  },
}));

vi.mock('./diagnostics-paths', () => ({
  matchesRequestedDiagnosticPath: (problemPath: string, requestedPath: string) =>
    problemPath === requestedPath || problemPath.startsWith(`${requestedPath}/`),
}));

describe('handleGetDiagnostics', () => {
  beforeEach(() => {
    diagnosticsFreshness.status = 'fresh';
    diagnosticsFreshness.activeSources = ['typescript'];
    diagnosticsFreshness.staleSources = [];
    diagnosticsFreshness.isUpdating = false;
    mockedProblems.splice(0, mockedProblems.length, {
      id: 'problem-1',
      file: 'c:/workspace/src/app.ts',
      fileName: 'app.ts',
      line: 2,
      column: 4,
      endLine: 2,
      endColumn: 8,
      message: 'Broken',
      severity: 'error',
      source: 'typescript',
      code: 'TS1000',
    });
    fileReadMock.mockReset();
  });

  it('returns diagnostics basis metadata through the diagnostics tool', async () => {
    const runtime = { onUpdate: vi.fn() };
    const { handleGetDiagnostics } = await import('./diagnostics');

    const result = await handleGetDiagnostics({}, runtime as never);

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      diagnosticsBasis: 'staged_tool_output',
      freshness: diagnosticsFreshness,
    });
    expect(runtime.onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          diagnosticsBasis: 'staged_tool_output',
        }),
      }),
    );
  });

  it('matches requested relative paths even when diagnostic file paths use a different drive-letter case', async () => {
    const { handleGetDiagnostics } = await import('./diagnostics');

    const result = await handleGetDiagnostics({ paths: ['src/app.ts'] });

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      errorCount: 1,
      fileCount: 1,
      checkedFiles: ['src/app.ts'],
    });
    expect(result.output).toContain('1 error');
    expect(result.output).toContain('src/app.ts');
    expect(result.output).not.toContain('No issues found');
  });

  it('falls back to targeted TypeScript analysis when freshness is stale and the store is empty for the requested file', async () => {
    diagnosticsFreshness.status = 'stale';
    diagnosticsFreshness.staleSources = ['typescript'];
    mockedProblems.splice(0, mockedProblems.length);
    fileReadMock.mockResolvedValue({
      content: "export const broken: number = 'oops';\n",
    });

    const { handleGetDiagnostics } = await import('./diagnostics');

    const result = await handleGetDiagnostics({ paths: ['src/diag_bad.ts'] });

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      errorCount: 1,
      fileCount: 1,
      fallbackDiagnosticsUsed: true,
      checkedFiles: ['src/diag_bad.ts'],
    });
    expect(result.output).toContain('Local fallback analysis was used');
    expect(result.output).toContain('src/diag_bad.ts');
    expect(result.output).toContain('TS2322');
    expect(result.output).not.toContain('No issues currently reported');
  });
});
