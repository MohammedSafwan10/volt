import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();
const registerCleanupMock = vi.fn();
const logOutputMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('$features/terminal/stores/output.svelte', () => ({
  logOutput: logOutputMock,
}));

vi.mock('$core/services/hmr-cleanup', () => ({
  registerCleanup: registerCleanupMock,
}));

vi.mock('$shared/stores/project.svelte', () => ({}));
vi.mock('$core/lsp/sidecar/register', () => ({}));
vi.mock('$core/lsp/sidecar/watched-files', () => ({}));

describe('file-index cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
  });

  it('registers HMR cleanup on first indexing start', async () => {
    let doneListener: ((event: { payload: { requestId: number; totalCount: number; cancelled: boolean; durationMs: number } }) => void) | undefined;
    let streamRequestId: number | undefined;

    listenMock.mockImplementation(async (eventName: string, callback: typeof doneListener) => {
      if (eventName === 'file-index://done') {
        doneListener = callback;
      }
      return () => {};
    });

    let indexWorkspaceResolve: (() => void) | undefined;
    invokeMock.mockImplementation(async (command: string, payload?: { requestId?: number }) => {
      if (command === 'index_workspace_stream' && payload?.requestId) {
        streamRequestId = payload.requestId;
        return new Promise<void>((resolve) => {
          indexWorkspaceResolve = resolve;
        });
      }
      return undefined;
    });

    const module = await import('./file-index');
    const indexProjectPromise = module.indexProject('c:/repo');

    await vi.waitFor(() => {
      expect(doneListener).toBeTypeOf('function');
      expect(streamRequestId).toBeTypeOf('number');
      expect(registerCleanupMock).toHaveBeenCalledWith(
        'file-index',
        expect.any(Function),
      );
    });

    doneListener?.({
      payload: {
        requestId: streamRequestId!,
        totalCount: 0,
        cancelled: false,
        durationMs: 0,
      },
    });
    indexWorkspaceResolve?.();

    await indexProjectPromise;

    expect(registerCleanupMock).toHaveBeenCalledWith(
      'file-index',
      expect.any(Function),
    );
  });

  it('cancels active indexing during registered cleanup', async () => {
    const module = await import('./file-index');

    invokeMock.mockImplementation(async (command: string, payload?: { requestId?: number }) => {
      if (command === 'index_workspace_stream' && payload?.requestId) {
        return new Promise<void>(() => {});
      }
      return undefined;
    });

    const indexingPromise = module.indexProject('c:/repo');
    await Promise.resolve();

    const [, cleanup] = registerCleanupMock.mock.calls.at(-1)!;
    await cleanup();
    indexingPromise.catch(() => undefined);

    expect(invokeMock).toHaveBeenCalledWith('cancel_index_workspace', {
      requestId: expect.any(Number),
    });
  });
});
