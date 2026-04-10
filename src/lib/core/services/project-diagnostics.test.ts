import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const clearIndexMock = vi.fn();
const getAllFilesMock = vi.fn(() => []);
const getIndexedRootMock = vi.fn(() => 'c:/repo');
const indexProjectMock = vi.fn(async () => {});
const isIndexReadyMock = vi.fn(() => true);
const isIndexingMock = vi.fn(() => false);

const startCssAnalysisMock = vi.fn(async () => {});
const startHtmlAnalysisMock = vi.fn(async () => {});
const startTsAnalysisMock = vi.fn(async () => {});
const startSvelteAnalysisMock = vi.fn(async () => {});
const startEslintAnalysisMock = vi.fn(async () => {});
const startDartLspMock = vi.fn(async () => {});
const startDartAnalysisMock = vi.fn(async () => {});
const problemsStoreMock = {
  setProblemsForFile: vi.fn(),
  clearProblemsForFile: vi.fn(),
  markSourceStale: vi.fn(),
  markSourceFresh: vi.fn(),
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('$core/services/file-index', () => ({
  clearIndex: clearIndexMock,
  getAllFiles: getAllFilesMock,
  getIndexedRoot: getIndexedRootMock,
  indexProject: indexProjectMock,
  isIndexReady: isIndexReadyMock,
  isIndexing: isIndexingMock,
}));

vi.mock('$core/lsp/css-sidecar', () => ({
  startProjectWideAnalysis: startCssAnalysisMock,
}));

vi.mock('$core/lsp/html-sidecar', () => ({
  startProjectWideAnalysis: startHtmlAnalysisMock,
}));

vi.mock('$core/lsp/typescript-sidecar', () => ({
  startProjectWideAnalysis: startTsAnalysisMock,
}));

vi.mock('$core/lsp/svelte-sidecar', () => ({
  startProjectWideAnalysis: startSvelteAnalysisMock,
}));

vi.mock('$core/lsp/eslint-sidecar', () => ({
  startProjectWideAnalysis: startEslintAnalysisMock,
}));

vi.mock('$core/lsp/dart-sidecar', () => ({
  startDartLsp: startDartLspMock,
  startProjectWideAnalysis: startDartAnalysisMock,
}));

vi.mock('$shared/stores/problems.svelte', () => ({
  problemsStore: problemsStoreMock,
}));

describe('ProjectDiagnostics', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_system_info') {
        return { os_name: 'windows' };
      }

      if (command === 'run_command') {
        return { exit_code: 0, stdout: '[]', stderr: '' };
      }

      if (command === 'get_file_info') {
        throw new Error('missing');
      }

      return null;
    });
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('queues only the latest pending root while a run is active', async () => {
    const { ProjectDiagnostics } = await import('./project-diagnostics');
    const diagnostics = new ProjectDiagnostics();
    (diagnostics as any).isRunning = true;

    await diagnostics.runDiagnostics('c:/repo-a');
    await diagnostics.runDiagnostics('c:/repo-b');

    expect((diagnostics as any).pendingRoot).toBe('c:/repo-b');
    expect(invokeMock).not.toHaveBeenCalledWith('run_command', expect.anything());
  });

  it('queues concurrent requests during async platform detection', async () => {
    const { ProjectDiagnostics } = await import('./project-diagnostics');
    const diagnostics = new ProjectDiagnostics();
    let releasePlatformCheck!: () => void;
    const platformGate = new Promise<void>((resolve) => {
      releasePlatformCheck = resolve;
    });

    (diagnostics as any).checkPlatform = vi.fn(() => platformGate);

    const firstRun = diagnostics.runDiagnostics('c:/repo-a');
    const secondRun = diagnostics.runDiagnostics('c:/repo-b');

    await Promise.resolve();

    expect((diagnostics as any).isRunning).toBe(true);
    expect((diagnostics as any).pendingRoot).toBe('c:/repo-b');

    releasePlatformCheck();
    await firstRun;
    diagnostics.reset();
    await secondRun;
  });

  it('marks requested sources stale when the backend scheduler delays project diagnostics', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_system_info') {
        return { os_name: 'windows' };
      }

      if (command === 'lsp_begin_project_diagnostics_managed') {
        return {
          action: 'noop',
          runId: null,
          rootPath: 'c:/repo',
          delayMs: 0,
          staggerMs: 150,
          sidecars: [],
          staleSources: ['typescript', 'eslint'],
          freshSources: [],
        };
      }

      return null;
    });

    const { ProjectDiagnostics } = await import('./project-diagnostics');
    const diagnostics = new ProjectDiagnostics();

    await diagnostics.runDiagnostics('c:/repo');

    expect(invokeMock).toHaveBeenCalledWith('lsp_begin_project_diagnostics_managed', {
      rootPath: 'c:/repo',
      sidecars: ['css', 'html', 'typescript', 'svelte', 'eslint'],
    });
    expect(problemsStoreMock.markSourceStale).toHaveBeenCalledWith('typescript');
    expect(problemsStoreMock.markSourceStale).toHaveBeenCalledWith('eslint');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('marks cooldown-blocked sources stale when a resumed scheduler run skips them', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_system_info') {
        return { os_name: 'windows' };
      }

      if (command === 'lsp_begin_project_diagnostics_managed') {
        return {
          action: 'run',
          runId: 42,
          rootPath: 'c:/repo',
          delayMs: 0,
          staggerMs: 150,
          sidecars: ['css', 'html'],
          staleSources: ['typescript', 'eslint'],
          freshSources: ['css', 'html'],
        };
      }

      if (command === 'lsp_complete_project_diagnostics_managed') {
        return {
          action: 'noop',
          runId: null,
          rootPath: null,
          delayMs: 0,
          staggerMs: 150,
          sidecars: [],
          staleSources: [],
          freshSources: [],
        };
      }

      return null;
    });
    getAllFilesMock.mockImplementation(
      () => ['c:/repo/src/App.svelte'] as ReturnType<typeof getAllFilesMock>,
    );

    const { ProjectDiagnostics } = await import('./project-diagnostics');
    const diagnostics = new ProjectDiagnostics();

    await diagnostics.runDiagnostics('c:/repo');

    expect(startCssAnalysisMock).toHaveBeenCalledTimes(1);
    expect(startHtmlAnalysisMock).toHaveBeenCalledTimes(1);
    expect(startTsAnalysisMock).not.toHaveBeenCalled();
    expect(startEslintAnalysisMock).not.toHaveBeenCalled();
    expect(problemsStoreMock.markSourceFresh).toHaveBeenCalledWith('css');
    expect(problemsStoreMock.markSourceFresh).toHaveBeenCalledWith('html');
    expect(problemsStoreMock.markSourceStale).toHaveBeenCalledWith('typescript');
    expect(problemsStoreMock.markSourceStale).toHaveBeenCalledWith('eslint');
  });

  it('uses the native diagnostics delay command instead of a frontend timer between sidecars', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_system_info') {
        return { os_name: 'windows' };
      }

      if (command === 'lsp_begin_project_diagnostics_managed') {
        return {
          action: 'run',
          runId: 7,
          rootPath: 'c:/repo',
          delayMs: 0,
          staggerMs: 150,
          sidecars: ['css', 'html'],
          staleSources: [],
          freshSources: ['css', 'html'],
        };
      }

      if (command === 'lsp_complete_project_diagnostics_managed') {
        return {
          action: 'noop',
          runId: null,
          rootPath: null,
          delayMs: 0,
          staggerMs: 150,
          sidecars: [],
          staleSources: [],
          freshSources: [],
        };
      }

      return null;
    });
    getAllFilesMock.mockImplementation(
      () => ['c:/repo/src/App.svelte'] as ReturnType<typeof getAllFilesMock>,
    );

    const { ProjectDiagnostics } = await import('./project-diagnostics');
    const diagnostics = new ProjectDiagnostics();

    await diagnostics.runDiagnostics('c:/repo');

    expect(invokeMock).toHaveBeenCalledWith('lsp_wait_project_diagnostics_delay', {
      delayMs: 150,
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
