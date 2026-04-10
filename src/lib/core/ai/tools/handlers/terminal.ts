/**
 * Terminal tool handlers - with background process management
 * 
 * Tools:
 * - run_command: Execute command and wait for completion
 * - start_process: Start background process (dev servers, watchers)
 * - stop_process: Stop a background process
 * - list_processes: List all running background processes
 * - get_process_output: Read output from a specific process
 * - read_terminal: Read recent terminal output (legacy)
 */

import { terminalStore } from '$features/terminal/stores/terminal.svelte';
import { projectStore } from '$shared/stores/project.svelte';
import { uiStore } from '$shared/stores/ui.svelte';
import {
  POWERSHELL_SHELL_INTEGRATION_IDENTITY,
  type TerminalSession,
} from '$features/terminal/services/terminal-client';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';
import { truncateOutput, extractErrorMessage, type ToolResult } from '$core/ai/tools/utils';
import { createTerminalToolRunCoordinator } from '$lib/features/assistant/components/panel/terminal-tool-run-coordinator';
import { createTerminalToolRunStore } from '$lib/features/assistant/components/panel/terminal-tool-run-store';

const terminalToolRunStore = createTerminalToolRunStore();

const terminalToolRunCoordinator = createTerminalToolRunCoordinator({
  runStore: terminalToolRunStore,
  getSession: async (cwd) => {
    let session = await terminalStore.getOrCreateAiTerminal(cwd);
    if (!session) {
      throw new Error('Failed to access AI terminal');
    }

    await session.waitForReady(3000);
    const needsPowerShellRefresh =
      /powershell|pwsh/i.test(session.info.shell) &&
      session.shellIntegrationIdentity !== POWERSHELL_SHELL_INTEGRATION_IDENTITY;

    if (!session.hasShellIntegration || needsPowerShellRefresh) {
      await session.enableShellIntegration();
    }

    if (
      /powershell|pwsh/i.test(session.info.shell) &&
      (!session.hasShellIntegration ||
        session.shellIntegrationIdentity !== POWERSHELL_SHELL_INTEGRATION_IDENTITY)
    ) {
      console.warn('[TerminalTool] PowerShell shell integration did not initialize on first attempt; recreating AI terminal.');
      session = await terminalStore.recreateAiTerminal(cwd);
      if (!session) {
        throw new Error('Failed to recreate AI terminal for shell integration');
      }
      await session.waitForReady(3000);
      if (
        !session.hasShellIntegration ||
        session.shellIntegrationIdentity !== POWERSHELL_SHELL_INTEGRATION_IDENTITY
      ) {
        await session.enableShellIntegration();
      }
    }

    terminalStore.setActive(session.id);
    return session;
  },
  classifyLongRunning: (command, transcript) =>
    isLikelyDevServer(command) && /\b(ready|started|listening|localhost:|0\.0\.0\.0:)\b/i.test(transcript),
  trackDetachedProcess: async (command, cwd, terminalId) =>
    trackDetachedProcess(command, cwd, terminalId ?? ''),
});

function resolveToolCwd(rawCwd: unknown): string | undefined {
  const projectRoot = projectStore.rootPath?.trim() || undefined;
  const explicitCwd =
    typeof rawCwd === 'string' && rawCwd.trim() ? rawCwd.trim() : undefined;

  if (!projectRoot) {
    return explicitCwd;
  }
  if (!explicitCwd) {
    return projectRoot;
  }

  const normalizedProjectRoot = normalizeCwd(projectRoot);
  const normalizedExplicit = normalizeCwd(explicitCwd);
  const cwdWithinProject =
    normalizedExplicit &&
    normalizedProjectRoot &&
    (normalizedExplicit === normalizedProjectRoot ||
      normalizedExplicit.startsWith(`${normalizedProjectRoot}/`));

  return cwdWithinProject ? explicitCwd : projectRoot;
}

