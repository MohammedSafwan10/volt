/**
 * Terminal Registry
 *
 * Maps opaque UUID-based terminal IDs to TerminalSession instances.
 * Used by the unified terminal tool surface (run_in_terminal, get_terminal_output,
 * send_to_terminal, kill_terminal) to track persistent async terminals.
 *
 * Also manages background monitoring and completion notification hooks.
 */

import type { TerminalSession } from './terminal-client';
import { OutputMonitor, type OutputMonitorOptions, type PromptInfo } from './output-monitor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisteredTerminal {
  /** Opaque UUID returned to the LLM */
  termId: string;
  /** Underlying terminal session */
  session: TerminalSession;
  /** Command that was executed */
  command: string;
  /** Working directory */
  cwd?: string;
  /** Whether this terminal is running in async (background) mode */
  isAsync: boolean;
  /** When the execution started */
  startedAt: number;
  /** Clean output cursor at command start */
  startOffset: number;
  /** Output monitor (for prompt detection and idle tracking) */
  monitor: OutputMonitor | null;
  /** Detected URL from output (dev servers, etc.) */
  detectedUrl?: string;
  /** Linked process ID from the old ProcessStore (for backward compat) */
  legacyProcessId?: number;
  /** Callback invoked when the background command finishes */
  onBackgroundComplete?: (output: string, exitCode: number) => void;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, RegisteredTerminal>();

/**
 * Generate a new unique terminal ID.
 */
export function generateTerminalId(): string {
  return crypto.randomUUID();
}

/**
 * Register a terminal session with the registry.
 */
export function registerTerminal(entry: RegisteredTerminal): void {
  registry.set(entry.termId, entry);
}

/**
 * Look up a registered terminal by its ID.
 */
export function getRegisteredTerminal(termId: string): RegisteredTerminal | undefined {
  return registry.get(termId);
}

/**
 * Remove a terminal from the registry and dispose its monitor.
 */
export function unregisterTerminal(termId: string): RegisteredTerminal | undefined {
  const entry = registry.get(termId);
  if (entry) {
    entry.monitor?.dispose();
    registry.delete(termId);
  }
  return entry;
}

/**
 * Get all registered terminals.
 */
export function getAllRegisteredTerminals(): RegisteredTerminal[] {
  return Array.from(registry.values());
}

/**
 * Get all async (background) terminals.
 */
export function getAsyncTerminals(): RegisteredTerminal[] {
  return Array.from(registry.values()).filter(t => t.isAsync);
}

/**
 * Clean up terminated sessions from the registry.
 */
export function pruneDeadTerminals(liveSessionIds: Set<string>): void {
  for (const [termId, entry] of registry) {
    if (!liveSessionIds.has(entry.session.id)) {
      entry.monitor?.dispose();
      registry.delete(termId);
    }
  }
}

/**
 * Create and attach an OutputMonitor to a registered terminal.
 */
export function attachMonitor(
  termId: string,
  options?: Partial<Pick<OutputMonitorOptions, 'onPromptDetected' | 'onStateChange' | 'onUpdate'>>,
): OutputMonitor | null {
  const entry = registry.get(termId);
  if (!entry) return null;

  // Dispose existing monitor
  entry.monitor?.dispose();

  const monitor = new OutputMonitor({
    session: entry.session,
    startOffset: entry.startOffset,
    onPromptDetected: options?.onPromptDetected,
    onStateChange: options?.onStateChange,
    onUpdate: options?.onUpdate,
  });

  entry.monitor = monitor;
  return monitor;
}

/**
 * Set up background completion detection for an async terminal.
 * Listens for command-finish events and invokes the callback.
 */
export function setupBackgroundCompletion(
  termId: string,
  onComplete: (output: string, exitCode: number) => void,
): (() => void) | null {
  const entry = registry.get(termId);
  if (!entry) return null;

  entry.onBackgroundComplete = onComplete;

  const unsub = entry.session.onCommandFinish((exitCode: number) => {
    const current = registry.get(termId);
    if (!current) return;

    const output = current.session.getCleanOutputSince(current.startOffset);
    current.onBackgroundComplete?.(output, exitCode);

    // Clean up after notification
    current.monitor?.dispose();
    current.monitor = null;
  });

  return unsub;
}
