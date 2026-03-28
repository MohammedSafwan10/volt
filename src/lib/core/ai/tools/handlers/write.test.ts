import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  readFileDocumentFreshMock: vi.fn(),
  writeMock: vi.fn(),
  runMock: vi.fn(),
  refreshTreeMock: vi.fn(),
  openFileMock: vi.fn(),
  setActiveFileMock: vi.fn(),
  updateContentMock: vi.fn(),
  markSavedMock: vi.fn(),
  closeFileMock: vi.fn(),
  syncEditorMock: vi.fn(),
  diagnosticsMock: vi.fn(),
  changedLinesMock: vi.fn(),
  diffStatsMock: vi.fn(),
  findBestMatchMock: vi.fn(),
  validateSyntaxMock: vi.fn(),
  parseCodexPatchMock: vi.fn(),
  applyCodexPatchMock: vi.fn(),
  getCodexPatchLineStatsMock: vi.fn(),
  syncContentMutationProjectionMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invokeMock,
}));

vi.mock('$shared/stores/project.svelte', () => ({
  projectStore: {
    rootPath: 'C:/tauri/volt',
    refreshTree: mocks.refreshTreeMock,
    removeNode: vi.fn(),
  },
}));

vi.mock('$features/editor/stores/editor.svelte', () => ({
  editorStore: {
    openFiles: [],
    activeFile: null,
    openFile: mocks.openFileMock,
    setActiveFile: mocks.setActiveFileMock,
    updateContent: mocks.updateContentMock,
    markSaved: mocks.markSavedMock,
    closeFile: mocks.closeFileMock,
  },
}));

vi.mock('$core/services/file-service', () => ({
  fileService: {
    read: mocks.readFileDocumentFreshMock,
    write: mocks.writeMock,
  },
}));

vi.mock('$core/services/monaco-models', () => ({
  revealLine: vi.fn(),
  setModelValue: vi.fn(),
  setReviewHighlight: vi.fn(),
}));

vi.mock('$core/lsp/typescript-sidecar', () => ({
  notifyDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/eslint-sidecar', () => ({
  notifyEslintDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/svelte-sidecar', () => ({
  notifySvelteDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/html-sidecar', () => ({
  notifyHtmlDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/css-sidecar', () => ({
  notifyCssDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/json-sidecar', () => ({
  notifyJsonDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/dart-sidecar', () => ({
  isDartLspRunning: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/yaml-sidecar', () => ({
  isYamlLspRunning: vi.fn(() => false),
  notifyYamlDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/xml-sidecar', () => ({
  isXmlLspRunning: vi.fn(() => false),
  notifyXmlDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/tailwind-sidecar', () => ({
  isTailwindLspConnected: vi.fn(() => false),
  notifyTailwindDocumentChanged: vi.fn(),
}));

vi.mock('$core/ai/tools/handlers/diagnostics', () => ({
  handleGetDiagnostics: mocks.diagnosticsMock,
}));

vi.mock('$core/ai/tools/handlers/write-utils', () => ({
  calculateChangedLines: mocks.changedLinesMock,
  findBestMatch: mocks.findBestMatchMock,
  fixEscapedNewlines: (value: string) => value,
  validateSyntax: mocks.validateSyntaxMock,
}));

vi.mock('$core/ai/tools/handlers/write-patch', () => ({
  applyCodexPatch: mocks.applyCodexPatchMock,
  getCodexPatchLineStats: mocks.getCodexPatchLineStatsMock,
  parseCodexPatch: mocks.parseCodexPatchMock,
}));

vi.mock('$core/ai/tools/utils', async () => {
  const actual = await vi.importActual<typeof import('$core/ai/tools/utils')>('$core/ai/tools/utils');
  return {
    ...actual,
    calculateDiffStats: mocks.diffStatsMock,
  };
});

vi.mock('$core/services/workspace-mutation-coordinator', () => ({
  createWorkspaceMutationCoordinator: () => ({
    run: mocks.runMock,
  }),
  workspaceMutationCoordinator: {
    run: mocks.runMock,
  },
}));

vi.mock('./write', async () => {
  const actual = await vi.importActual<typeof import('./write')>('./write');
  return {
    ...actual,
    syncContentMutationProjection: mocks.syncContentMutationProjectionMock,
  };
});

import {
  handleAppendFile,
  handleApplyPatch,
  handleCreateDir,
  handleDeleteFile,
  handleMultiReplace,
  handleReplaceLines,
  handleRenamePath,
  handleStrReplace,
  handleWriteFile,
} from './write';

