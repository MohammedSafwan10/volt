import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTransportsByTypeMock = vi.fn();
const registerCleanupMock = vi.fn();

vi.mock('./register', () => ({
  getLspRegistry: () => ({
    getTransportsByType: getTransportsByTypeMock,
  }),
}));

vi.mock('$core/services/hmr-cleanup', () => ({
  registerCleanup: registerCleanupMock,
}));

describe('watched file dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getTransportsByTypeMock.mockReturnValue([]);
  });

  it('normalizes rename events into delete and create changes', async () => {
    const { normalizeWatchedFileChanges } = await import('./watched-files');

    const changes = normalizeWatchedFileChanges([
      {
        kind: 'rename',
        paths: ['old.ts', 'new.ts'],
        absolutePaths: ['C:/repo/old.ts', 'C:/repo/new.ts'],
        workspaceRoot: 'C:/repo',
      },
    ]);

    expect(changes).toEqual([
      { kind: 'delete', path: 'c:/repo/old.ts' },
      { kind: 'create', path: 'c:/repo/new.ts' },
    ]);
  });

  it('fans out relevant changes to matching server transports', async () => {
    const notifyTypeScript = vi.fn(async () => {});
    const notifyYaml = vi.fn(async () => {});
    getTransportsByTypeMock.mockImplementation((serverType: string) => {
      if (serverType === 'typescript') {
        return [{ connected: true, sendNotification: notifyTypeScript }];
      }
      if (serverType === 'dart') {
        return [{ connected: true, sendNotification: notifyYaml }];
      }
      return [];
    });

    const { dispatchWatchedFileChanges, resetWatchedFileDispatch } = await import('./watched-files');

    dispatchWatchedFileChanges([
      { kind: 'change', path: 'C:/repo/src/app.ts' },
      { kind: 'change', path: 'C:/repo/pubspec.yaml' },
    ]);

    await vi.advanceTimersByTimeAsync(150);

    expect(notifyTypeScript).toHaveBeenCalledTimes(1);
    expect(notifyTypeScript).toHaveBeenCalledWith('workspace/didChangeWatchedFiles', {
      changes: [{ uri: 'file:///c:/repo/src/app.ts', type: 2 }],
    });

    expect(notifyYaml).toHaveBeenCalledTimes(1);
    expect(notifyYaml).toHaveBeenCalledWith('workspace/didChangeWatchedFiles', {
      changes: [{ uri: 'file:///c:/repo/pubspec.yaml', type: 2 }],
    });

    resetWatchedFileDispatch();
  });
});
