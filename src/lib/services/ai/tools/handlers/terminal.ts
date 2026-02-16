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

let aiCommandQueue: Promise<ToolResult> = Promise.resolve({ success: true, output: '' });
const recentAiCommands = new Map<string, { command: string; timestamp: number }>();
const AI_QUEUE_WAIT_TIMEOUT_MS = 45_000;
const AI_COMMAND_HARD_CAP_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    })
  ]);
}

function isLikelyDevServer(command: string): boolean {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return false;

  const npmRun = /\b(npm|pnpm|yarn)\s+(run\s+)?(dev|serve|start|preview|watch)\b/i;
  const common = /\b(vite|next\s+dev|nuxt\s+dev|astro\s+dev|svelte-kit\s+dev|react-scripts\s+start|ng\s+serve|nx\s+serve|bun\s+run\s+dev|deno\s+task\s+dev)\b/i;
  const avoid = /\b(npm|pnpm|yarn)\s+install\b/i;

  if (avoid.test(cmd)) return false;
  return npmRun.test(cmd) || common.test(cmd);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

function getBlockedCommandReason(command: string): string | null {
  const normalized = normalizeCommand(command);

  // Protect Volt metadata/project control directory from AI shell mutations.
  const mutatingShellVerb =
    /\b(move-item|rename-item|remove-item|del|erase|rmdir|rd|rm|mv|ren)\b/i;
  const touchesVoltDir = /(^|[\s"'`\\\/])\.volt([\\\/\s"'`]|$)/i.test(command);
  if (touchesVoltDir && mutatingShellVerb.test(command)) {
    return 'Blocked unsafe command: modifying `.volt` is not allowed because it can break plans/chat state.';
  }

  // Common failure mode: create-next-app in current directory conflicts with `.volt`.
  // Force safer scaffolding flow in a temp/sub folder.
  if (
    /\bcreate-next-app(?:@[\w.-]+)?\b/i.test(normalized) &&
    /(?:^|\s)\.(?:\s|$)/.test(normalized)
  ) {
    return 'Blocked unsafe scaffold target: do not run create-next-app in `.`. Scaffold into a temp/subfolder and move app files instead.';
  }

  return null;
}

function extractPort(command: string): number | null {
  const direct = command.match(/(?:--port|-p)\s*=?\s*(\d{2,5})/i);
  if (direct) return Number(direct[1]);
  const env = command.match(/\bPORT\s*=\s*(\d{2,5})/i);
  if (env) return Number(env[1]);
  return null;
}

function normalizeLoopbackHost(url: string): string {
  return url
    .replace('0.0.0.0', 'localhost')
    .replace('[::]', 'localhost')
    .replace('::1', 'localhost');
}

function extractLocalhostUrls(text: string): string[] {
  if (!text) return [];
  const urls = new Set<string>();

  const direct = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|::1)(?::\d{2,5})?(?:\/[^\s"'<>]*)?/gi) || [];
  for (const url of direct) urls.add(normalizeLoopbackHost(url));

  const hostPort = text.match(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|::1):\d{2,5}(?:\/[^\s"'<>]*)?/gi) || [];
  for (const hp of hostPort) urls.add(normalizeLoopbackHost(`http://${hp}`));

  return [...urls];
}

function inferDefaultDevPort(command: string): number | null {
  const cmd = command.toLowerCase();
  if (/\bnext\s+dev\b/.test(cmd)) return 3000;
  if (/\breact-scripts\s+start\b/.test(cmd)) return 3000;
  if (/\bng\s+serve\b/.test(cmd)) return 4200;
  if (/\bnuxt\s+dev\b/.test(cmd)) return 3000;
  if (/\bastro\s+dev\b/.test(cmd)) return 4321;
  if (/\bvite\b/.test(cmd) || /\b(?:npm|pnpm|yarn)\s+(run\s+)?dev\b/.test(cmd)) return 5173;
  return null;
}

function inferDevServerUrl(command: string): string | null {
  const explicit = extractPort(command);
  if (explicit) return `http://localhost:${explicit}`;
  const inferred = inferDefaultDevPort(command);
  return inferred ? `http://localhost:${inferred}` : null;
}

function updateProcessDetectedUrl(process: BackgroundProcess, output: string): BackgroundProcess {
  const detectedFromOutput = extractLocalhostUrls(output)[0];
  const detectedUrl =
    detectedFromOutput ||
    process.detectedUrl ||
    inferDevServerUrl(process.command) ||
    undefined;

  const next: BackgroundProcess = { ...process, detectedUrl };
  processStore.set(process.processId, next);
  return next;
}

function findRunningDevServer(command: string, cwd?: string): BackgroundProcess | null {
  const normalized = normalizeCommand(command);
  const desiredPort = extractPort(command);
  for (const proc of processes.values()) {
    if (proc.status !== 'running') continue;
    if (normalizeCommand(proc.command) !== normalized) continue;
    if (cwd && proc.cwd && proc.cwd !== cwd) continue;
    if (desiredPort && proc.port && proc.port !== desiredPort) continue;
    if (!proc.terminalId) continue;
    const session = terminalStore.sessions.find(s => s.id === proc.terminalId);
    if (!session) continue;
    return proc;
  }
  return null;
}

function trackDetachedProcess(command: string, cwd: string | undefined, terminalId: string): BackgroundProcess {
  const processId = processStore.nextProcessId();
  const proc: BackgroundProcess = {
    processId,
    command,
    cwd,
    startTime: Date.now(),
    status: 'running',
    terminalId,
    port: extractPort(command) ?? undefined,
    detectedUrl: inferDevServerUrl(command) ?? undefined,
  };
  processes.set(processId, proc);

  const session = terminalStore.sessions.find(s => s.id === terminalId);
  if (session) {
    session.onExit(() => {
      const p = processStore.get(processId);
      if (p) {
        p.status = 'stopped';
        processStore.set(processId, p);
      }
    });
  }

  return proc;
}

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
  port?: number;
  detectedUrl?: string;
}

const STORAGE_KEY = 'volt.ai.processes';
const STALE_ORPHAN_PROCESS_AGE_MS = 2 * 60 * 60 * 1000; // 2h
const STOPPED_PROCESS_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_TRACKED_PROCESSES = 200;

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
        // Do not infer unknown/running here because terminal sessions may not be
        // hydrated yet at module init; reconciliation is done lazily per tool call.
        this._processes.set(proc.processId, { ...proc });
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

  entries(): IterableIterator<[number, BackgroundProcess]> {
    return this._processes.entries();
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

async function reconcileTrackedProcesses(): Promise<void> {
  await terminalStore.syncWithBackend();

  const now = Date.now();
  const all = processStore.getAll();
  const liveTerminalIds = new Set(terminalStore.sessions.map((s) => s.id));

  for (const proc of all) {
    const hasTerminal = proc.terminalId ? liveTerminalIds.has(proc.terminalId) : false;
    const ageMs = now - proc.startTime;

    if (proc.status === 'running' && !hasTerminal) {
      // Orphaned running process: likely stale persisted state after reload/crash.
      // Keep briefly as unknown, then auto-stop.
      if (ageMs > STALE_ORPHAN_PROCESS_AGE_MS) {
        processStore.set(proc.processId, { ...proc, status: 'stopped' });
      } else {
        processStore.set(proc.processId, { ...proc, status: 'unknown' });
      }
      continue;
    }

    if (proc.status === 'unknown' && hasTerminal) {
      processStore.set(proc.processId, { ...proc, status: 'running' });
    }
  }

  // Prune old stopped entries so the list doesn't grow forever.
  const sorted = processStore
    .getAll()
    .sort((a, b) => b.startTime - a.startTime);

  const keep = new Set<number>();
  for (const proc of sorted) {
    const ageMs = now - proc.startTime;
    const keepByAge =
      proc.status === 'running' ||
      proc.status === 'unknown' ||
      ageMs <= STOPPED_PROCESS_RETENTION_MS;
    if (keepByAge && keep.size < MAX_TRACKED_PROCESSES) {
      keep.add(proc.processId);
    }
  }

  for (const [id] of processStore.entries()) {
    if (!keep.has(id)) {
      processStore.delete(id);
    }
  }
}

// ============================================
// Tool Handlers
// ============================================

/**
 * Run a shell command and wait for completion using a UUID sentinel
 */
export async function handleRunCommand(args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command).trim();
  const cwd = args.cwd ? String(args.cwd) : undefined;
  const timeout = typeof args.timeout === 'number' ? args.timeout : 90_000;
  const waitForExit = args.waitForExit === true;
  const allowDetach = args.detached !== false;
  const isDevServer = isLikelyDevServer(command);
  const blockedReason = getBlockedCommandReason(command);
  if (blockedReason) {
    return {
      success: false,
      error: blockedReason,
      output:
        'Suggested safe flow:\n1) Scaffold in `./_scaffold_tmp`.\n2) Copy generated app files into workspace (exclude `.volt`).\n3) Delete temp folder.',
      code: 'COMMAND_BLOCKED',
      retryable: false
    };
  }

  const run = async (): Promise<ToolResult> => {
    try {
      if (isDevServer) {
        const running = findRunningDevServer(command, cwd);
        if (running?.terminalId) {
          terminalStore.setActive(running.terminalId);
          const urlHint = running.detectedUrl ? ` URL: ${running.detectedUrl}.` : '';
          return {
            success: true,
            output: `Dev server already running (process ${running.processId}) in terminal ${running.terminalId}.${urlHint} Reusing existing server.`,
            meta: {
              reused: true,
              processId: running.processId,
              terminalId: running.terminalId,
              detectedUrl: running.detectedUrl,
            }
          };
        }
      }

      if (isDevServer && allowDetach && !waitForExit) {
        const result = await handleStartProcess({ command, cwd });
        if (result.success) {
          result.output = `Detected long-running server command. Started as background process.\n\n${result.output}`;
          result.meta = { ...(result.meta ?? {}), autoDetached: true };
        }
        return result;
      }

      // Ensure terminal panel is open so user sees progress
      uiStore.openBottomPanelTab('terminal');

      // Get or create the shared AI terminal
      const session = await terminalStore.getOrCreateAiTerminal(cwd);
      if (!session) {
        return { success: false, error: 'Failed to access AI terminal' };
      }

      await session.waitForReady(3000);
      if (!session.hasShellIntegration) {
        await session.enableShellIntegration();
      }

      // Switch to this terminal in the UI
      terminalStore.setActive(session.id);

      const slowListPatterns = [/\bls\s+-R\b/i, /\bdir\s+\/s\b/i, /\bGet-ChildItem\b.*-Recurse/i];
      if (slowListPatterns.some((pattern) => pattern.test(command))) {
        return {
          success: true,
          output: 'Skipping slow recursive listing. Use get_file_tree for a fast, structured tree output instead.',
          meta: { terminalId: session.id, skipped: true }
        };
      }

      const now = Date.now();
      const normalizedCommand = normalizeCommand(command);
      const recent = recentAiCommands.get(session.id);
      if (recent && recent.command === normalizedCommand && now - recent.timestamp < 300) {
        return {
          success: true,
          output: `[Volt]: Skipped duplicate command (debounced): ${command}`,
          meta: { terminalId: session.id, debounced: true }
        };
      }
      recentAiCommands.set(session.id, { command: normalizedCommand, timestamp: now });

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

      const toolResult: ToolResult = {
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
      if (toolResult.meta?.timedOut) {
        toolResult.output = `Command timed out after ${timeout}ms. Output so far:\n\n${toolResult.output}`;
        if (isDevServer) {
          toolResult.output += `\n\nNOTE: This looks like a dev server. Please use the 'start_process' tool for long-running processes that don't exit naturally.`;
        }
      }

      // If the command detached (likely a long-running server) or timed out,
      // detach the AI terminal so the next command gets a fresh shell.
      if (isDetached || toolResult.meta?.timedOut) {
        terminalStore.detachAiTerminal(session.id, isDetached ? 'Volt AI (running)' : 'Volt AI (busy)');
      }

      if (isDetached) {
        const proc = trackDetachedProcess(command, cwd, session.id);
        toolResult.meta = { ...(toolResult.meta ?? {}), processId: proc.processId };
        toolResult.output = `${toolResult.output}\n\n[Volt]: Tracking background process ${proc.processId} in terminal ${session.id}.`;
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
  };

  const queueReady = withTimeout(
    aiCommandQueue,
    AI_QUEUE_WAIT_TIMEOUT_MS,
    {
      success: false,
      error: `Previous AI terminal command was stuck for over ${AI_QUEUE_WAIT_TIMEOUT_MS}ms; skipping queue wait.`,
      retryable: true
    } satisfies ToolResult
  );

  aiCommandQueue = queueReady.then(
    () =>
      withTimeout(
        run(),
        Math.max(timeout + 10_000, AI_COMMAND_HARD_CAP_MS),
        {
          success: false,
          error:
            'AI terminal command exceeded hard execution cap and was aborted to prevent queue lock.',
          retryable: true
        } satisfies ToolResult
      ),
    () =>
      withTimeout(
        run(),
        Math.max(timeout + 10_000, AI_COMMAND_HARD_CAP_MS),
        {
          success: false,
          error:
            'AI terminal command exceeded hard execution cap and was aborted to prevent queue lock.',
          retryable: true
        } satisfies ToolResult
      )
  );
  return aiCommandQueue;
}

/**
 * Start a long-running background process in a dedicated terminal
 */
export async function handleStartProcess(args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command);
  const cwd = args.cwd ? String(args.cwd) : undefined;
  const blockedReason = getBlockedCommandReason(command);
  if (blockedReason) {
    return {
      success: false,
      error: blockedReason,
      output:
        'Use a safe non-destructive command. For scaffolding, run in a temp/subfolder first.',
      code: 'COMMAND_BLOCKED',
      retryable: false
    };
  }

  try {
    await reconcileTrackedProcesses();

    if (isLikelyDevServer(command)) {
      const running = findRunningDevServer(command, cwd);
      if (running?.terminalId) {
        terminalStore.setActive(running.terminalId);
        return {
          success: true,
          output: `Dev server already running (process ${running.processId}) in terminal ${running.terminalId}. Reusing existing server.`,
          meta: { reused: true, processId: running.processId, terminalId: running.terminalId }
        };
      }
    }

    // Ensure terminal panel is open
    uiStore.openBottomPanelTab('terminal');

    const processId = processStore.nextProcessId();

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
      terminalId,
      port: extractPort(command) ?? undefined,
      detectedUrl: inferDevServerUrl(command) ?? undefined,
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
    const tracked = processStore.get(processId);
    const updated = tracked ? updateProcessDetectedUrl(tracked, cleaned) : null;
    const urlHint = updated?.detectedUrl ? `\nDetected URL: ${updated.detectedUrl}` : '';

    return {
      success: true,
      output: `Started process ${processId} in terminal ${terminalId}.${urlHint}\n\nInitial Output:\n${cleaned || '(No output yet)'}`,
      meta: { processId, terminalId, detectedUrl: updated?.detectedUrl }
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
  await reconcileTrackedProcesses();
  const proc = processes.get(processId);

  if (!proc) {
    return { success: false, error: `Process ${processId} not found` };
  }

  try {
    let terminalClosed = false;
    if (proc.terminalId) {
      const session = terminalStore.sessions.find(s => s.id === proc.terminalId);
      if (session) {
        await session.write('\x03'); // Ctrl+C
        terminalClosed = true;
      }
      // Kill the terminal entirely
      await terminalStore.killTerminal(proc.terminalId);
      terminalClosed = true;
    }

    proc.status = 'stopped';
    processStore.set(processId, proc);
    if (terminalClosed) {
      return { success: true, output: `Process ${processId} stopped and terminal closed.` };
    }
    return {
      success: true,
      output: `Process ${processId} marked stopped. Terminal was already gone (stale/orphan record).`
    };
  } catch (err) {
    return { success: false, error: `Failed to stop process: ${err}` };
  }
}

/**
 * List all background processes
 */
export async function handleListProcesses(): Promise<ToolResult> {
  await reconcileTrackedProcesses();

  if (processes.size === 0) {
    return { success: true, output: 'No background processes tracked' };
  }

  const processList = Array.from(processes.values()).sort((a, b) => b.startTime - a.startTime);
  const runningCount = processList.filter((p) => p.status === 'running').length;
  const unknownCount = processList.filter((p) => p.status === 'unknown').length;
  const stoppedCount = processList.filter((p) => p.status === 'stopped').length;

  const lines = [];
  for (const proc of processList) {
    const elapsed = Date.now() - proc.startTime;
    const url = proc.detectedUrl ? ` url=${proc.detectedUrl}` : '';
    const orphan = proc.terminalId && !terminalStore.sessions.some((s) => s.id === proc.terminalId);
    const orphanTag = orphan ? ' orphan=true' : '';
    lines.push(
      `[${proc.processId}] ${proc.status.toUpperCase()} - ${proc.command} (${formatDuration(elapsed)})${url}${orphanTag}`
    );
  }

  return {
    success: true,
    output: `Background processes (running=${runningCount}, unknown=${unknownCount}, stopped=${stoppedCount}):\n${lines.join('\n')}`,
    meta: { runningCount, unknownCount, stoppedCount, total: processList.length }
  };
}

/**
 * Get output from a background process
 */
export async function handleGetProcessOutput(args: Record<string, unknown>): Promise<ToolResult> {
  const processId = Number(args.processId);
  const maxLines = Number(args.maxLines) || 100;
  await reconcileTrackedProcesses();
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

    const cleaned = session.getRecentCleanOutput(maxLines * 400); // Larger window for URL recovery
    const lines = cleaned.split('\n');
    const recent = lines.slice(-maxLines).join('\n');
    const updated = updateProcessDetectedUrl(proc, cleaned);

    const { text, truncated } = truncateOutput(recent);
    const urlHint = updated.detectedUrl ? `\n\nDetected URL: ${updated.detectedUrl}` : '';

    return {
      success: true,
      output: (text || '(No output yet)') + urlHint,
      truncated,
      meta: { processId, status: updated.status, detectedUrl: updated.detectedUrl }
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

// ============================================================================
// COMMAND STATUS - Smart polling with wait + incremental reads
// ============================================================================

/**
 * Poll a running process for status and output.
 * Supports optional wait (blocks until new output or process exit),
 * and incremental reads via `since` offset.
 */
export async function handleCommandStatus(args: Record<string, unknown>): Promise<ToolResult> {
  const processId = Number(args.processId);
  const waitSeconds = typeof args.wait === 'number' ? Math.min(Math.max(0, args.wait), 60) : 0;
  const sinceOffset = typeof args.since === 'number' ? Math.max(0, args.since) : 0;
  const maxLines = Number(args.maxLines) || 200;
  await reconcileTrackedProcesses();

  const proc = processes.get(processId);
  if (!proc) {
    return { success: false, error: `Process ${processId} not found. Use list_processes to see available processes.` };
  }

  const session = proc.terminalId
    ? terminalStore.sessions.find(s => s.id === proc.terminalId)
    : null;

  if (!session) {
    return {
      success: true,
      output: `Process ${processId} (${proc.command}): ${proc.status.toUpperCase()} — terminal no longer exists`,
      meta: { processId, status: proc.status }
    };
  }

  // Helper: get output since offset
  const getOutput = (): { text: string; newOffset: number; fullOutput: string } => {
    const fullOutput = session.getRecentCleanOutput(maxLines * 400);
    const sliced = sinceOffset > 0 ? fullOutput.slice(sinceOffset) : fullOutput;
    const lines = sliced.split('\n').slice(-maxLines).join('\n');
    return { text: lines, newOffset: sinceOffset + sliced.length, fullOutput };
  };

  // If wait > 0, poll for new output or process exit
  if (waitSeconds > 0) {
    const startTime = Date.now();
    const timeoutMs = waitSeconds * 1000;
    const initialOutput = getOutput();
    const initialLength = initialOutput.text.length;

    while (Date.now() - startTime < timeoutMs) {
      // Check if process has stopped
      if (proc.status !== 'running') break;

      // Check for new output
      const current = getOutput();
      if (current.text.length > initialLength) break;

      // Wait 500ms before next check
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Get final output
  const { text, newOffset, fullOutput } = getOutput();
  const updated = updateProcessDetectedUrl(proc, fullOutput);
  const elapsed = Date.now() - proc.startTime;

  let output = `Process ${processId} (${proc.command}): ${updated.status.toUpperCase()} (${formatDuration(elapsed)})`;
  if (text.trim()) {
    output += `\n\n${text}`;
  } else {
    output += '\n\n(No new output)';
  }
  if (updated.detectedUrl) {
    output += `\n\nDetected URL: ${updated.detectedUrl}`;
  }

  return {
    success: true,
    output,
    meta: {
      processId,
      status: updated.status,
      detectedUrl: updated.detectedUrl,
      offset: newOffset,
      elapsed,
    }
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
