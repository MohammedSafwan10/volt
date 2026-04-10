import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transport = {
    configureHealth: vi.fn(),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onExit: vi.fn(),
    onRestart: vi.fn(),
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
    sendResponse: vi.fn(),
    syncDocument: vi.fn(),
    closeDocument: vi.fn(),
    listTrackedDocuments: vi.fn(async () => []),
    connected: true,
  };

  return {
    invokeMock: vi.fn(),
    startServerMock: vi.fn(),
    readFileQuietMock: vi.fn(),
    getAllFilesMock: vi.fn<() => Array<{ path: string }>>(() => []),
    transport,
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invokeMock,
}));

vi.mock('./sidecar', () => ({
  getLspRegistry: () => ({
    startServer: mocks.startServerMock,
  }),
}));

vi.mock('$shared/stores/project.svelte', () => ({
  projectStore: {
    rootPath: 'C:/workspace',
    projectName: 'workspace',
    packageManager: 'pnpm',
  },
}));

vi.mock('$core/services/file-system', () => ({
  readFileQuiet: mocks.readFileQuietMock,
}));

vi.mock('$core/services/file-index', () => ({
  getAllFiles: mocks.getAllFilesMock,
}));

describe('eslint-sidecar startup ownership', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mocks.invokeMock.mockReset();
    mocks.startServerMock.mockReset();
    mocks.readFileQuietMock.mockReset();
    mocks.getAllFilesMock.mockReset();
    mocks.transport.configureHealth.mockReset();
    mocks.transport.onMessage.mockReset();
    mocks.transport.onError.mockReset();
    mocks.transport.onExit.mockReset();
    mocks.transport.onRestart.mockReset();
    mocks.transport.sendRequest.mockReset();
    mocks.transport.sendNotification.mockReset();
    mocks.transport.sendResponse.mockReset();
    mocks.transport.syncDocument.mockReset();
    mocks.transport.closeDocument.mockReset();
    mocks.transport.listTrackedDocuments.mockReset();
    mocks.transport.listTrackedDocuments.mockResolvedValue([]);
    mocks.startServerMock.mockResolvedValue(mocks.transport);
    mocks.getAllFilesMock.mockReturnValue([]);
    mocks.readFileQuietMock.mockResolvedValue('export const x = 1;');
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mocks.transport.sendRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return { capabilities: {} };
      }
      return null;
    });
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('does not stop and retry stale servers from TypeScript when startup reports ServerAlreadyRunning', async () => {
    const staleError = { type: 'ServerAlreadyRunning' };
    mocks.startServerMock.mockRejectedValue(staleError);

    const mod = await import('./eslint-sidecar');

    await expect(
      mod.notifyEslintDocumentOpened('C:/workspace/src/app.ts', 'export const x = 1;'),
    ).rejects.toBe(staleError);

    expect(mocks.startServerMock).toHaveBeenCalledTimes(1);
    expect(mocks.invokeMock).not.toHaveBeenCalledWith('lsp_stop_server', {
      serverId: 'eslint-main',
    });
  });

  it('uses the native diagnostics delay command instead of a frontend timer during project analysis batching', async () => {
    mocks.getAllFilesMock.mockReturnValue(
      Array.from({ length: 11 }, (_, index) => ({
        path: `C:/workspace/src/file-${index}.ts`,
      })),
    );

    const mod = await import('./eslint-sidecar');

    await mod.startProjectWideAnalysis();

    expect(mocks.invokeMock).toHaveBeenCalledWith('lsp_wait_project_diagnostics_delay', {
      delayMs: 20,
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
