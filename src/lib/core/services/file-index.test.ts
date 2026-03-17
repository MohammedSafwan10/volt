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

describe('file-index cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
  });

  it('registers HMR cleanup on first indexing start', async () => {
    const module = await import('./file-index');

    invokeMock.mockImplementation(async () => undefined);
    void module.indexProject('c:/repo');
    await Promise.resolve();

    expect(registerCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('cancels active indexing during registered cleanup', async () => {
    const module = await import('./file-index');

    invokeMock.mockImplementation(async () => undefined);

    const indexingPromise = module.indexProject('c:/repo');
    await Promise.resolve();

    const [, cleanup] = registerCleanupMock.mock.calls[0];
    await cleanup();
    await indexingPromise;

    expect(invokeMock).toHaveBeenCalledWith('cancel_index_workspace', {
      requestId: expect.any(Number),
    });
  });
});
