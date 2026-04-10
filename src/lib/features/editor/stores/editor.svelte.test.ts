import { beforeEach, describe, expect, it, vi } from 'vitest';

const subscribeAllMock = vi.fn();
const updateContentMock = vi.fn();
const getDocumentMock = vi.fn();
const readMock = vi.fn();
const setModelValueMock = vi.fn();

vi.mock('$core/services/file-service', () => ({
  fileService: {
    subscribeAll: subscribeAllMock,
    isDirty: vi.fn(() => false),
    updateContent: updateContentMock,
    getDocument: getDocumentMock,
    read: readMock,
  },
}));

vi.mock('$core/services/monaco-models', () => ({
  clearReviewHighlight: vi.fn(),
  disposeAllModels: vi.fn(),
  disposeModel: vi.fn(),
  setModelValue: setModelValueMock,
  setSelection: vi.fn(),
}));

vi.mock('$core/lsp/client', () => ({
  notifyFileClosed: vi.fn(),
}));

vi.mock('$shared/stores/activity.svelte', () => ({
  activityStore: {
    recordActivity: vi.fn(),
  },
}));

vi.mock('$core/services/monaco-loader', () => ({
  detectLanguage: vi.fn(() => 'plaintext'),
}));

vi.mock('./editor-lsp-lifecycle', () => ({
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

describe('editor store lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    updateContentMock.mockReset();
    getDocumentMock.mockReset();
    readMock.mockReset();
    setModelValueMock.mockReset();
  });

  it('subscribes to file service changes when created and unsubscribes on dispose', async () => {
    const unsubscribe = vi.fn();
    subscribeAllMock.mockReturnValue(unsubscribe);

    const module = await import('./editor.svelte');

    expect(subscribeAllMock).toHaveBeenCalledTimes(1);

    module.disposeEditorStore();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(module.editorStore.fileServiceUnsubscribe).toBeNull();
  });

  it('can reinitialize the file service subscription after cleanup without recreating the store', async () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    subscribeAllMock
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe);

    const module = await import('./editor.svelte');

    expect(subscribeAllMock).toHaveBeenCalledTimes(1);

    module.disposeEditorStore();
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);

    module.editorStore.initialize();

    expect(subscribeAllMock).toHaveBeenCalledTimes(2);
    expect(module.editorStore.fileServiceUnsubscribe).toBe(secondUnsubscribe);
  });

  it('does not keep a false dirty state after an agent edit has already been saved', async () => {
    subscribeAllMock.mockReturnValue(() => undefined);
    readMock.mockResolvedValue({ content: 'original text' });
    getDocumentMock.mockReturnValue({
      content: 'agent text',
      isDirty: false,
      language: 'plaintext',
    });

    const module = await import('./editor.svelte');

    await module.editorStore.openFile('C:/workspace/file.txt');
    module.editorStore.updateContent('C:/workspace/file.txt', 'agent text');

    const handler = subscribeAllMock.mock.calls[0]?.[0];
    handler?.({
      path: 'C:/workspace/file.txt',
      content: 'agent text',
      source: 'ai',
    });

    expect(module.editorStore.isDirty('C:/workspace/file.txt')).toBe(false);
    expect(module.editorStore.openFiles[0]?.originalContent).toBe('agent text');
    expect(setModelValueMock).toHaveBeenCalledWith('C:/workspace/file.txt', 'agent text');
  });

  it('replaces the open file entry when a save completes so tab dirtiness can rerender', async () => {
    subscribeAllMock.mockReturnValue(() => undefined);
    readMock.mockResolvedValue({ content: 'before' });
    getDocumentMock.mockReturnValue({
      content: 'after',
      isDirty: false,
      language: 'plaintext',
    });

    const module = await import('./editor.svelte');

    await module.editorStore.openFile('C:/workspace/file.txt');
    const beforeSaveEntry = module.editorStore.openFiles[0];
    module.editorStore.updateContent('C:/workspace/file.txt', 'after');

    module.editorStore.markSaved('C:/workspace/file.txt');

    expect(module.editorStore.openFiles[0]).not.toBe(beforeSaveEntry);
    expect(module.editorStore.openFiles[0]?.content).toBe('after');
    expect(module.editorStore.openFiles[0]?.originalContent).toBe('after');
  });
});
