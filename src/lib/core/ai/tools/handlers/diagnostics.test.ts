import { beforeEach, describe, expect, it, vi } from 'vitest';

const diagnosticsFreshness = {
  status: 'fresh',
  activeSources: ['typescript'],
  staleSources: [],
  sourceStatuses: [],
  isUpdating: false,
  hasWarmingSources: false,
};

vi.mock('$shared/stores/problems.svelte', () => ({
  problemsStore: {
    diagnosticsFreshness,
    diagnosticsBasis: 'staged_tool_output',
    allProblemsUnfiltered: [
      {
        id: 'problem-1',
        file: 'C:/workspace/src/app.ts',
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
    ],
    filesWithProblems: ['C:/workspace/src/app.ts'],
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

vi.mock('$core/ai/tools/utils', () => ({
  truncateOutput: (output: string) => ({ text: output, truncated: false }),
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
});
