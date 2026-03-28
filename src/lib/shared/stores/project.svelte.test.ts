import { beforeEach, describe, expect, it, vi } from 'vitest';

const listDirectoryMock = vi.fn();
const invokeMock = vi.fn();
const showToastMock = vi.fn();
const searchClearMock = vi.fn();
const handleFileChangeBatchMock = vi.fn();
const onFileChangeMock = vi.fn();
const hasOpenEditorFileMock = vi.fn();
const reloadEditorFileMock = vi.fn();
const listDirectoryDetailedMock = vi.fn();

type WorkspaceArgs = {
  request?: {
    path?: string;
    currentRootPath?: string | null;
  };
  recentProjects?: string[];
};

const getRequest = (args?: WorkspaceArgs): NonNullable<WorkspaceArgs['request']> => args?.request ?? {};
const getRecentProjects = (args?: WorkspaceArgs) => args?.recentProjects ?? [];

vi.mock('$core/services/file-system', () => ({
  listDirectory: listDirectoryMock,
  listDirectoryDetailed: listDirectoryDetailedMock,
  getFileInfoQuiet: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  dirname: vi.fn(async (path: string) => path.split(/[\\/]/).slice(0, -1).join('/')),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('$shared/stores/toast.svelte', () => ({
  showToast: showToastMock,
}));

vi.mock('$features/search/stores/search.svelte', () => ({
  searchStore: {
    clear: searchClearMock,
  },
}));

vi.mock('$core/lsp/sidecar', () => ({
  initLspRegistry: vi.fn(),
  disposeLspRegistry: vi.fn(),
}));
vi.mock('$core/lsp/typescript-sidecar', () => ({ stopTsLsp: vi.fn() }));
vi.mock('$core/lsp/tailwind-sidecar', () => ({ stopTailwindLsp: vi.fn() }));
vi.mock('$core/lsp/eslint-sidecar', () => ({
  stopEslintLsp: vi.fn(),
  pushEslintConfig: vi.fn(),
}));
vi.mock('$core/lsp/svelte-sidecar', () => ({ stopSvelteLsp: vi.fn() }));
vi.mock('$core/lsp/html-sidecar', () => ({ stopHtmlLsp: vi.fn() }));
vi.mock('$core/lsp/css-sidecar', () => ({ stopCssLsp: vi.fn() }));
vi.mock('$core/lsp/json-sidecar', () => ({ stopJsonLsp: vi.fn() }));
vi.mock('$core/lsp/yaml-sidecar', () => ({ stopYamlLsp: vi.fn() }));
vi.mock('$core/lsp/xml-sidecar', () => ({ stopXmlLsp: vi.fn() }));
vi.mock('$core/lsp/dart-sidecar', () => ({
  startDartLsp: vi.fn(),
  stopDartLsp: vi.fn(),
}));
vi.mock('$core/services/file-index', () => ({
  cancelIndexing: vi.fn(),
  clearIndex: vi.fn(),
  getIndexStatus: vi.fn(() => ({ count: 0 })),
  handleFileChangeBatch: handleFileChangeBatchMock,
  indexProject: vi.fn(async () => undefined),
  getIndexedRoot: vi.fn(),
}));
vi.mock('$core/lsp/sidecar/watched-files', () => ({
  dispatchWatchedFileChanges: vi.fn(),
  normalizeWatchedFileChanges: vi.fn(() => []),
  resetWatchedFileDispatch: vi.fn(),
}));
vi.mock('$features/terminal/services/terminal-problem-matcher', () => ({
  terminalProblemMatcher: { clear: vi.fn(), start: vi.fn() },
  setTerminalProblemMatcherProjectRootResolver: vi.fn(),
}));
vi.mock('$core/services/file-service', () => ({
  fileService: { subscribeAll: vi.fn(() => () => undefined) },
}));
vi.mock('$core/services/file-watch', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  onFileChange: onFileChangeMock,
}));
vi.mock('$core/services/project-diagnostics', () => ({
  projectDiagnostics: { reset: vi.fn(), runDiagnostics: vi.fn() },
}));
vi.mock('$core/services/tsc-watcher', () => ({
  tscWatcher: { stop: vi.fn(), start: vi.fn() },
}));
vi.mock('./problems.svelte', () => ({
  problemsStore: { clearAll: vi.fn(), diagnosticsBasis: 'committed_disk', diagnosticsFreshness: { status: 'fresh', activeSources: [], staleSources: [], sourceStatuses: [], isUpdating: false, hasWarmingSources: false } },
}));
vi.mock('$core/ai/context/context-v2', () => ({
  clearContextV2Cache: vi.fn(),
}));
vi.mock('$core/services/workspace-mutation-coordinator', () => ({
  workspaceMutationCoordinator: {
    stagedDocuments: {
      subscribe: vi.fn((listener: (value: Record<string, unknown>) => void, options?: { selector?: (records: unknown[]) => unknown }) => {
        if (options?.selector) {
          listener(options.selector([]) as Record<string, unknown>);
        } else {
          listener({});
        }
        return () => undefined;
      }),
    },
  },
}));
vi.mock('$core/ai/retrieval/semantic-index', () => ({
  clearSemanticQueue: vi.fn(),
  queueSemanticRemove: vi.fn(),
  queueSemanticUpsert: vi.fn(),
  warmSemanticIndex: vi.fn(),
}));
vi.mock('./project-bridge', () => ({
  cleanupEditorStore: vi.fn(),
  cleanupMcpStore: vi.fn(),
  closeAllEditorFiles: vi.fn(),
  initGitStore: vi.fn(),
  hasOpenEditorFile: hasOpenEditorFileMock,
  initializeMcpStore: vi.fn(),
  reloadEditorFile: reloadEditorFileMock,
  resetGitStore: vi.fn(),
}));

describe('projectStore workspace lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    handleFileChangeBatchMock.mockResolvedValue(true);
    listDirectoryDetailedMock.mockResolvedValue({
      entries: [{ name: 'src', path: 'C:/workspace/src', isDir: true }],
      skipped: [],
    });
    onFileChangeMock.mockImplementation((handler: (batch: unknown) => void) => {
      (globalThis as { __projectFileChangeHandler?: (batch: unknown) => void }).__projectFileChangeHandler = handler;
      return () => undefined;
    });
    hasOpenEditorFileMock.mockResolvedValue(false);
    reloadEditorFileMock.mockReset();
    listDirectoryMock.mockResolvedValue([{ name: 'src', path: 'C:/workspace/src', isDir: true }]);
    invokeMock.mockImplementation(async (command: string, args?: WorkspaceArgs) => {
      const request = getRequest(args);
      switch (command) {
        case 'workspace_get_state':
          return { activeRootPath: null, persistedRootPath: null, recentProjects: [] };
        case 'workspace_open':
          return {
            opened: true,
            activeRootPath: request.path,
            previousRootPath: request.currentRootPath ?? null,
            unchanged: false,
            recentProjects: request.path ? [request.path] : [],
            message: null,
          };
        case 'workspace_close':
          return {
            closed: true,
            activeRootPath: null,
            previousRootPath: request.currentRootPath ?? null,
            recentProjects: ['C:/workspace'],
          };
        case 'workspace_refresh':
          return {
            refreshed: true,
            activeRootPath: request.currentRootPath ?? null,
            recentProjects: ['C:/workspace'],
            message: null,
          };
        case 'workspace_replace_recent_projects':
          return getRecentProjects(args);
        default:
          return undefined;
      }
    });

    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
    });
  });

  it('preserves current workspace and shows feedback when opening an invalid folder fails', async () => {
    const { projectStore } = await import('./project.svelte');

    const firstOpen = await projectStore.openProject('C:/workspace');
    expect(firstOpen).toBe(true);
    expect(projectStore.rootPath).toBe('C:/workspace');

    invokeMock.mockImplementationOnce(async (command: string, args?: WorkspaceArgs) => {
      if (command === 'workspace_open') {
        const request = getRequest(args);
        return {
          opened: false,
          activeRootPath: 'C:/workspace',
          previousRootPath: request.currentRootPath ?? null,
          unchanged: false,
          recentProjects: ['C:/workspace'],
          message: 'Failed to open folder: C:/missing',
        };
      }
      return undefined;
    });

    const secondOpen = await projectStore.openProject('C:/missing');
    expect(secondOpen).toBe(false);
    expect(projectStore.rootPath).toBe('C:/workspace');
    expect(showToastMock).toHaveBeenCalledWith({
      message: 'Failed to open folder: C:/missing',
      type: 'error',
    });
  });

  it('restores the last workspace from native persisted state instead of localStorage', async () => {
    invokeMock.mockImplementation(async (command: string, args?: WorkspaceArgs) => {
      const request = getRequest(args);
      switch (command) {
        case 'workspace_get_state':
          return {
            activeRootPath: null,
            persistedRootPath: 'C:/persisted',
            recentProjects: ['C:/persisted'],
          };
        case 'workspace_open':
          return {
            opened: true,
            activeRootPath: request.path,
            previousRootPath: request.currentRootPath ?? null,
            unchanged: false,
            recentProjects: request.path ? [request.path] : [],
            message: null,
          };
        case 'workspace_close':
          return {
            closed: true,
            activeRootPath: null,
            previousRootPath: request.currentRootPath ?? null,
            recentProjects: ['C:/persisted'],
          };
        case 'workspace_refresh':
          return {
            refreshed: true,
            activeRootPath: request.currentRootPath ?? null,
            recentProjects: ['C:/persisted'],
            message: null,
          };
        case 'workspace_replace_recent_projects':
          return getRecentProjects(args);
        default:
          return undefined;
      }
    });

    const { projectStore } = await import('./project.svelte');

    await projectStore.init();

    expect(projectStore.rootPath).toBe('C:/persisted');
    expect(localStorage.getItem).not.toHaveBeenCalledWith('volt.currentProject');
    expect(invokeMock.mock.calls.filter(([command]) => command === 'workspace_open')).toHaveLength(1);
  });

  it('clears stale persisted workspace state when restore fails', async () => {
    invokeMock.mockImplementation(async (command: string, args?: WorkspaceArgs) => {
      const request = getRequest(args);
      switch (command) {
        case 'workspace_get_state':
          return {
            activeRootPath: null,
            persistedRootPath: 'C:/missing',
            recentProjects: ['C:/missing'],
          };
        case 'workspace_open':
          return {
            opened: false,
            activeRootPath: null,
            previousRootPath: request.currentRootPath ?? null,
            unchanged: false,
            recentProjects: ['C:/missing'],
            message: 'Failed to open folder: C:/missing',
          };
        case 'workspace_close':
          return {
            closed: true,
            activeRootPath: null,
            previousRootPath: request.currentRootPath ?? null,
            recentProjects: [],
          };
        case 'workspace_refresh':
          return {
            refreshed: true,
            activeRootPath: request.currentRootPath ?? null,
            recentProjects: [],
            message: null,
          };
        case 'workspace_replace_recent_projects':
          return getRecentProjects(args);
        default:
          return undefined;
      }
    });

    const { projectStore } = await import('./project.svelte');

    await projectStore.init();

    expect(projectStore.rootPath).toBeNull();
    expect(projectStore.loading).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('workspace_close', {
      request: {
        currentRootPath: null,
        removePersistence: true,
      },
    });
  });

  it('does not reload an open editor immediately on watcher modify bursts', async () => {
    const { projectStore } = await import('./project.svelte');

    await projectStore.openProject('C:/workspace');
    hasOpenEditorFileMock.mockResolvedValue(true);

    const handler = (globalThis as { __projectFileChangeHandler?: (batch: unknown) => void }).__projectFileChangeHandler;
    await handler?.({
      changes: [
        {
          kind: 'modify',
          absolutePaths: ['C:/workspace/src/file.ts'],
          paths: ['src/file.ts'],
        },
      ],
    });

    expect(reloadEditorFileMock).not.toHaveBeenCalled();
  });

  it('coalesces rapid create bursts into buffered refresh work instead of immediate tree thrash', async () => {
    const { projectStore } = await import('./project.svelte');

    await projectStore.openProject('C:/workspace');
    const refreshTreeSpy = vi.spyOn(projectStore, 'refreshTree').mockResolvedValue();

    const handler = (globalThis as { __projectFileChangeHandler?: (batch: unknown) => void }).__projectFileChangeHandler;

    await handler?.({
      changes: [
        {
          kind: 'create',
          absolutePaths: ['C:/workspace/a.ts'],
          paths: ['a.ts'],
        },
        {
          kind: 'create',
          absolutePaths: ['C:/workspace/b.ts'],
          paths: ['b.ts'],
        },
      ],
    });

    expect(refreshTreeSpy).not.toHaveBeenCalled();
  });

  it('clears search state when closing the current workspace', async () => {
    const { projectStore } = await import('./project.svelte');

    await projectStore.openProject('C:/workspace');
    await projectStore.closeProject();

    expect(searchClearMock).toHaveBeenCalled();
    expect(projectStore.rootPath).toBeNull();
  });

  it('does not reopen the already active workspace', async () => {
    const { projectStore } = await import('./project.svelte');

    await projectStore.openProject('C:/workspace');

    invokeMock.mockImplementationOnce(async (command: string, args?: WorkspaceArgs) => {
      if (command === 'workspace_open') {
        const request = getRequest(args);
        return {
          opened: true,
          activeRootPath: 'C:/workspace',
          previousRootPath: request.currentRootPath ?? null,
          unchanged: true,
          recentProjects: ['C:/workspace'],
          message: null,
        };
      }
      return undefined;
    });

    const reopened = await projectStore.openProject('C:/workspace');
    expect(reopened).toBe(true);
    expect(listDirectoryMock).toHaveBeenCalledTimes(1);
  });

  it('stores staged tree overlay projections separately from the tree model', async () => {
    const { projectStore } = await import('./project.svelte');

    projectStore.setStagedTreeOverlay({
      'c:/workspace/src/app.ts': {
        kind: 'file',
        state: 'staged_modified',
      },
    });

    expect(projectStore.getTreeMutationProjection('C:/workspace/src/app.ts')).toEqual({
      kind: 'file',
      state: 'staged_modified',
    });
  });

});