function requireToolCwd(rawCwd: unknown): string {
  const cwd = resolveToolCwd(rawCwd);
  if (cwd) {
    return cwd;
  }
  throw new Error('No active project root available for terminal command cwd');
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

function normalizeCwd(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function extractLeadingCwdDirective(
  command: string,
  explicitCwd?: string,
): { command: string; cwd: string | undefined } {
  const trimmed = command.trim();
  const patterns: RegExp[] = [
    /^\s*cd\s+\/d\s+(['"]?)(.+?)\1\s*(?:;|&&)\s*([\s\S]+)$/i,
    /^\s*cd\s+(['"]?)(.+?)\1\s*(?:;|&&)\s*([\s\S]+)$/i,
    /^\s*set-location(?:\s+-literalpath|\s+-path)?\s+(['"])(.+?)\1\s*(?:;|&&)\s*([\s\S]+)$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const extractedCwd = match[2]?.trim();
    const remainder = match[3]?.trim();
    if (!extractedCwd || !remainder) continue;
    if (explicitCwd && normalizeCwd(explicitCwd) !== normalizeCwd(extractedCwd)) {
      return { command, cwd: explicitCwd };
    }
    return { command: remainder, cwd: extractedCwd };
  }

  return { command, cwd: explicitCwd };
}

function getBlockedCommandReason(command: string): string | null {
  const normalized = normalizeCommand(command);

  // Protect Volt metadata/project control directory from AI shell mutations.
  const mutatingShellVerb =
    /\b(move-item|rename-item|remove-item|del|erase|rmdir|rd|rm|mv|ren)\b/i;
  const touchesVoltDir = /(^|[\s"'`\\/])\.volt([\\/\s"'`]|$)/i.test(command);
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
      if (
        /powershell|pwsh/i.test(session.info.shell) &&
        (!session.hasShellIntegration ||
          session.shellIntegrationIdentity !== POWERSHELL_SHELL_INTEGRATION_IDENTITY)
      ) {
        await session.enableShellIntegration();
      }
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
  if (
    /powershell|pwsh/i.test(session.info.shell) &&
    (!session.hasShellIntegration ||
      session.shellIntegrationIdentity !== POWERSHELL_SHELL_INTEGRATION_IDENTITY)
  ) {
    await session.enableShellIntegration();
  }
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

type ProcessLifecycleSession = Pick<
  TerminalSession,
  'getLastCommandStartedAt' | 'getLastCommandFinishedAt'
>;

export function deriveTrackedProcessFromSessionState(
  process: BackgroundProcess,
  session: ProcessLifecycleSession,
): BackgroundProcess {
  if (process.status !== 'running') {
    return process;
  }

  const lastStartedAt = session.getLastCommandStartedAt();
  const lastFinishedAt = session.getLastCommandFinishedAt();
  const commandFinishedForThisProcess =
    typeof lastStartedAt === 'number' &&
    typeof lastFinishedAt === 'number' &&
    lastStartedAt >= process.startTime &&
    lastFinishedAt >= lastStartedAt;

  if (!commandFinishedForThisProcess) {
    return process;
  }

  return {
    ...process,
    status: 'stopped',
  };
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
    const session = proc.terminalId
      ? terminalStore.sessions.find((candidate) => candidate.id === proc.terminalId)
      : null;

    if (proc.status === 'running' && session) {
      const reconciled = deriveTrackedProcessFromSessionState(proc, session);
      if (reconciled.status !== proc.status) {
        processStore.set(proc.processId, reconciled);
        continue;
      }
    }

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
function createTerminalRunId(): string {
  return `terminal-run:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

type TerminalCoordinatorLike = {
  runForeground: (input: {
    runId: string;
    toolCallId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    runtime?: ToolRuntimeContext;
  }) => Promise<{
    success: boolean;
    output?: string;
    error?: string;
    meta?: {
      terminalRun?: {
        state?: string;
        processId?: number;
        terminalId?: string;
        detectedUrl?: string;
      };
    };
  }>;
};

async function runCommandThroughCoordinator(
  coordinator: TerminalCoordinatorLike,
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const normalizedInvocation = extractLeadingCwdDirective(String(args.command), resolveToolCwd(args.cwd));
  const command = normalizedInvocation.command.trim();
  const cwd = requireToolCwd(normalizedInvocation.cwd);
  const timeout = typeof args.timeout === 'number' ? args.timeout : 90_000;

  const result = await coordinator.runForeground({
    runId: createTerminalRunId(),
    toolCallId: String(args.toolCallId ?? command),
    command,
    cwd,
    timeoutMs: timeout,
    runtime,
  });

  const terminalRun = result.meta?.terminalRun;
  const meta = terminalRun
    ? {
        terminalRun,
        processId: terminalRun.processId,
        terminalId: terminalRun.terminalId,
        detectedUrl: terminalRun.detectedUrl,
      }
    : result.meta;

  return {
    success: result.success,
    output: result.output ?? '',
    error: result.error,
    meta,
  };
}

export async function handleRunCommandThroughCoordinatorForTest(
  coordinator: TerminalCoordinatorLike,
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  return runCommandThroughCoordinator(coordinator, args, runtime);
}

export async function handleRunCommand(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  return runCommandThroughCoordinator(terminalToolRunCoordinator, args, runtime);
}

/**
 * Start a long-running background process in a dedicated terminal
 */
export async function handleStartProcess(args: Record<string, unknown>): Promise<ToolResult> {
  const normalizedInvocation = extractLeadingCwdDirective(String(args.command), resolveToolCwd(args.cwd));
  const command = normalizedInvocation.command.trim();
  const cwd = requireToolCwd(normalizedInvocation.cwd);
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

    const currentCwd = session.cwd || session.info.cwd;
    if (normalizeCwd(currentCwd) !== normalizeCwd(cwd)) {
      throw new Error(`Process terminal cwd mismatch: expected "${cwd}", got "${currentCwd}"`);
    }

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
    session.onExit((_code) => {
      const p = processStore.get(processId);
      if (p) {
        p.status = 'stopped';
        processStore.set(processId, p);
      }
    });

    const startOffset = session.getOutputCursor();

    // Send command
    const writeSuccess = await session.write(command + '\r');
    if (!writeSuccess) {
      throw new Error(`Failed to write command to terminal ${terminalId}`);
    }

    // Wait for initial output (more responsive than fixed 2s)
    try {
      await session.waitForAnyOutput(startOffset, 4000);
    } catch {
      // If no new output, fall back to recent output from that offset onwards
      session.getRecentOutput().slice(startOffset);
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
        await session.interrupt();
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
    const reconciled = deriveTrackedProcessFromSessionState(proc, session);
    if (reconciled.status !== proc.status) {
      processStore.set(proc.processId, reconciled);
    }
    const updated = updateProcessDetectedUrl(reconciled, cleaned);

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

  const maxChars = Math.max(maxLines * 400, 4000);

  // Helper: get output since cursor offset from full stream history
  const getOutput = (): {
    text: string;
    newOffset: number;
    fullOutput: string;
    truncatedBeforeOffset: boolean;
  } => {
    const { text: sliced, nextOffset, truncatedBeforeOffset } =
      session.readCleanOutputSince(sinceOffset, maxChars * 4);
    const lines = sliced.split('\n').slice(-maxLines).join('\n');
    const fullOutput = session.getRecentCleanOutput(maxChars);
    return {
      text: lines,
      newOffset: nextOffset,
      fullOutput,
      truncatedBeforeOffset
    };
  };

  // If wait > 0, poll for new output or process exit
  if (waitSeconds > 0) {
    const startTime = Date.now();
    const timeoutMs = waitSeconds * 1000;
    const initialCursor = session.getCleanOutputCursor();

    while (Date.now() - startTime < timeoutMs) {
      // Check if process has stopped
      if (proc.status !== 'running') break;

      // Check for new output
      if (session.getCleanOutputCursor() > initialCursor) break;

      // Wait 500ms before next check
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Get final output
  const { text, newOffset, fullOutput, truncatedBeforeOffset } = getOutput();
  const updated = updateProcessDetectedUrl(proc, fullOutput);
  const elapsed = Date.now() - proc.startTime;

  let output = `Process ${processId} (${proc.command}): ${updated.status.toUpperCase()} (${formatDuration(elapsed)})`;
  if (truncatedBeforeOffset) {
    output += '\n\n(Older output before the requested offset is no longer in memory.)';
  }
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
