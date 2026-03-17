import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
});
