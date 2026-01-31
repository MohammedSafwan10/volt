/**
 * Terminal tool handlers - Kiro-style with background process management
 * 
 * Tools:
 * - run_command: Execute command and wait for completion
 * - start_process: Start background process (dev servers, watchers)
 * - stop_process: Stop a background process
 * - list_processes: List all running background processes
 * - get_process_output: Read output from a specific process
 * - read_terminal: Read recent terminal output (legacy)
 */

import { terminalStore } from '$lib/stores/terminal.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { projectDiagnostics } from '$lib/services/project-diagnostics';
import { uiStore } from '$lib/stores/ui.svelte';
import { logOutput } from '$lib/stores/output.svelte';
import type { TerminalSession } from '$lib/services/terminal-client';
import { truncateOutput, extractErrorMessage, type ToolResult } from '../utils';

/**
 * Get or create a dedicated terminal for a background process.
 */
async function getProcessTerminal(processId: number, cwd?: string): Promise<TerminalSession> {
  const proc = processes.get(processId);
  if (proc?.terminalId) {
    const session = terminalStore.sessions.find(s => s.id === proc.terminalId);
    if (session) {
      terminalStore.setActive(session.id);
      return session;
    }
  }

  // Create a new one if not found
  const session = await terminalStore.createTerminal(cwd);
  if (!session) {
    throw new Error('Failed to create process terminal session');
  }

  terminalStore.setSessionLabel(session.id, `Volt Proc: ${processId}`);
  terminalStore.setActive(session.id);

  await session.waitForReady(3000);
  return session;
}

// ============================================
// Background Process Tracking
// ============================================

interface BackgroundProcess {
  processId: number;
  command: string;
  cwd: string | undefined;
  startTime: number;
  status: 'running' | 'stopped' | 'unknown';
  terminalId?: string;
}

const STORAGE_KEY = 'volt.ai.processes';

class ProcessStore {
  private _processes = new Map<number, BackgroundProcess>();
  private _nextProcessId = 1;

  constructor() {
    this.load();
  }

  private load(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return;

      const parsed = JSON.parse(data) as { processes: BackgroundProcess[]; nextId: number };
      this._nextProcessId = parsed.nextId || 1;

      for (const proc of parsed.processes) {
        const terminalExists = proc.terminalId
          ? terminalStore.sessions.some(s => s.id === proc.terminalId)
          : false;

        this._processes.set(proc.processId, {
          ...proc,
          status: terminalExists ? proc.status : 'unknown'
        });
      }
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  private save(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const data = {
        processes: Array.from(this._processes.values()),
        nextId: this._nextProcessId
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore storage errors
    }
  }

  get(processId: number): BackgroundProcess | undefined {
    return this._processes.get(processId);
  }

  set(processId: number, process: BackgroundProcess): void {
    this._processes.set(processId, process);
    this.save();
  }

  delete(processId: number): boolean {
    const result = this._processes.delete(processId);
    if (result) this.save();
    return result;
  }

  getAll(): BackgroundProcess[] {
    return Array.from(this._processes.values());
  }

  getRunningCount(): number {
    return this.getAll().filter(p => p.status === 'running').length;
  }

  get size(): number {
    return this._processes.size;
  }

  values(): IterableIterator<BackgroundProcess> {
    return this._processes.values();
  }

  nextProcessId(): number {
    const id = this._nextProcessId++;
    this.save();
    return id;
  }
}

const processStore = new ProcessStore();

// Backward compatibility: expose Map-like interface
const processes = {
  get: (id: number) => processStore.get(id),
  set: (id: number, proc: BackgroundProcess) => { processStore.set(id, proc); return processes; },
  delete: (id: number) => processStore.delete(id),
  get size() { return processStore.size; },
  values: () => processStore.values()
};

// ============================================
// Tool Handlers
// ============================================

/**
 * Run a shell command and wait for completion using a UUID sentinel
 */
export async function handleRunCommand(args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command);
  const cwd = args.cwd ? String(args.cwd) : undefined;
  const timeout = Number(args.timeout) || 300000;

