import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  fileReadMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invokeMock,
}));

vi.mock('$core/services/file-service', () => ({
  fileService: {
    read: mocks.fileReadMock,
  },
}));

vi.mock('$shared/stores/project.svelte', () => ({
  projectStore: {
    rootPath: 'C:/repo',
  },
}));


vi.mock('$core/lsp/typescript-sidecar', () => ({
  getWorkspaceSymbols: vi.fn(),
  isTsLspConnected: vi.fn(() => false),
  ensureTsLspStarted: vi.fn(),
}));

vi.mock('$core/lsp/dart-sidecar', () => ({
  getWorkspaceSymbols: vi.fn(),
  isDartLspRunning: vi.fn(() => false),
}));

import { handleFindFiles, handleWorkspaceSearch } from './search';

describe('handleWorkspaceSearch', () => {
  beforeEach(() => {
    mocks.invokeMock.mockReset();
    mocks.fileReadMock.mockReset();
  });

  it('uses literal search by default', async () => {
    mocks.invokeMock.mockResolvedValue({
      files: [],
      totalMatches: 0,
      truncated: false,
      telemetry: {
        requestedEngine: 'auto',
        engine: 'rg',
        fallbackUsed: false,
        elapsedMs: 12,
        rgSource: 'bundled',
        rgPath: 'rg.exe',
      },
    });

    await handleWorkspaceSearch({
      query: 'export const metadata = {',
      includePattern: 'src/**/*.tsx',
    });

    expect(mocks.invokeMock).toHaveBeenCalledTimes(1);
    expect(mocks.invokeMock.mock.calls[0][0]).toBe('workspace_search');
    expect(mocks.invokeMock.mock.calls[0][1]).toMatchObject({
      options: expect.objectContaining({
        query: 'export const metadata = {',
        useRegex: false,
        includePatterns: ['src/**/*.tsx'],
      }),
    });
  });

  it('retries once with caseSensitive false when strict literal search misses', async () => {
    mocks.invokeMock
      .mockResolvedValueOnce({
        files: [],
        totalMatches: 0,
        truncated: false,
        telemetry: {
          requestedEngine: 'auto',
          engine: 'rg',
          fallbackUsed: false,
          elapsedMs: 10,
          rgSource: 'bundled',
        },
      })
      .mockResolvedValueOnce({
        files: [
          {
            path: 'C:/repo/src/app/page.tsx',
            matches: [{ line: 3, lineContent: 'export const metadata = {' }],
          },
        ],
        totalMatches: 1,
        truncated: false,
        telemetry: {
          requestedEngine: 'auto',
          engine: 'rg',
          fallbackUsed: false,
          elapsedMs: 9,
          rgSource: 'bundled',
        },
      });
    mocks.fileReadMock.mockResolvedValue({
      content: ['line 1', 'line 2', 'export const metadata = {', 'line 4'].join('\n'),
    });

    const result = await handleWorkspaceSearch({
      query: 'export const metadata',
      caseSensitive: true,
      includePattern: 'src/**/*.tsx',
    });

    expect(mocks.invokeMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeMock.mock.calls[0][1]).toMatchObject({
      options: expect.objectContaining({ caseSensitive: true }),
    });
    expect(mocks.invokeMock.mock.calls[1][1]).toMatchObject({
      options: expect.objectContaining({ caseSensitive: false }),
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Retried with caseSensitive: false after an exact-scope miss');
  });

  it('does not broaden beyond includePattern when the initial search misses', async () => {
    mocks.invokeMock.mockResolvedValue({
      files: [],
      totalMatches: 0,
      truncated: false,
      telemetry: {
        requestedEngine: 'auto',
        engine: 'rg',
        fallbackUsed: false,
        elapsedMs: 10,
        rgSource: 'bundled',
      },
    });

    const result = await handleWorkspaceSearch({
      query: 'export const metadata',
      includePattern: 'src/app/**/*.mdx',
    });

    expect(mocks.invokeMock).toHaveBeenCalledTimes(1);
    expect(mocks.invokeMock.mock.calls[0][1]).toMatchObject({
      options: expect.objectContaining({ includePatterns: ['src/app/**/*.mdx'] }),
    });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('broadened search beyond includePattern');
  });

  it('returns a direct failure for find_files when backend search is unavailable', async () => {
    mocks.invokeMock.mockRejectedValueOnce(new Error('find_files_by_name not registered'));

    const result = await handleFindFiles({ query: 'router.ts' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('find_files_by_name not registered');
  });
});
