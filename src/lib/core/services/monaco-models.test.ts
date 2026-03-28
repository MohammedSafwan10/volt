import { beforeEach, describe, expect, it, vi } from 'vitest';

const createModel = vi.fn((content: string, language: string | undefined, uri: { path: string; toString: () => string }) => ({
  uri,
  language,
  content,
  disposed: false,
  isDisposed() { return this.disposed; },
  dispose() { this.disposed = true; },
  getValue() { return this.content; },
  getFullModelRange() {
    return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: Math.max(this.content.length + 1, 1) };
  },
  pushEditOperations(_s: unknown[], edits: Array<{ text: string }>) {
    this.content = edits[0]?.text ?? this.content;
    return [];
  },
  getLineCount() { return Math.max(1, this.content.split('\n').length); },
  getLineMaxColumn() { return Math.max(this.content.length + 1, 1); },
  deltaDecorations() { return []; },
}));

const getModel = vi.fn();
const setModelLanguage = vi.fn();

const monacoMock = {
  Uri: {
    parse: (value: string) => ({
      value,
      path: value.replace('inmemory://model/', '/'),
      toString: () => value,
    }),
  },
  editor: {
    createModel,
    getModel,
    setModelLanguage,
  },
};

vi.mock('$core/services/monaco-loader', () => ({
  loadMonaco: vi.fn(async () => monacoMock),
  getMonaco: vi.fn(() => monacoMock),
}));

describe('monaco-models', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('creates canonical inmemory URIs for normalized paths', async () => {
    const models = await import('./monaco-models');
    await models.getOrCreateModel({
      path: 'C:\\repo\\src\\main.ts',
      content: 'const x = 1;',
      language: 'typescript',
    });

    expect(createModel).toHaveBeenCalledTimes(1);
    const uri = createModel.mock.calls[0][2];
    expect(uri.toString()).toContain('inmemory://model/');
    expect(uri.toString()).toContain(encodeURIComponent('C:/repo/src/main.ts'));
  });

  it('recreates missing models with the same inmemory URI scheme', async () => {
    const models = await import('./monaco-models');
    const updated = models.setModelValue('C:\\repo\\src\\main.ts', 'updated');

    expect(updated).toBe(true);
    const uri = createModel.mock.calls[0][2];
    expect(uri.toString()).toContain('inmemory://model/');
    expect(uri.toString()).toContain(encodeURIComponent('C:/repo/src/main.ts'));
  });

  it('skips model writes when the incoming value is identical', async () => {
    const models = await import('./monaco-models');
    await models.getOrCreateModel({
      path: 'C:\\repo\\src\\main.ts',
      content: 'same',
      language: 'typescript',
    });

    const updated = models.setModelValue('C:\\repo\\src\\main.ts', 'same');

    expect(updated).toBe(false);
  });
});
