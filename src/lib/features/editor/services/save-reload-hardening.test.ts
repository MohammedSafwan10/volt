import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeFileMock = vi.fn();

vi.mock('$core/services/file-system', () => ({
  writeFile: writeFileMock,
}));

const fileServiceMock = {
  subscribeAll: vi.fn(() => () => {}),
  isDirty: vi.fn(() => false),
  reload: vi.fn(),
  getVersion: vi.fn(() => 7),
  updateContent: vi.fn(),
  write: vi.fn(),
};

vi.mock('$core/services/file-service', () => ({
  fileService: fileServiceMock,
}));

vi.mock('$core/services/monaco-models', () => ({
  getModelValue: vi.fn(() => null),
  setModelValue: vi.fn(),
  clearReviewHighlight: vi.fn(),
  disposeAllModels: vi.fn(),
  disposeModel: vi.fn(),
  setSelection: vi.fn(),
}));

vi.mock('$core/services/prettier', () => ({
  formatBeforeSave: vi.fn(async (content: string) => content),
  isPrettierFile: vi.fn(() => false),
}));

vi.mock('$shared/stores/settings.svelte', () => ({
  settingsStore: {
    autoSaveEnabled: true,
    autoSaveDelay: 1000,
    formatOnSaveEnabled: false,
  },
}));

vi.mock('$shared/stores/activity.svelte', () => ({
  activityStore: {
    recordActivity: vi.fn(),
  },
}));

vi.mock('$core/services/monaco-loader', () => ({
  detectLanguage: vi.fn(() => 'plaintext'),
}));

vi.mock('$core/lsp/client', () => ({
  notifyFileClosed: vi.fn(),
}));

vi.mock('$features/editor/stores/editor-lsp-lifecycle', () => ({
  notifyEditorDidClose: vi.fn(),
  notifyEditorDidSave: vi.fn(),
}));

function createSidecarMock(): Record<string, unknown> {
  return {
    isTsJsFile: vi.fn(() => false),
    notifyDocumentClosed: vi.fn(),
    notifyDocumentSaved: vi.fn(),
    notifyDocumentChanged: vi.fn(),
    isTailwindFile: vi.fn(() => false),
    notifyTailwindDocumentClosed: vi.fn(),
    notifyTailwindDocumentSaved: vi.fn(),
    notifyTailwindDocumentChanged: vi.fn(),
    isEslintFile: vi.fn(() => false),
    notifyEslintDocumentClosed: vi.fn(),
    notifyEslintDocumentSaved: vi.fn(),
    notifyEslintDocumentChanged: vi.fn(),
    isSvelteFile: vi.fn(() => false),
    notifySvelteDocumentClosed: vi.fn(),
    notifySvelteDocumentSaved: vi.fn(),
    notifySvelteDocumentChanged: vi.fn(),
    isHtmlFile: vi.fn(() => false),
    notifyHtmlDocumentClosed: vi.fn(),
    notifyHtmlDocumentSaved: vi.fn(),
    notifyHtmlDocumentChanged: vi.fn(),
    isCssFile: vi.fn(() => false),
    notifyCssDocumentClosed: vi.fn(),
    notifyCssDocumentSaved: vi.fn(),
    notifyCssDocumentChanged: vi.fn(),
    isJsonFile: vi.fn(() => false),
    notifyJsonDocumentClosed: vi.fn(),
    notifyJsonDocumentSaved: vi.fn(),
    notifyJsonDocumentChanged: vi.fn(),
    isDartLspFile: vi.fn(() => false),
    notifyDocumentClosedDart: vi.fn(),
    notifyDocumentSavedDart: vi.fn(),
    notifyDocumentChangedDart: vi.fn(),
    isYamlFile: vi.fn(() => false),
    isXmlFile: vi.fn(() => false),
  };
}

vi.mock('$core/lsp/typescript-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/tailwind-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/eslint-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/svelte-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/html-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/css-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/json-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/dart-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/yaml-sidecar', () => createSidecarMock());
vi.mock('$core/lsp/xml-sidecar', () => createSidecarMock());

describe('save/reload hardening', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fileServiceMock.isDirty.mockReturnValue(false);
    fileServiceMock.getVersion.mockReturnValue(7);
    fileServiceMock.reload.mockResolvedValue({
      content: 'disk content',
    });
  });

  it('passes the native document version through auto-save writes', async () => {
    const { editorStore } = await import('../stores/editor.svelte');
    const { triggerImmediateAutoSave } = await import('./auto-save');

    editorStore.openFiles = [
      {
        path: 'c:/repo/src/main.ts',
        name: 'main.ts',
        content: 'changed',
        originalContent: 'before',
        language: 'typescript',
        lineEnding: 'LF',
        encoding: 'utf-8',
      },
    ];
    editorStore.activeFilePath = 'c:/repo/src/main.ts';
    fileServiceMock.isDirty.mockImplementation(((path?: string) => path === 'c:/repo/src/main.ts') as never);

    triggerImmediateAutoSave();
    await Promise.resolve();

    expect(writeFileMock).toHaveBeenCalledWith('c:/repo/src/main.ts', 'changed', {
      expectedVersion: 7,
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it('returns a promise from immediate auto-save so callers can await completion', async () => {
    const { editorStore } = await import('../stores/editor.svelte');
    const { triggerImmediateAutoSave } = await import('./auto-save');

    editorStore.openFiles = [
      {
        path: 'c:/repo/src/main.ts',
        name: 'main.ts',
        content: 'changed',
        originalContent: 'before',
        language: 'typescript',
        lineEnding: 'LF',
        encoding: 'utf-8',
      },
    ];
    editorStore.activeFilePath = 'c:/repo/src/main.ts';
    fileServiceMock.isDirty.mockImplementation(((path?: string) => path === 'c:/repo/src/main.ts') as never);

    const result = triggerImmediateAutoSave();

    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it('skips reloads when the file has unsaved changes', async () => {
    const { editorStore } = await import('../stores/editor.svelte');
    editorStore.openFiles = [
      {
        path: 'c:/repo/src/main.ts',
        name: 'main.ts',
        content: 'dirty',
        originalContent: 'clean',
        language: 'typescript',
        lineEnding: 'LF',
        encoding: 'utf-8',
      },
    ];

    fileServiceMock.isDirty.mockImplementation(((path?: string) => path === 'c:/repo/src/main.ts') as never);

    await expect(editorStore.reloadFile('c:/repo/src/main.ts')).resolves.toBe(false);
    expect(fileServiceMock.reload).not.toHaveBeenCalled();
  });

  it('uses createIfMissing flows without forcing writes', async () => {
    const { handleWritePlanFile } = await import('$core/ai/tools/handlers/write');

    fileServiceMock.write = vi.fn().mockResolvedValue({ success: true, newVersion: 1 });

    const result = await handleWritePlanFile({
      filename: 'new-plan',
      content: '# Plan'
    });

    expect(result.success).toBe(true);
    expect(fileServiceMock.write).toHaveBeenCalledWith(
      '.volt/plans/new-plan.md',
      '# Plan',
      {
        source: 'ai',
        createIfMissing: true
      }
    );
  });
});