  try {
    // Ensure terminal panel is open so user sees progress
    uiStore.openBottomPanelTab('terminal');

    // Get or create the shared AI terminal
    const session = await terminalStore.getOrCreateAiTerminal(cwd);
    if (!session) {
      return { success: false, error: 'Failed to access AI terminal' };
    }

    // Switch to this terminal in the UI
    terminalStore.setActive(session.id);

    console.log(`[TerminalTool] Executing command: "${command}" in cwd: "${cwd || session.cwd || session.info.cwd}"`);

    // If a different CWD is requested, cd there first
    const currentCwd = session.cwd || session.info.cwd;
    if (cwd && currentCwd !== cwd) {
      const safeCwd = cwd.replace(/'/g, "''");
      await session.write(`Set-Location -LiteralPath '${safeCwd}'\r`);
      // Wait a bit for the CWD to update
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Heuristic: Warn if running a command that looks like a dev server in run_command
    const isDevServer = /\b(dev|serve|start|watch)\b/i.test(command) && command.includes('npm') || command.includes('yarn');
    if (isDevServer) {
      logOutput('Volt', `Warning: Running potential long-running command "${command}" in run_command. If this is a server, use start_process instead.`);
    }

    // 195: Execute the command using smart shell integration (OSC 633)
    // We add a "smart detach" race: if it looks like a dev server and shows "Ready" output, 
    // we return early so the AI doesn't get stuck.

    const executionPromise = session.executeCommand(command, timeout);

    // Poller for "Ready" signals in long-running commands
    const detectionPromise = (async () => {
      const waitTime = isDevServer ? 8000 : 15000;
      const startTime = Date.now();
      const startOffset = session.getRecentOutput().length;

      while (Date.now() - startTime < waitTime) {
        await new Promise(r => setTimeout(r, 500));
        const output = session.getCleanOutputSince(startOffset);

        // Typical "Server is ready" patterns
        const isReady = /\b(ready|started|listening|localhost:|0\.0\.0\.0:)\b/i.test(output);

        if (isReady && Date.now() - startTime > 2000) { // Give it at least 2s to show initial errors
          return { ready: true, output };
        }
      }
      return { ready: false };
    })();

    const result = await Promise.race([
      executionPromise.then(r => ({ type: 'completion' as const, data: r })),
      detectionPromise.then(r => ({ type: 'detection' as const, data: r }))
    ]);

    let finalOutput = '';
    let success = false;
    let isDetached = false;

    if (result.type === 'completion') {
      finalOutput = result.data.output;
      success = result.data.exitCode === 0 && !result.data.timedOut;
    } else {
      if (result.data.ready) {
        finalOutput = result.data.output + '\n\n[Volt AI]: Detected server startup. Detaching to let it run in background.';
        success = true;
        isDetached = true;
      } else {
        // Detection timed out, wait for actual completion
        const finalResult = await executionPromise;
        finalOutput = finalResult.output;
        success = finalResult.exitCode === 0 && !finalResult.timedOut;
      }
    }

    const { text, truncated } = truncateOutput(finalOutput);

    const toolResult = {
      success,
      output: text.trim() || (success ? '[Success - no output]' : '[Failed - no output]'),
      truncated,
      meta: {
        exitCode: result.type === 'completion' ? result.data.exitCode : 0,
        timedOut: result.type === 'completion' ? result.data.timedOut : false,
        terminalId: session.id,
        isDevServer,
        isDetached,
        hasError: !success || /\b(error|failed|exception)\b/i.test(finalOutput)
      }
    };

    // Improve timeout message for humans/AI
    if (toolResult.meta.timedOut) {
      toolResult.output = `Command timed out after ${timeout}ms. Output so far:\n\n${toolResult.output}`;
      if (isDevServer) {
        toolResult.output += `\n\nNOTE: This looks like a dev server. Please use the 'start_process' tool for long-running processes that don't exit naturally.`;
      }
    }

    // Notify store of errors for the "Fix with AI" feature
    if (!toolResult.success && !isDetached) {
      terminalStore.lastError = {
        terminalId: session.id,
        command,
        output: finalOutput
      };
    }

    if (projectStore.rootPath) {
      void projectDiagnostics.runDiagnostics(projectStore.rootPath);
    }

    return toolResult;
  } catch (err) {
    return { success: false, error: `Command execution failed: ${extractErrorMessage(err)}` };
  }
}

/**
 * Start a long-running background process in a dedicated terminal
 */
export async function handleStartProcess(args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command);
  const cwd = args.cwd ? String(args.cwd) : undefined;
  const processId = processStore.nextProcessId();

  try {
    // Ensure terminal panel is open
    uiStore.openBottomPanelTab('terminal');

    // Create dedicated terminal for this process
    const session = await getProcessTerminal(processId, cwd);
    const terminalId = session.id;

    // Track it
    processes.set(processId, {
      processId,
      command,
      cwd,
      startTime: Date.now(),
      status: 'running',
      terminalId
    });

    // Handle process exit
    session.onExit((code) => {
      const p = processStore.get(processId);
      if (p) {
        p.status = 'stopped';
        processStore.set(processId, p);
      }
    });

    const startOffset = session.getRecentOutput().length;

    // Send command
    const writeSuccess = await session.write(command + '\r');
    if (!writeSuccess) {
      throw new Error(`Failed to write command to terminal ${terminalId}`);
    }

    // Wait for initial output (more responsive than fixed 2s)
    let output = '';
    try {
      // Use the captured offset to only look for output produced AFTER the write
      output = await session.waitForOutput((out) => {
        return out.trim().length > 0;
      }, 4000, startOffset);
    } catch {
      // If no new output, fall back to recent output from that offset onwards
      output = session.getRecentOutput().slice(startOffset);
    }

    const cleaned = session.getCleanOutputSince(startOffset);

    return {
      success: true,
      output: `Started process ${processId} in terminal ${terminalId}.\n\nInitial Output:\n${cleaned || '(No output yet)'}`,
      meta: { processId, terminalId }
    };
  } catch (err) {
    return { success: false, error: `Failed to start process: ${err}` };
  }
}

/**
 * Stop a background process
 */
export async function handleStopProcess(args: Record<string, unknown>): Promise<ToolResult> {
  const processId = Number(args.processId);
  const proc = processes.get(processId);

  if (!proc) {
    return { success: false, error: `Process ${processId} not found` };
  }

  try {
    if (proc.terminalId) {
      const session = terminalStore.sessions.find(s => s.id === proc.terminalId);
      if (session) {
        await session.write('\x03'); // Ctrl+C
      }
      // Kill the terminal entirely
      await terminalStore.killTerminal(proc.terminalId);
    }

    proc.status = 'stopped';
    return { success: true, output: `Process ${processId} stopped and terminal closed.` };
  } catch (err) {
    return { success: false, error: `Failed to stop process: ${err}` };
  }
}

/**
 * List all background processes
 */
export async function handleListProcesses(): Promise<ToolResult> {
  if (processes.size === 0) {
    return { success: true, output: 'No background processes tracked' };
  }

  const lines = [];
  for (const proc of processes.values()) {
    const elapsed = Date.now() - proc.startTime;
    lines.push(`[${proc.processId}] ${proc.status.toUpperCase()} - ${proc.command} (${formatDuration(elapsed)})`);
  }

  return {
    success: true,
    output: `Background processes:\n${lines.join('\n')}`
  };
}

/**
 * Get output from a background process
 */
export async function handleGetProcessOutput(args: Record<string, unknown>): Promise<ToolResult> {
  const processId = Number(args.processId);
  const maxLines = Number(args.maxLines) || 100;
  const proc = processes.get(processId);

  if (!proc) {
    return { success: false, error: `Process ${processId} not found` };
  }

  try {
    const session = proc.terminalId
      ? terminalStore.sessions.find(s => s.id === proc.terminalId)
      : null;

    if (!session) {
      return { success: false, error: 'Process terminal no longer exists' };
    }

    const cleaned = session.getRecentCleanOutput(maxLines * 200); // Rough estimate for lines
    const lines = cleaned.split('\n');
    const recent = lines.slice(-maxLines).join('\n');

    const { text, truncated } = truncateOutput(recent);

    return {
      success: true,
      output: text || '(No output yet)',
      truncated,
      meta: { processId, status: proc.status }
    };
  } catch (err) {
    return { success: false, error: `Failed to get output: ${extractErrorMessage(err)}` };
  }
}

/**
 * Send raw input to a terminal process
 */
export async function handleSendTerminalInput(args: Record<string, unknown>): Promise<ToolResult> {
  const text = String(args.text);
  const processId = Number(args.processId);

  let session: TerminalSession | undefined;

  if (processId && !isNaN(processId)) {
    const proc = processes.get(processId);
    if (proc?.terminalId) {
      session = terminalStore.sessions.find(s => s.id === proc.terminalId);
    }
  } else {
    // Default to active session if it's an AI session
    session = terminalStore.activeSession ?? undefined;
  }

  if (!session) {
    return { success: false, error: 'No active session found to send input to' };
  }

  try {
    await session.write(text + '\r');
    return { success: true, output: `Sent input to terminal: ${text}` };
  } catch (err) {
    return { success: false, error: `Failed to send input: ${err}` };
  }
}

/**
 * Read recent terminal output
 */
export async function handleReadTerminal(args: Record<string, unknown>): Promise<ToolResult> {
  const maxLines = Number(args.maxLines) || 100;
  const session = terminalStore.activeSession;

  if (!session) {
    return { success: false, output: 'No terminal session active.' };
  }

  const cleaned = session.getRecentCleanOutput(maxLines * 200);
  const lines = cleaned.split('\n').slice(-maxLines).join('\n');

  return {
    success: true,
    output: lines || '(Empty output)'
  };
}

// ============================================
// Helper functions
// ============================================

/**
 * Format duration
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
