import { describe, expect, it, vi } from 'vitest';
import { terminalStore } from '$features/terminal/stores/terminal.svelte';

vi.mock('$features/terminal/stores/terminal.svelte', () => ({
  terminalStore: {
    sessions: [],
    syncWithBackend: vi.fn(),
    getOrCreateAiTerminal: vi.fn(),
    recreateAiTerminal: vi.fn(),
    setActive: vi.fn(),
    createTerminal: vi.fn(),
    setSessionLabel: vi.fn(),
    killTerminal: vi.fn(),
    activeSession: null,
  },
}));

vi.mock('$shared/stores/project.svelte', () => ({
  projectStore: {
    rootPath: 'C:/workspace',
  },
}));

vi.mock('$shared/stores/ui.svelte', () => ({
  uiStore: {
    openBottomPanelTab: vi.fn(),
  },
}));

vi.mock('$lib/features/assistant/components/panel/terminal-tool-run-coordinator', () => ({
  createTerminalToolRunCoordinator: () => ({
    runForeground: vi.fn(),
  }),
}));

vi.mock('$lib/features/assistant/components/panel/terminal-tool-run-store', () => ({
  createTerminalToolRunStore: () => ({}),
}));

describe('terminal process lifecycle helpers', () => {
  it('marks a tracked process stopped after the terminal reports command completion', async () => {
    const { deriveTrackedProcessFromSessionState } = await import('./terminal');

    const next = deriveTrackedProcessFromSessionState(
      {
        processId: 7,
        command: 'cmd /c "echo done"',
        cwd: 'C:/workspace',
        startTime: 1000,
        status: 'running',
        terminalId: 'term-1',
      },
      {
        getLastCommandStartedAt: () => 1200,
        getLastCommandFinishedAt: () => 1800,
      },
    );

    expect(next.status).toBe('stopped');
  });

  it('keeps long-running processes marked running until the command actually finishes', async () => {
    const { deriveTrackedProcessFromSessionState } = await import('./terminal');

    const next = deriveTrackedProcessFromSessionState(
      {
        processId: 9,
        command: 'npm run dev',
        cwd: 'C:/workspace',
        startTime: 1000,
        status: 'running',
        terminalId: 'term-2',
      },
      {
        getLastCommandStartedAt: () => 1200,
        getLastCommandFinishedAt: () => null,
      },
    );

    expect(next.status).toBe('running');
  });

  it('passes runtime updates through the terminal coordinator path', async () => {
    const { handleRunCommandThroughCoordinatorForTest } = await import('./terminal');

    const coordinator = {
      runForeground: vi.fn().mockResolvedValue({
        success: true,
        output: 'done',
      }),
    };
    const runtime = { onUpdate: vi.fn() };

    await handleRunCommandThroughCoordinatorForTest(
      coordinator,
      { command: 'echo hi', cwd: 'C:/workspace' },
      runtime,
    );

    expect(coordinator.runForeground).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'echo hi',
        cwd: 'C:/workspace',
        runtime,
      }),
    );
  });

  it('enables shell integration for PowerShell background process terminals', async () => {
    const session = {
      id: 'term-proc',
      info: { shell: 'powershell.exe', cwd: 'C:/workspace' },
      cwd: 'C:/workspace',
      hasShellIntegration: false,
      shellIntegrationIdentity: null,
      waitForReady: vi.fn().mockResolvedValue(true),
      enableShellIntegration: vi.fn().mockResolvedValue(true),
      write: vi.fn().mockResolvedValue(true),
      waitForAnyOutput: vi.fn().mockResolvedValue('BG_OK'),
      waitForOutput: vi.fn().mockResolvedValue('BG_OK'),
      getOutputCursor: vi.fn().mockReturnValue(0),
      getCleanOutputSince: vi.fn().mockReturnValue('BG_OK'),
      onExit: vi.fn(),
    };

    (terminalStore.createTerminal as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (terminalStore.sessions as unknown as Array<unknown>).length = 0;
    (terminalStore.sessions as unknown as Array<unknown>).push(session);

    const { handleStartProcess } = await import('./terminal');
    const result = await handleStartProcess({
      command: `powershell -NoProfile -Command "Write-Output 'BG_OK'; Start-Sleep -Milliseconds 200"`,
      cwd: 'C:/workspace',
    });

    expect(result.success).toBe(true);
    expect(session.enableShellIntegration).toHaveBeenCalled();
    expect(session.waitForAnyOutput).toHaveBeenCalledWith(0, 4000);
    expect(session.waitForOutput).not.toHaveBeenCalled();
  });

  it('interrupts a tracked process through the native terminal session path before killing the terminal', async () => {
    const session = {
      id: 'term-stop',
      info: { shell: 'powershell.exe', cwd: 'C:/workspace' },
      cwd: 'C:/workspace',
      hasShellIntegration: true,
      shellIntegrationIdentity: 'Volt/2',
      waitForReady: vi.fn().mockResolvedValue(true),
      enableShellIntegration: vi.fn().mockResolvedValue(true),
      write: vi.fn().mockResolvedValue(true),
      interrupt: vi.fn().mockResolvedValue(true),
      waitForAnyOutput: vi.fn().mockResolvedValue('BG_OK'),
      waitForOutput: vi.fn().mockResolvedValue('BG_OK'),
      getOutputCursor: vi.fn().mockReturnValue(0),
      getCleanOutputSince: vi.fn().mockReturnValue('BG_OK'),
      onExit: vi.fn(),
      getLastCommandStartedAt: vi.fn().mockReturnValue(1200),
      getLastCommandFinishedAt: vi.fn().mockReturnValue(null),
    };

    (terminalStore.sessions as unknown as Array<unknown>).length = 0;
    (terminalStore.sessions as unknown as Array<unknown>).push(session);
    (terminalStore.createTerminal as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (terminalStore.killTerminal as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { handleStartProcess, handleStopProcess } = await import('./terminal');
    const startResult = await handleStartProcess({
      command: `powershell -NoProfile -Command "Write-Output 'BG_OK'; Start-Sleep -Milliseconds 200"`,
      cwd: 'C:/workspace',
    });

    expect(startResult.success).toBe(true);
    expect(startResult.meta?.processId).toBeTypeOf('number');

    const stopResult = await handleStopProcess({ processId: startResult.meta?.processId });

    expect(stopResult.success).toBe(true);
    expect(session.interrupt).toHaveBeenCalledTimes(1);
    expect(session.write).not.toHaveBeenCalledWith('\x03');
    expect(terminalStore.killTerminal).toHaveBeenCalledWith('term-stop');
  });
});
