import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();
const registerCleanupMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('$shared/stores/toast.svelte', () => ({
  showToast: vi.fn(),
}));

vi.mock('$features/terminal/stores/output.svelte', () => ({
  logOutput: vi.fn(),
}));

vi.mock('$core/services/hmr-cleanup', () => ({
  registerCleanup: registerCleanupMock,
}));

describe('workspace search stream cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    invokeMock.mockResolvedValue(undefined);
    listenMock.mockResolvedValue(() => {});
  });

  it('registers cleanup that cancels active searches and unlistens', async () => {
    const service = await import('./search');

    await service.workspaceSearchStream(
      {
        query: 'foo',
        rootPath: 'c:/repo',
        requestId: 42,
      },
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
      },
    );

    expect(registerCleanupMock).toHaveBeenCalledTimes(1);
    const [, cleanup] = registerCleanupMock.mock.calls[0];
    await cleanup();

    expect(invokeMock).toHaveBeenCalledWith('cancel_workspace_search', { requestId: 42 });
  });
});
