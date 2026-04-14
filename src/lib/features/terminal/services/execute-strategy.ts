/**
 * Terminal Execute Strategies
 *
 * Three tiers of command execution based on shell integration quality,
 * modeled after VS Code Copilot agent's executeStrategy pattern:
 *
 *   1. RichExecuteStrategy  – Full OSC 633 shell integration; waits for
 *                             command-finish event OR idle-on-prompt.
 *   2. BasicExecuteStrategy – Partial shell integration; uses idle-on-prompt
 *                             state machine with longer timeouts.
 *   3. NoneExecuteStrategy  – No shell integration; pure data-silence idle
 *                             detection with prompt heuristics.
 */

import type { TerminalSession } from './terminal-client';
import {
  waitForIdle,
  trackIdleOnPrompt,
  detectsCommonPromptPattern,
  detectsInputRequiredPattern,
} from './idle-detection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecuteStrategyResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
  /** Whether the command entered an alternate screen buffer (e.g. vim, less) */
  didEnterAltBuffer?: boolean;
  /** Additional info for the LLM (e.g. "Command produced no output") */
  additionalInfo?: string;
}

export type ShellIntegrationQuality = 'rich' | 'basic' | 'none';

export interface ITerminalExecuteStrategy {
  readonly type: ShellIntegrationQuality;
  execute(
    session: TerminalSession,
    commandLine: string,
    timeoutMs: number,
  ): Promise<ExecuteStrategyResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_POLL_MS = 1000;
const EXTENDED_IDLE_POLL_MS = 3000;
const PROMPT_HEURISTIC_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Strategy selection
// ---------------------------------------------------------------------------

/**
 * Detect the shell integration quality and return the appropriate strategy.
 */
export function detectShellIntegrationQuality(session: TerminalSession): ShellIntegrationQuality {
  if (session.hasShellIntegration && session.shellIntegrationIdentity) {
    return 'rich';
  }
  if (session.hasShellIntegration) {
    return 'basic';
  }
  return 'none';
}

export function createExecuteStrategy(quality: ShellIntegrationQuality): ITerminalExecuteStrategy {
  switch (quality) {
    case 'rich':
      return new RichExecuteStrategy();
    case 'basic':
      return new BasicExecuteStrategy();
    case 'none':
      return new NoneExecuteStrategy();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDataListener(session: TerminalSession): (cb: (data: string) => void) => (() => void) {
  return (cb: (data: string) => void) => {
    return session.addDataListener(cb);
  };
}

/**
 * Wait for idle with prompt heuristics fallback.
 * After the terminal goes idle, checks recent output for prompt patterns.
 * If no prompt detected, extends the wait.
 */
async function waitForIdleWithPromptHeuristics(
  session: TerminalSession,
  idleDurationMs: number,
  extendedTimeoutMs: number,
): Promise<void> {
  const onData = createDataListener(session);
  const idle = waitForIdle(onData, idleDurationMs);
  try {
    await idle.promise;
  } finally {
    idle.dispose();
  }

  // After initial idle, check if the last line looks like a prompt
  const recentOutput = session.getRecentCleanOutput(2000);
  const lastLine = recentOutput.trimEnd().split('\n').pop() ?? '';
  const promptResult = detectsCommonPromptPattern(lastLine);
  if (promptResult.detected) return;

  // Not a prompt yet — check for input-required patterns
  if (detectsInputRequiredPattern(recentOutput)) return;

  // Extended wait with periodic prompt checking
  const startTime = Date.now();
  while (Date.now() - startTime < extendedTimeoutMs) {
    const extended = waitForIdle(onData, Math.min(idleDurationMs, extendedTimeoutMs - (Date.now() - startTime)));
    try {
      await extended.promise;
    } finally {
      extended.dispose();
    }

    const output = session.getRecentCleanOutput(2000);
    const line = output.trimEnd().split('\n').pop() ?? '';
    if (detectsCommonPromptPattern(line).detected) return;
    if (detectsInputRequiredPattern(output)) return;
  }
}

// ---------------------------------------------------------------------------
// Rich Execute Strategy
// ---------------------------------------------------------------------------

/**
 * Uses full OSC 633 shell integration. Waits for the `command-finish` event
 * from shell integration, racing against idle-on-prompt as a fallback.
 */
class RichExecuteStrategy implements ITerminalExecuteStrategy {
  readonly type = 'rich' as const;

  async execute(
    session: TerminalSession,
    commandLine: string,
    timeoutMs: number,
  ): Promise<ExecuteStrategyResult> {
    const startOffset = session.getCleanOutputCursor();
    const onData = createDataListener(session);

    // Race: shell integration command-finish vs idle-on-prompt vs timeout
    const commandFinishPromise = new Promise<{ exitCode: number }>((resolve) => {
      const unsub = session.onCommandFinish((exitCode: number) => {
        unsub();
        resolve({ exitCode });
      });
    });

    const idleOnPrompt = trackIdleOnPrompt(onData, DEFAULT_IDLE_POLL_MS);

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = timeoutMs > 0
      ? new Promise<'timeout'>((resolve) => {
          timeoutTimer = setTimeout(() => resolve('timeout'), timeoutMs);
        })
      : new Promise<'timeout'>(() => {}); // never resolves

    try {
      // Execute the command via shell integration
      const completion = session.executeCommand(commandLine, timeoutMs);

      // Race all completion signals
      const raceResult = await Promise.race([
        commandFinishPromise.then((r) => ({ type: 'finish' as const, exitCode: r.exitCode })),
        idleOnPrompt.promise.then(() => ({ type: 'idle' as const, exitCode: 0 })),
        timeoutPromise.then(() => ({ type: 'timeout' as const, exitCode: -1 })),
        completion.then((r) => ({ type: 'completion' as const, exitCode: r.exitCode, timedOut: r.timedOut })),
      ]);

      // Gather output
      const output = session.getCleanOutputSince(startOffset);

      if (raceResult.type === 'timeout') {
        return { output, exitCode: -1, timedOut: true };
      }

      if (raceResult.type === 'completion' && 'timedOut' in raceResult && raceResult.timedOut) {
        return { output, exitCode: -1, timedOut: true };
      }

      const exitCode = raceResult.exitCode;
      const additionalInfo = output.trim().length === 0 ? 'Command produced no output' : undefined;

      return { output, exitCode, timedOut: false, additionalInfo };
    } finally {
      idleOnPrompt.dispose();
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    }
  }
}

// ---------------------------------------------------------------------------
// Basic Execute Strategy
// ---------------------------------------------------------------------------

/**
 * Partial shell integration. Uses idle-on-prompt state machine with longer
 * timeouts since end events may misfire.
 */
class BasicExecuteStrategy implements ITerminalExecuteStrategy {
  readonly type = 'basic' as const;

  async execute(
    session: TerminalSession,
    commandLine: string,
    timeoutMs: number,
  ): Promise<ExecuteStrategyResult> {
    const startOffset = session.getCleanOutputCursor();
    const onData = createDataListener(session);

    // Wait for terminal to be idle before executing
    const preIdle = waitForIdle(onData, DEFAULT_IDLE_POLL_MS);
    try {
      await preIdle.promise;
    } finally {
      preIdle.dispose();
    }

    // Set up idle-on-prompt tracking (short + long)
    const shortIdlePrompt = trackIdleOnPrompt(onData, DEFAULT_IDLE_POLL_MS);
    const longIdlePrompt = trackIdleOnPrompt(onData, EXTENDED_IDLE_POLL_MS);

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = timeoutMs > 0
      ? new Promise<'timeout'>((resolve) => {
          timeoutTimer = setTimeout(() => resolve('timeout'), timeoutMs);
        })
      : new Promise<'timeout'>(() => {});

    try {
      // Execute command
      const completion = session.executeCommand(commandLine, timeoutMs);

      // Wait for: shell integration end event (followed by short idle),
      // long idle as catch-all, timeout, or direct completion
      const raceResult = await Promise.race([
        completion.then((r) => {
          // When basic SI is used, wait for short idle after completion
          return shortIdlePrompt.promise.then(() => ({
            type: 'completion' as const,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
          }));
        }),
        longIdlePrompt.promise.then(() => ({ type: 'idle' as const, exitCode: 0, timedOut: false })),
        timeoutPromise.then(() => ({ type: 'timeout' as const, exitCode: -1, timedOut: true })),
      ]);

      // Post-execution idle wait
      const postIdle = waitForIdle(onData, DEFAULT_IDLE_POLL_MS);
      try {
        await postIdle.promise;
      } finally {
        postIdle.dispose();
      }

      const output = session.getCleanOutputSince(startOffset);

      if (raceResult.type === 'timeout' || raceResult.timedOut) {
        return { output, exitCode: -1, timedOut: true };
      }

      const additionalInfo = output.trim().length === 0 ? 'Command produced no output' : undefined;
      return { output, exitCode: raceResult.exitCode, timedOut: false, additionalInfo };
    } finally {
      shortIdlePrompt.dispose();
      longIdlePrompt.dispose();
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    }
  }
}

// ---------------------------------------------------------------------------
// None Execute Strategy
// ---------------------------------------------------------------------------

/**
 * No shell integration. Uses pure idle detection with prompt heuristics.
 */
class NoneExecuteStrategy implements ITerminalExecuteStrategy {
  readonly type = 'none' as const;

  async execute(
    session: TerminalSession,
    commandLine: string,
    timeoutMs: number,
  ): Promise<ExecuteStrategyResult> {
    const startOffset = session.getCleanOutputCursor();

    // Execute via fallback (write + enter, no OSC wrapping)
    const completion = session.executeCommand(commandLine, timeoutMs);

    // Also wait via prompt heuristics
    const heuristicPromise = waitForIdleWithPromptHeuristics(
      session,
      DEFAULT_IDLE_POLL_MS,
      PROMPT_HEURISTIC_TIMEOUT_MS,
    );

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = timeoutMs > 0
      ? new Promise<'timeout'>((resolve) => {
          timeoutTimer = setTimeout(() => resolve('timeout'), timeoutMs);
        })
      : new Promise<'timeout'>(() => {});

    try {
      const raceResult = await Promise.race([
        completion.then((r) => ({ type: 'completion' as const, exitCode: r.exitCode, timedOut: r.timedOut })),
        heuristicPromise.then(() => ({ type: 'idle' as const, exitCode: 0, timedOut: false })),
        timeoutPromise.then(() => ({ type: 'timeout' as const, exitCode: -1, timedOut: true })),
      ]);

      const output = session.getCleanOutputSince(startOffset);

      if (raceResult.type === 'timeout' || raceResult.timedOut) {
        return { output, exitCode: -1, timedOut: true };
      }

      const additionalInfo = output.trim().length === 0 ? 'Command produced no output' : undefined;
      return { output, exitCode: raceResult.exitCode, timedOut: false, additionalInfo };
    } finally {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    }
  }
}
