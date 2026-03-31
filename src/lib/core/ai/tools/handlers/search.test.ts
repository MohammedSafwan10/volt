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

  it('keeps strict case-sensitive searches strict when the initial search misses', async () => {
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
      caseSensitive: true,
      includePattern: 'src/**/*.tsx',
    });

    expect(mocks.invokeMock).toHaveBeenCalledTimes(1);
    expect(mocks.invokeMock.mock.calls[0][1]).toMatchObject({
      options: expect.objectContaining({ caseSensitive: true }),
    });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('Retried with caseSensitive: false');
  });

  it('normalizes backslash include patterns before invoking backend search', async () => {
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

    await handleWorkspaceSearch({
      query: 'Nested content',
      includePattern: 'volt_audit_tmp\\subdir\\**',
    });

    expect(mocks.invokeMock).toHaveBeenCalledWith(
      'workspace_search',
      expect.objectContaining({
        options: expect.objectContaining({
          includePatterns: ['volt_audit_tmp/subdir/**'],
        }),
      }),
    );
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

  it('adds a find_files hint when a filename-like workspace search misses', async () => {
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
        files: ['app/not-found.tsx'],
        engine: 'rg',
        fallbackUsed: false,
        elapsedMs: 6,
      });

    const result = await handleWorkspaceSearch({
      query: 'not-found.tsx',
      includePattern: 'app/**/*',
    });

    expect(mocks.invokeMock).toHaveBeenCalledTimes(2);
    expect(mocks.invokeMock.mock.calls[1][0]).toBe('find_files_by_name');
    expect(result.success).toBe(true);
    expect(result.output).toContain('Hint: This query looks like a filename/path.');
    expect(result.output).toContain('Possible file/path matches:');
    expect(result.output).toContain('app/not-found.tsx');
  });

  it('filters hidden workspace_search results when includeHidden is false', async () => {
    mocks.invokeMock.mockResolvedValue({
      files: [
        {
          path: 'C:/repo/tool_audit_tmp/.hidden-note.txt',
          matches: [{ line: 1, lineContent: 'secret-alpha' }],
        },
        {
          path: 'C:/repo/tool_audit_tmp/visible.txt',
          matches: [{ line: 1, lineContent: 'secret-alpha' }],
        },
      ],
      totalMatches: 2,
      truncated: false,
      telemetry: {
        requestedEngine: 'auto',
        engine: 'rg',
        fallbackUsed: false,
        elapsedMs: 11,
        rgSource: 'bundled',
      },
    });
    mocks.fileReadMock.mockResolvedValue({ content: 'secret-alpha\n' });

    const result = await handleWorkspaceSearch({
      query: 'secret-alpha',
      includeHidden: false,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('visible.txt');
    expect(result.output).not.toContain('.hidden-note.txt');
  });

  it('falls back to legacy workspace search when includeHidden is true and the primary search misses', async () => {
    mocks.invokeMock
      .mockResolvedValueOnce({
        files: [],
        totalMatches: 0,
        truncated: false,
        telemetry: {
          requestedEngine: 'auto',
          engine: 'rg',
          fallbackUsed: false,
          elapsedMs: 11,
          rgSource: 'bundled',
        },
      })
      .mockResolvedValueOnce({
        files: [
          {
            path: 'C:/repo/tool_audit_tmp/.hidden-note.txt',
            matches: [{ line: 1, lineContent: 'secret-alpha' }],
          },
        ],
        totalMatches: 1,
        truncated: false,
        telemetry: {
          requestedEngine: 'legacy',
          engine: 'legacy',
          fallbackUsed: true,
          fallbackReason: 'includeHidden legacy fallback',
          elapsedMs: 16,
          rgSource: 'none',
        },
      });
    mocks.fileReadMock.mockResolvedValue({ content: 'secret-alpha\n' });

    const result = await handleWorkspaceSearch({
      query: 'secret-alpha',
      includeHidden: true,
    });

    expect(mocks.invokeMock).toHaveBeenNthCalledWith(
      2,
      'workspace_search',
      expect.objectContaining({
        options: expect.objectContaining({
          includeHidden: true,
          engine: 'legacy',
        }),
      }),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('.hidden-note.txt');
  });

  it('returns a direct failure for find_files when backend search is unavailable', async () => {
    mocks.invokeMock.mockRejectedValueOnce(new Error('find_files_by_name not registered'));

    const result = await handleFindFiles({ query: 'router.ts' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('find_files_by_name not registered');
  });

  it('filters hidden find_files results when includeHidden is false', async () => {
    mocks.invokeMock.mockResolvedValue({
      files: ['tool_audit_tmp/.hidden-note.txt', 'tool_audit_tmp/visible.txt'],
      totalFiles: 2,
      truncated: false,
      engine: 'rg',
      fallbackUsed: false,
      elapsedMs: 8,
      rgSource: 'bundled',
    });

    const result = await handleFindFiles({ query: 'note', includeHidden: false });

    expect(result.success).toBe(true);
    expect(result.output).toContain('tool_audit_tmp/visible.txt');
    expect(result.output).not.toContain('.hidden-note.txt');
  });

  it('falls back to legacy file discovery when includeHidden is true and the primary search misses', async () => {
    mocks.invokeMock
      .mockResolvedValueOnce({
        files: [],
        totalFiles: 0,
        truncated: false,
        engine: 'rg',
        fallbackUsed: false,
        elapsedMs: 8,
        rgSource: 'bundled',
      })
      .mockResolvedValueOnce({
        files: ['tool_audit_tmp/.hidden-note.txt'],
        totalFiles: 1,
        truncated: false,
        engine: 'legacy',
        fallbackUsed: true,
        fallbackReason: 'includeHidden legacy fallback',
        elapsedMs: 9,
        rgSource: 'none',
      });

    const result = await handleFindFiles({ query: 'hidden-note', includeHidden: true });

    expect(mocks.invokeMock).toHaveBeenNthCalledWith(
      2,
      'find_files_by_name',
      expect.objectContaining({
        options: expect.objectContaining({
          includeHidden: true,
          engine: 'legacy',
        }),
      }),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('tool_audit_tmp/.hidden-note.txt');
  });
});