describe('write tool handlers', () => {
  beforeEach(() => {
    mocks.invokeMock.mockReset();
    mocks.readFileDocumentFreshMock.mockReset();
    mocks.writeMock.mockReset();
    mocks.runMock.mockReset();
    mocks.refreshTreeMock.mockReset();
    mocks.openFileMock.mockReset();
    mocks.setActiveFileMock.mockReset();
    mocks.updateContentMock.mockReset();
    mocks.markSavedMock.mockReset();
    mocks.closeFileMock.mockReset();
    mocks.diagnosticsMock.mockReset();
    mocks.changedLinesMock.mockReset();
    mocks.diffStatsMock.mockReset();
    mocks.findBestMatchMock.mockReset();
    mocks.validateSyntaxMock.mockReset();
    mocks.parseCodexPatchMock.mockReset();
    mocks.applyCodexPatchMock.mockReset();
    mocks.getCodexPatchLineStatsMock.mockReset();
    mocks.syncContentMutationProjectionMock.mockReset();

    mocks.changedLinesMock.mockReturnValue({ firstChangedLine: 1, lastChangedLine: 1 });
    mocks.diffStatsMock.mockReturnValue({ added: 1, removed: 1 });
    mocks.validateSyntaxMock.mockReturnValue(null);
    mocks.diagnosticsMock.mockResolvedValue({
      success: true,
      meta: { errorCount: 0, warningCount: 0, fileCount: 0, problems: [] },
    });
  });

  it('routes handleWriteFile through the workspace mutation coordinator', async () => {
    mocks.readFileDocumentFreshMock.mockResolvedValue(null);
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        path: 'C:/tauri/volt/src/app.ts',
        committedContent: 'after',
        stagedContent: 'after',
      },
    });

    const result = await handleWriteFile({ path: 'src/app.ts', content: 'after' });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'write',
      path: 'C:/tauri/volt/src/app.ts',
      content: 'after',
      createIfMissing: true,
      relativePath: 'src/app.ts',
      sync: {
        normalizedPath: 'C:/tauri/volt/src/app.ts',
        firstChangedLine: undefined,
        lastChangedLine: undefined,
      },
    });
    expect(result.success).toBe(true);
  });

  it('routes handleAppendFile through the workspace mutation coordinator', async () => {
    mocks.readFileDocumentFreshMock.mockResolvedValue({
      path: 'C:/tauri/volt/src/app.ts',
      content: 'before',
      version: 2,
      diskVersion: 2,
      isDirty: false,
      lastModified: 1,
    });
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        committedContent: 'before\nextra',
        stagedContent: 'before\nextra',
      },
    });

    const result = await handleAppendFile({ path: 'src/app.ts', content: 'extra' });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'write',
      path: 'C:/tauri/volt/src/app.ts',
      content: 'before\nextra',
      createIfMissing: false,
      relativePath: 'src/app.ts',
      sync: {
        normalizedPath: 'C:/tauri/volt/src/app.ts',
        firstChangedLine: 1,
        lastChangedLine: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it('routes handleStrReplace through the workspace mutation coordinator', async () => {
    mocks.readFileDocumentFreshMock.mockResolvedValue({
      path: 'C:/tauri/volt/src/app.ts',
      content: 'before target after',
      version: 3,
      diskVersion: 3,
      isDirty: false,
      lastModified: 1,
    });
    mocks.findBestMatchMock.mockReturnValue({ index: 7, length: 6, similarity: 1 });
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        committedContent: 'before result after',
        stagedContent: 'before result after',
      },
    });

    const result = await handleStrReplace({
      path: 'src/app.ts',
      oldStr: 'target',
      newStr: 'result',
    });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'write',
      path: 'C:/tauri/volt/src/app.ts',
      content: 'before result after',
      createIfMissing: false,
      relativePath: 'src/app.ts',
      sync: {
        normalizedPath: 'C:/tauri/volt/src/app.ts',
        firstChangedLine: 1,
        lastChangedLine: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it('routes handleMultiReplace through the workspace mutation coordinator', async () => {
    mocks.readFileDocumentFreshMock.mockResolvedValue({
      path: 'C:/tauri/volt/src/app.ts',
      content: 'one two three four',
      version: 4,
      diskVersion: 4,
      isDirty: false,
      lastModified: 1,
    });
    mocks.findBestMatchMock
      .mockReturnValueOnce({ index: 4, length: 3, similarity: 1 })
      .mockReturnValueOnce({ index: 14, length: 4, similarity: 1 });
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        committedContent: 'one dos three cinco',
        stagedContent: 'one dos three cinco',
      },
    });

    const result = await handleMultiReplace({
      path: 'src/app.ts',
      edits: [
        { oldStr: 'two', newStr: 'dos' },
        { oldStr: 'four', newStr: 'cinco' },
      ],
    });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'write',
      path: 'C:/tauri/volt/src/app.ts',
      content: 'one dos three cinco',
      createIfMissing: false,
      relativePath: 'src/app.ts',
      sync: {
        normalizedPath: 'C:/tauri/volt/src/app.ts',
        firstChangedLine: 1,
        lastChangedLine: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it('routes handleApplyPatch through the workspace mutation coordinator', async () => {
    mocks.readFileDocumentFreshMock.mockResolvedValue({
      path: 'C:/tauri/volt/src/app.ts',
      content: 'before',
      version: 5,
      diskVersion: 5,
      isDirty: false,
      lastModified: 1,
    });
    mocks.parseCodexPatchMock.mockReturnValue({
      path: 'src/app.ts',
      hunks: [{ lines: [] }],
    });
    mocks.applyCodexPatchMock.mockReturnValue('after');
    mocks.getCodexPatchLineStatsMock.mockReturnValue({ added: 1, removed: 1 });
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        committedContent: 'after',
        stagedContent: 'after',
      },
    });

    const result = await handleApplyPatch({
      path: 'src/app.ts',
      patch: '*** Begin Patch\n*** End Patch\n',
    });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'write',
      path: 'C:/tauri/volt/src/app.ts',
      content: 'after',
      createIfMissing: false,
      relativePath: 'src/app.ts',
      sync: {
        normalizedPath: 'C:/tauri/volt/src/app.ts',
        firstChangedLine: 1,
        lastChangedLine: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it('routes handleReplaceLines through the workspace mutation coordinator', async () => {
    mocks.readFileDocumentFreshMock.mockResolvedValue({
      path: 'C:/tauri/volt/src/app.ts',
      content: 'line1\nline2\nline3',
      version: 6,
      diskVersion: 6,
      isDirty: false,
      lastModified: 1,
    });
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        committedContent: 'line1\nupdated\nline3',
        stagedContent: 'line1\nupdated\nline3',
      },
    });

    const result = await handleReplaceLines({
      path: 'src/app.ts',
      start_line: 2,
      end_line: 2,
      content: 'updated',
    });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'write',
      path: 'C:/tauri/volt/src/app.ts',
      content: 'line1\nupdated\nline3',
      createIfMissing: false,
      relativePath: 'src/app.ts',
      sync: {
        normalizedPath: 'C:/tauri/volt/src/app.ts',
        firstChangedLine: 2,
        lastChangedLine: 2,
      },
    });
    expect(result.success).toBe(true);
  });

  it('routes handleCreateDir through the workspace mutation coordinator', async () => {
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        path: 'C:/tauri/volt/src/new-dir',
      },
    });

    const result = await handleCreateDir({ path: 'src/new-dir' });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'create_dir',
      path: 'C:/tauri/volt/src/new-dir',
    });
    expect(mocks.refreshTreeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      output: 'Created directory: src/new-dir',
      meta: {
        fileEdit: {
          relativePath: 'src/new-dir',
          absolutePath: 'C:/tauri/volt/src/new-dir',
          isDirectory: true,
        },
      },
    });
  });

  it('routes handleDeleteFile through the workspace mutation coordinator without tree removal', async () => {
    mocks.readFileDocumentFreshMock.mockResolvedValue({
      path: 'C:/tauri/volt/src/old.ts',
      content: 'legacy',
      version: 1,
      diskVersion: 1,
      isDirty: false,
      lastModified: 1,
    });
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        path: 'C:/tauri/volt/src/old.ts',
      },
    });

    const result = await handleDeleteFile({ path: 'src/old.ts', explanation: 'cleanup' });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'delete',
      path: 'C:/tauri/volt/src/old.ts',
      openPaths: [],
    });
    expect(mocks.closeFileMock).not.toHaveBeenCalled();
    expect(mocks.refreshTreeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      output: 'Deleted: src/old.ts\nReason: cleanup',
      meta: {
        fileDeleted: {
          relativePath: 'src/old.ts',
          absolutePath: 'C:/tauri/volt/src/old.ts',
          beforeContent: 'legacy',
          isDirectory: false,
        },
      },
    });
  });

  it('routes handleRenamePath through the workspace mutation coordinator without tree refresh', async () => {
    mocks.runMock.mockResolvedValue({
      success: true,
      record: {
        path: 'C:/tauri/volt/src/new-name.ts',
      },
    });

    const result = await handleRenamePath({
      oldPath: 'src/old-name.ts',
      newPath: 'src/new-name.ts',
    });

    expect(mocks.runMock).toHaveBeenCalledWith({
      type: 'rename',
      oldPath: 'C:/tauri/volt/src/old-name.ts',
      newPath: 'C:/tauri/volt/src/new-name.ts',
      openPaths: [],
    });
    expect(mocks.refreshTreeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      output: 'Renamed: src/old-name.ts → src/new-name.ts',
      meta: {
        pathRenamed: {
          oldPath: 'src/old-name.ts',
          newPath: 'src/new-name.ts',
          oldAbsolutePath: 'C:/tauri/volt/src/old-name.ts',
          newAbsolutePath: 'C:/tauri/volt/src/new-name.ts',
        },
      },
    });
  });
});
