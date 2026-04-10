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
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
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

		invokeMock.mockImplementation(async (command: string) => {
			if (command === 'terminal_wait_for_shell_integration') {
				return mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY;
			}
			return null;
		});

		const writeSpy = vi.spyOn(session, 'write').mockResolvedValue(true);

		await expect(session.enableShellIntegration()).resolves.toBe(true);
		expect(writeSpy).toHaveBeenCalledOnce();
		expect(invokeMock).toHaveBeenCalledWith('terminal_wait_for_shell_integration', {
			terminalId: 'term-2',
			timeoutMs: 3000,
		});
		expect(setTimeoutSpy).not.toHaveBeenCalled();
		expect(session.shellIntegrationIdentity).toBe(mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY);
		setTimeoutSpy.mockRestore();
	});

	it('applies shell integration identity from the native ready event payload', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-ready',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		session.handleReadyEvent({
			terminalId: 'term-ready',
			shellIntegrationIdentity: mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY,
		});

		expect(await session.waitForReady(10)).toBe(true);
		expect(session.hasShellIntegration).toBe(true);
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

	it('delegates fallback command execution to the native terminal runner', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-fallback',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		invokeMock.mockImplementation(async (command: string) => {
			if (command === 'terminal_execute_command_fallback') {
				return {
					exitCode: 0,
					output:
						'cmd /c echo RUN_OK\r\n' +
						'RUN_OK\r\n' +
						'__VOLT_EXIT_CODE_0__\r\n' +
						'__VOLT_DONE_native__\r\n' +
						'PS C:/workspace> ',
					cwd: 'C:/workspace',
					timedOut: false,
				};
			}
			return null;
		});

		const writeSpy = vi.spyOn(session, 'write').mockResolvedValue(true);

		await expect(session.executeCommand('cmd /c echo RUN_OK', 1000)).resolves.toMatchObject({
			exitCode: 0,
			timedOut: false,
			cwd: 'C:/workspace',
			output: 'RUN_OK',
		});
		expect(invokeMock).toHaveBeenCalledWith('terminal_execute_command_fallback', {
			terminalId: 'term-fallback',
			command: 'cmd /c echo RUN_OK',
			timeoutMs: 1000,
		});
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('strips prompt noise from fallback output for simple PowerShell commands', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-fallback-clean',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		invokeMock.mockImplementation(async (command: string) => {
			if (command === 'terminal_execute_command_fallback') {
				return {
					exitCode: 0,
					output: '9.9.9\r\nPS C:/workspace> ',
					cwd: 'C:/workspace',
					timedOut: false,
				};
			}
			return null;
		});

		await expect(session.executeCommand('npm -v', 1000)).resolves.toMatchObject({
			exitCode: 0,
			timedOut: false,
			output: '9.9.9',
		});
	});

	it('preserves directory listings from fallback output while removing the trailing prompt', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-fallback-dir',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		invokeMock.mockImplementation(async (command: string) => {
			if (command === 'terminal_execute_command_fallback') {
				return {
					exitCode: 0,
					output:
						' Directory: C:/workspace\r\n' +
						'\r\n' +
						'Mode                LastWriteTime         Length Name\r\n' +
						'----                -------------         ------ ----\r\n' +
						'd----         4/10/2026   1:00 PM                src\r\n' +
						'-a---         4/10/2026   1:00 PM           1234 package.json\r\n' +
						'PS C:/workspace> ',
					cwd: 'C:/workspace',
					timedOut: false,
				};
			}
			return null;
		});

		await expect(session.executeCommand('dir', 1000)).resolves.toMatchObject({
			exitCode: 0,
			timedOut: false,
			output:
				'Directory: C:/workspace\n' +
				'Mode                LastWriteTime         Length Name\n' +
				'----                -------------         ------ ----\n' +
				'd----         4/10/2026   1:00 PM                src\n' +
				'-a---         4/10/2026   1:00 PM           1234 package.json',
		});
	});

	it('waits for terminal output through the native backend helper', async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-output',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		invokeMock.mockImplementation(async (command: string) => {
			if (command === 'terminal_wait_for_output') {
				return 'RUN_OK\r\n';
			}
			return null;
		});

		await expect(session.waitForAnyOutput(15, 1000)).resolves.toBe('RUN_OK\r\n');
		expect(invokeMock).toHaveBeenCalledWith('terminal_wait_for_output', {
			terminalId: 'term-output',
			startOffset: 15,
			timeoutMs: 1000,
		});
		expect(setTimeoutSpy).not.toHaveBeenCalled();
		setTimeoutSpy.mockRestore();
	});

	it('interrupts a terminal through the native backend helper', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-interrupt',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		invokeMock.mockResolvedValue(null);

		await expect(session.interrupt()).resolves.toBe(true);
		expect(invokeMock).toHaveBeenCalledWith('terminal_interrupt', {
			terminalId: 'term-interrupt',
		});
	});

	it('sends Ctrl+C when a command times out', async () => {
		const mod = await import('./terminal-client');
		const session = new mod.TerminalSession({
			terminalId: 'term-5',
			shell: 'powershell.exe',
			cwd: 'C:/workspace',
			cols: 120,
			rows: 30,
		});

		invokeMock.mockImplementation(async (command: string) => {
			if (command === 'terminal_schedule_interrupt') {
				return true;
			}
			return null;
		});

		const writeSpy = vi.spyOn(session, 'write').mockResolvedValue(true);
		session.handleDataEvent({
			terminalId: 'term-5',
			data: `\u001b]633;P;ShellIntegration=${mod.POWERSHELL_SHELL_INTEGRATION_IDENTITY}\u0007`,
		});

		await expect(session.executeCommand('Start-Sleep -Seconds 3', 100)).resolves.toMatchObject({
			exitCode: -1,
			timedOut: true,
		});
		expect(invokeMock).toHaveBeenCalledWith('terminal_schedule_interrupt', {
			terminalId: 'term-5',
			delayMs: 100,
			token: expect.any(Number),
		});
		expect(writeSpy).not.toHaveBeenCalledWith('\u0003');
	});

	it('does not log an error when the Tauri event bridge is unavailable during listener bootstrap', async () => {
		vi.resetModules();
		listenMock.mockRejectedValue(
			new TypeError("Cannot read properties of undefined (reading 'transformCallback')"),
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		(globalThis as typeof globalThis & { __voltTerminalListeners?: unknown }).__voltTerminalListeners =
			undefined;
		vi.stubGlobal('window', {});

		await import('./terminal-client');
		await Promise.resolve();

		expect(errorSpy).not.toHaveBeenCalledWith(
			'[TerminalClient] Failed to start global listeners:',
			expect.anything(),
		);

		errorSpy.mockRestore();
	});
});
