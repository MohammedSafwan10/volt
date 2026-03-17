import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invokeMock,
}));

vi.mock('$core/services/file-service', () => ({
  fileService: {
    read: vi.fn(),
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

import { handleFindFiles } from './search';

describe('handleFindFiles empty backend results', () => {
  beforeEach(() => {
    mocks.invokeMock.mockReset();
  });

  it('returns a friendly empty result when backend rg returns no files', async () => {
    mocks.invokeMock.mockResolvedValue({
      files: [],
      totalFiles: 0,
      truncated: false,
      engine: 'rg',
      fallbackUsed: false,
      elapsedMs: 7,
      rgSource: 'bundled',
      rgPath: 'rg.exe',
    });

    const result = await handleFindFiles({ query: 'header.tsx' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('No files matching "header.tsx"');
  });
});
