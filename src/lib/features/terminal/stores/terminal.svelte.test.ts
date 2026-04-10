import { beforeEach, describe, expect, it, vi } from 'vitest';

const createTerminalSessionMock = vi.fn();
const listTerminalsMock = vi.fn();
const listTerminalSnapshotsMock = vi.fn();
const startProblemMatcherMock = vi.fn(async () => {});
const createTerminalSessionFromSnapshotMock = vi.fn();

vi.mock('$features/terminal/services/terminal-client', () => ({
	createTerminalSession: createTerminalSessionMock,
	createTerminalSessionFromInfo: vi.fn(),
	createTerminalSessionFromSnapshot: createTerminalSessionFromSnapshotMock,
	listTerminals: listTerminalsMock,
	listTerminalSnapshots: listTerminalSnapshotsMock,
	killAllTerminals: vi.fn(async () => true),
	TerminalSession: class {},
}));

vi.mock('$features/terminal/services/terminal-problem-matcher', () => ({
	terminalProblemMatcher: {
		start: startProblemMatcherMock,
	},
}));

vi.mock('$core/services/hmr-cleanup', () => ({
	registerCleanup: vi.fn(),
}));

vi.mock('$shared/stores/project.svelte', () => ({
	projectStore: {
		rootPath: 'C:/workspace',
		initialized: Promise.resolve(),
	},
}));

describe('terminalStore syncWithBackend', () => {
	beforeEach(() => {
		vi.resetModules();
		createTerminalSessionMock.mockReset();
		listTerminalsMock.mockReset();
		listTerminalSnapshotsMock.mockReset();
		createTerminalSessionFromSnapshotMock.mockReset();
		startProblemMatcherMock.mockClear();
		vi.stubGlobal('window', {});
	});

	it('ignores unavailable backend terminal lists without logging retry failures', async () => {
		listTerminalsMock.mockResolvedValue(undefined);
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const { terminalStore } = await import('./terminal.svelte');
		await terminalStore.syncWithBackend();

		expect(terminalStore.sessions).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalledWith(
			'[TerminalStore] syncWithBackend attempt failed:',
			expect.anything(),
			expect.anything(),
		);

		warnSpy.mockRestore();
	});

	it('rehydrates backend terminals through the managed snapshot command', async () => {
		const restoredSession = {
			id: 'terminal-1',
			dispose: vi.fn(),
			onExit: vi.fn(),
		};
		listTerminalSnapshotsMock.mockResolvedValue([
			{
				info: {
					terminalId: 'terminal-1',
					shell: 'powershell.exe',
					cwd: 'C:/workspace',
					cols: 120,
					rows: 30,
				},
				scrollback: 'restored output',
			},
		]);
		createTerminalSessionFromSnapshotMock.mockResolvedValue(restoredSession);

		const { terminalStore } = await import('./terminal.svelte');
		await terminalStore.ensureSynced();

		expect(listTerminalSnapshotsMock).toHaveBeenCalled();
		expect(createTerminalSessionFromSnapshotMock).toHaveBeenCalledWith({
			info: {
				terminalId: 'terminal-1',
				shell: 'powershell.exe',
				cwd: 'C:/workspace',
				cols: 120,
				rows: 30,
			},
			scrollback: 'restored output',
		});
		expect(listTerminalsMock).not.toHaveBeenCalled();
		expect(terminalStore.sessions).toHaveLength(1);
	});

	it('does not wait on frontend bootstrap delays when the AI terminal already has shell integration', async () => {
		const waitForReadyMock = vi.fn(async () => true);
		const enableShellIntegrationMock = vi.fn(async () => true);
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

		createTerminalSessionMock.mockResolvedValue({
			id: 'terminal-ai',
			cwd: 'C:/workspace',
			info: {
				terminalId: 'terminal-ai',
				shell: 'powershell.exe',
				cwd: 'C:/workspace',
				cols: 120,
				rows: 30,
			},
			hasShellIntegration: true,
			waitForReady: waitForReadyMock,
			enableShellIntegration: enableShellIntegrationMock,
			getOutputCharCount: vi.fn(() => 0),
			onExit: vi.fn(),
			dispose: vi.fn(),
		});
		listTerminalSnapshotsMock.mockResolvedValue([]);

		const { terminalStore } = await import('./terminal.svelte');
		(terminalStore as any).startupSyncComplete = true;
		vi.spyOn(terminalStore as any, 'syncWithBackend').mockResolvedValue(undefined);
		setTimeoutSpy.mockClear();

		await terminalStore.getOrCreateAiTerminal();

		expect(waitForReadyMock).toHaveBeenCalledWith(3000);
		expect(enableShellIntegrationMock).not.toHaveBeenCalled();
		expect(
			setTimeoutSpy.mock.calls.some(([, delay]) => delay === 180 || delay === 60),
		).toBe(false);

		setTimeoutSpy.mockRestore();
	});
});
