import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listenMock,
}));

vi.mock('$core/lsp/typescript-sidecar', () => ({
  isTsLspConnected: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/eslint-sidecar', () => ({
  notifyEslintDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/svelte-sidecar', () => ({
  isSvelteLspConnected: vi.fn(() => false),
  notifySvelteDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/html-sidecar', () => ({
  isHtmlLspConnected: vi.fn(() => false),
  notifyHtmlDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/css-sidecar', () => ({
  isCssLspConnected: vi.fn(() => false),
  notifyCssDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/json-sidecar', () => ({
  isJsonLspConnected: vi.fn(() => false),
  notifyJsonDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/dart-sidecar', () => ({
  isDartLspRunning: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/yaml-sidecar', () => ({
  isYamlLspRunning: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/xml-sidecar', () => ({
  isXmlLspRunning: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock('$core/lsp/tailwind-sidecar', () => ({
  isTailwindLspConnected: vi.fn(() => false),
  notifyTailwindDocumentChanged: vi.fn(),
}));

import { fileService, workspaceMutationFileBackend } from './file-service';

describe('fileService workspace mutation backend', () => {
  beforeEach(() => {
    mocks.invokeMock.mockReset();
    mocks.invokeMock.mockResolvedValue(undefined);
    mocks.listenMock.mockClear();
    fileService.closeDocument('src/old-name.ts');
    fileService.closeDocument('src/new-name.ts');
    fileService.closeDocument('src/to-delete.ts');
  });

  it('exposes structural mutation methods on the shared backend', () => {
    expect(typeof workspaceMutationFileBackend.createDir).toBe('function');
    expect(typeof workspaceMutationFileBackend.deletePath).toBe('function');
    expect(typeof workspaceMutationFileBackend.renamePath).toBe('function');
  });

  it('creates directories through the native command', async () => {
    mocks.invokeMock.mockResolvedValue(undefined);

    const result = await fileService.createDir('src\\new-dir');

    expect(result).toEqual({ success: true });
    expect(mocks.invokeMock).toHaveBeenCalledWith('create_dir', { path: 'src/new-dir' });
  });

  it('deletes cached documents after a successful delete', async () => {
    mocks.invokeMock.mockResolvedValue(undefined);
    fileService.setCachedDocument('src/to-delete.ts', {
      path: 'src/to-delete.ts',
      content: 'obsolete',
      version: 2,
      diskVersion: 2,
      isDirty: false,
      lastModified: 1,
      language: 'typescript',
    });

    const result = await fileService.deletePath('src\\to-delete.ts');

    expect(result).toEqual({ success: true });
    expect(mocks.invokeMock).toHaveBeenCalledWith('delete_path', { path: 'src/to-delete.ts' });
    expect(fileService.getDocument('src/to-delete.ts')).toBeNull();
  });

  it('moves cached documents after a successful rename', async () => {
    mocks.invokeMock.mockResolvedValue(undefined);
    fileService.setCachedDocument('src/old-name.ts', {
      path: 'src/old-name.ts',
      content: 'export const renamed = true;',
      version: 7,
      diskVersion: 7,
      isDirty: false,
      lastModified: 1,
      language: 'typescript',
    });

    const result = await fileService.renamePath('src\\old-name.ts', 'src\\new-name.ts');

    expect(result).toEqual({ success: true });
    expect(mocks.invokeMock).toHaveBeenCalledWith('rename_path', {
      oldPath: 'src/old-name.ts',
      newPath: 'src/new-name.ts',
    });
    expect(fileService.getDocument('src/old-name.ts')).toBeNull();
    expect(fileService.getDocument('src/new-name.ts')).toMatchObject({
      path: 'src/new-name.ts',
      content: 'export const renamed = true;',
      version: 7,
    });
  });

  it('clears cached dirty state immediately after a successful write', async () => {
    mocks.invokeMock.mockResolvedValue({
      success: true,
      newVersion: 4,
    });
    fileService.setCachedDocument('src/dirty.txt', {
      path: 'src/dirty.txt',
      content: 'before',
      version: 3,
      diskVersion: 2,
      isDirty: true,
      lastModified: 1,
      language: 'plaintext',
    });

    const result = await fileService.write('src\\dirty.txt', 'after', { source: 'editor' });

    expect(result).toEqual({
      success: true,
      newVersion: 4,
      error: undefined,
      conflictContent: undefined,
    });
    expect(fileService.isDirty('src/dirty.txt')).toBe(false);
    expect(fileService.getDocument('src/dirty.txt')).toMatchObject({
      path: 'src/dirty.txt',
      content: 'after',
      version: 4,
      diskVersion: 4,
      isDirty: false,
    });
  });
});
