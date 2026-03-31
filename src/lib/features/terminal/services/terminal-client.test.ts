import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn(async () => () => {});

vi.mock('@tauri-apps/api/core', () => ({
	invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
	listen: listenMock,
}));

vi.mock('$core/services/hmr-cleanup', () => ({
	registerCleanup: vi.fn(),
}));

describe('TerminalSession shell integration', () => {
	beforeEach(() => {
		invokeMock.mockReset();
		listenMock.mockClear();
	});

	it('completes a PowerShell command when the prompt returns without an explicit finish marker', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-1',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		vi.spyOn(session, 'write').mockResolvedValue(true);
		session.handleDataEvent({
			terminalId: 'term-1',
			data: `\u001b]633;P;ShellIntegration=${mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY}\u0007`,
		});

		const completionPromise = session.executeCommand('echo "Terminal test: basic echo works"', 1000);

		session.handleDataEvent({
			terminalId: 'term-1',
			data:
				'Terminal test: basic echo works\r\n' +
				'\u001b]633;P;Cwd=C:/workspace\u0007' +
				'\u001b]633;A\u0007' +
				'\u001b]633;B\u0007' +
				'PS C:/workspace> ',
		});

		await expect(completionPromise).resolves.toMatchObject({
			exitCode: 0,
			timedOut: false,
			cwd: 'C:/workspace',
			output: 'Terminal test: basic echo works',
		});
		expect(session.getLastCommandFinishedAt()).not.toBeNull();
	});

	it('refreshes shell integration when an older identity is already loaded', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-2',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		session.handleDataEvent({
			terminalId: 'term-2',
			data: '\u001b]633;P;ShellIntegration=Volt\u0007',
		});

		const writeSpy = vi.spyOn(session, 'write').mockImplementation(async () => {
			session.handleDataEvent({
				terminalId: 'term-2',
				data: `\u001b]633;P;ShellIntegration=${mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY}\u0007`,
			});
			return true;
		});

		await expect(session.enableShellIntegration()).resolves.toBe(true);
		expect(writeSpy).toHaveBeenCalledOnce();
		expect(session.shellIntegrationIdentity).toBe(mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY);
	});

	it('resolves a pending command when the shell exits before a finish marker arrives', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-3',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		vi.spyOn(session, 'write').mockResolvedValue(true);
		session.handleDataEvent({
			terminalId: 'term-3',
			data: `\u001b]633;P;ShellIntegration=${mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY}\u0007`,
		});

		const completionPromise = session.executeCommand('exit 1', 1000);
		session.handleExitEvent({
			terminalId: 'term-3',
			code: 1,
		});

		await expect(completionPromise).resolves.toMatchObject({
			exitCode: 1,
			timedOut: false,
		});
	});

	it('prefers the explicit finish marker exit code over prompt fallback when both arrive together', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-4',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		vi.spyOn(session, 'write').mockResolvedValue(true);
		session.handleDataEvent({
			terminalId: 'term-4',
			data: `\u001b]633;P;ShellIntegration=${mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY}\u0007`,
		});

		const completionPromise = session.executeCommand(
			`powershell -NoProfile -Command "Write-Error 'RUN_NONZERO'; exit 7"`,
			1000,
		);

		session.handleDataEvent({
			terminalId: 'term-4',
			data:
				"Write-Error 'RUN_NONZERO'; exit 7 : RUN_NONZERO\r\n" +
				'\u001b]633;P;Cwd=C:/workspace\u0007' +
				'\u001b]633;A\u0007' +
				'\u001b]633;B\u0007' +
				'\u001b]633;D;7\u0007' +
				'PS C:/workspace> ',
		});

		await expect(completionPromise).resolves.toMatchObject({
			exitCode: 7,
			timedOut: false,
		});
	});

	it('preserves stdout from cmd /c commands when the prompt returns', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-stdout',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		vi.spyOn(session, 'write').mockResolvedValue(true);
		session.handleDataEvent({
			terminalId: 'term-stdout',
			data: `\u001b]633;P;ShellIntegration=${mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY}\u0007`,
		});

		const completionPromise = session.executeCommand('cmd /c echo RUN_OK', 1000);

		session.handleDataEvent({
			terminalId: 'term-stdout',
			data:
				'RUN_OK\r\n' +
				'\u001b]633;P;Cwd=C:/workspace\u0007' +
				'\u001b]633;A\u0007' +
				'\u001b]633;B\u0007' +
				'\u001b]633;D;0\u0007' +
				'PS C:/workspace> ',
		});

		await expect(completionPromise).resolves.toMatchObject({
			exitCode: 0,
			timedOut: false,
			output: 'RUN_OK',
		});
	});

	it('sends Ctrl+C when a command times out', async () => {
		vi.useFakeTimers();
		try {
			const mod = await import('./terminal-client');
			const session = new mod.TerminalSession({
				terminalId: 'term-5',
				shell: 'powershell.exe',
				cwd: 'C:/workspace',
				cols: 120,
				rows: 30,
			});

			const writeSpy = vi.spyOn(session, 'write').mockResolvedValue(true);
			session.handleDataEvent({
				terminalId: 'term-5',
				data: `\u001b]633;P;ShellIntegration=${mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY}\u0007`,
			});

			const completionPromise = session.executeCommand('Start-Sleep -Seconds 3', 100);
			await vi.advanceTimersByTimeAsync(110);

			await expect(completionPromise).resolves.toMatchObject({
				exitCode: -1,
				timedOut: true,
			});
			expect(writeSpy).toHaveBeenCalledWith('\u0003');
		} finally {
			vi.useRealTimers();
		}
	});
});
