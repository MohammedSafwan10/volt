/**
 * Terminal Idle Detection & Prompt Heuristics
 *
 * Ported from VS Code Copilot agent's executeStrategy.ts.
 * Provides multiple layers of idle detection:
 *   1. Data-silence debounce (waitForIdle)
 *   2. Shell integration state machine (trackIdleOnPrompt)
 *   3. Prompt pattern heuristics (detectsCommonPromptPattern)
 *   4. Input-required pattern detection (detectsInputRequiredPattern)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptDetectionResult {
  detected: boolean;
  reason?: string;
}

export interface IdleDetectionOptions {
  /** Callback invoked on every terminal data event */
  onData: (callback: (data: string) => void) => (() => void);
  /** Duration in ms of data silence before considered idle */
  idleDurationMs: number;
}

export interface IdleOnPromptOptions extends IdleDetectionOptions {
  /** Fallback timeout if OSC sequences are never seen */
  promptFallbackMs?: number;
}

// ---------------------------------------------------------------------------
// 1. Basic data-silence idle detection
// ---------------------------------------------------------------------------

/**
 * Resolves when the terminal has been silent (no data events) for `idleDurationMs`.
 * Every data event resets the timer.
 */
export function waitForIdle(
  onData: (callback: (data: string) => void) => (() => void),
  idleDurationMs: number,
): { promise: Promise<void>; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolvePromise: (() => void) | null = null;
  let disposed = false;

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
    timer = setTimeout(() => {
      if (!disposed) resolve();
    }, idleDurationMs);
  });

  const unsubscribe = onData(() => {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!disposed && resolvePromise) resolvePromise();
    }, idleDurationMs);
  });

  const dispose = () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
  };

  return { promise, dispose };
}

// ---------------------------------------------------------------------------
// 2. Shell integration state machine (OSC 633 sequence tracking)
// ---------------------------------------------------------------------------

const enum TerminalState {
  Initial,
  Prompt,
  Executing,
  PromptAfterExecuting,
}

// OSC 633 sequence regex — matches A (prompt start), C (command executed), D (command finished)
const OSC_633_SEQ_RE = /(?:\x1b\]|\x9d)[16]33;(?<type>[ACD])(?:;.*)?(?:\x1b\\|\x07|\x9c)/g;

/**
 * Tracks OSC 633 shell integration sequences to determine when a command
 * finishes and the terminal returns to a prompt. More reliable than pure
 * idle detection when shell integration is available.
 *
 * Returns a promise that resolves when a prompt (A) is seen after
 * an execution (C/D) and the terminal goes idle.
 */
export function trackIdleOnPrompt(
  onData: (callback: (data: string) => void) => (() => void),
  idleDurationMs: number,
  promptFallbackMs?: number,
): { promise: Promise<void>; dispose: () => void } {
  let state: TerminalState = TerminalState.Initial;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let resolvePromise: (() => void) | null = null;
  let disposed = false;

  const effectiveFallback = promptFallbackMs ?? 1000;

  const scheduleIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!disposed && resolvePromise) resolvePromise();
    }, idleDurationMs);
  };

  const cancelIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleFallback = () => {
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (state === TerminalState.Executing || state === TerminalState.PromptAfterExecuting) {
        // Already in a reliable state, let the idle scheduler handle it
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        return;
      }
      state = TerminalState.PromptAfterExecuting;
      scheduleIdle();
    }, effectiveFallback);
  };

  const cancelFallback = () => {
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  const unsubscribe = onData((data: string) => {
    if (disposed) return;

    // Track state transitions from OSC 633 sequences
    const matches = data.matchAll(OSC_633_SEQ_RE);
    for (const match of matches) {
      const type = match.groups?.type;
      if (type === 'A') {
        if (state === TerminalState.Initial) {
          state = TerminalState.Prompt;
        } else if (state === TerminalState.Executing) {
          state = TerminalState.PromptAfterExecuting;
        }
      } else if (type === 'C' || type === 'D') {
        state = TerminalState.Executing;
      }
    }

    // Schedule idle detection based on current state
    if (state === TerminalState.PromptAfterExecuting) {
      cancelFallback();
      scheduleIdle();
    } else {
      cancelIdle();
      if (state === TerminalState.Initial || state === TerminalState.Prompt) {
        scheduleFallback();
      } else {
        cancelFallback();
      }
    }
  });

  const dispose = () => {
    disposed = true;
    cancelIdle();
    cancelFallback();
    unsubscribe();
  };

  return { promise, dispose };
}

// ---------------------------------------------------------------------------
// 3. Common shell prompt pattern detection
// ---------------------------------------------------------------------------

/**
 * Detects if the given text appears to end with a common shell prompt pattern.
 * Used as a heuristic when shell integration is unavailable.
 */
export function detectsCommonPromptPattern(cursorLine: string): PromptDetectionResult {
  if (cursorLine.trim().length === 0) {
    return { detected: false, reason: 'Content is empty or contains only whitespace' };
  }

  // PowerShell prompt: PS C:\> or similar patterns
  if (/PS\s+[A-Z]:\\.*>\s*$/.test(cursorLine)) {
    return { detected: true, reason: `PowerShell prompt pattern detected: "${cursorLine}"` };
  }

  // Command Prompt: C:\path>
  if (/^[A-Z]:\\.*>\s*$/.test(cursorLine)) {
    return { detected: true, reason: `Command Prompt pattern detected: "${cursorLine}"` };
  }

  // Bash-style prompts ending with $
  if (/\$\s*$/.test(cursorLine)) {
    return { detected: true, reason: `Bash-style prompt pattern detected: "${cursorLine}"` };
  }

  // Root prompts ending with #
  if (/#\s*$/.test(cursorLine)) {
    return { detected: true, reason: `Root prompt pattern detected: "${cursorLine}"` };
  }

  // Python REPL prompt
  if (/^>>>\s*$/.test(cursorLine)) {
    return { detected: true, reason: `Python REPL prompt pattern detected: "${cursorLine}"` };
  }

  // Custom prompts ending with the starship character (\u276f)
  if (/\u276f\s*$/.test(cursorLine)) {
    return { detected: true, reason: `Starship prompt pattern detected: "${cursorLine}"` };
  }

  // Generic prompts ending with common prompt characters
  if (/[>%]\s*$/.test(cursorLine)) {
    return { detected: true, reason: `Generic prompt pattern detected: "${cursorLine}"` };
  }

  return { detected: false, reason: `No common prompt pattern found in last line: "${cursorLine}"` };
}

// ---------------------------------------------------------------------------
// 4. Input-required pattern detection
// ---------------------------------------------------------------------------

/**
 * Detects patterns in terminal output that indicate the command is waiting
 * for user input (e.g., [Y/n], password prompts, selection menus).
 */
export function detectsInputRequiredPattern(output: string): boolean {
  const lastLines = output.trimEnd().split('\n').slice(-5).join('\n');

  // Yes/No prompts
  if (/\[Y\/n\]/i.test(lastLines)) return true;
  if (/\[y\/N\]/i.test(lastLines)) return true;
  if (/\(y(?:es)?\/n(?:o)?\)/i.test(lastLines)) return true;
  if (/\(yes\/no(?:\/\[fingerprint\])?\)/i.test(lastLines)) return true;

  // Password / secret prompts
  if (/(?:password|passphrase|token|api[_ ]?key|secret)\s*:\s*$/im.test(lastLines)) return true;

  // Generic input prompts ending with colon
  if (/(?:enter|type|input|provide|specify)\s+.{1,40}:\s*$/im.test(lastLines)) return true;

  // "Press Enter to continue" and variants
  if (/press\s+(?:enter|any\s+key|return)\s+to\s+continue/i.test(lastLines)) return true;

  // npm/yarn/pnpm interactive prompts
  if (/\?\s+.{3,60}\s+›/m.test(lastLines)) return true; // enquirer-style: "? question ›"
  if (/\?\s+.{3,60}\s*\(.*\)\s*$/m.test(lastLines)) return true; // inquirer-style: "? question (Y/n)"

  // Selection menus with arrow indicators
  if (/[❯›>]\s+\S/m.test(lastLines) && /\s{2,}[○●◯◉]\s/m.test(lastLines)) return true;

  // Overwrite prompts
  if (/overwrite\s+.+\?\s*$/im.test(lastLines)) return true;

  // Confirm prompts
  if (/\bconfirm\b.{0,30}\?\s*$/im.test(lastLines)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// 5. Non-interactive help pattern detection
// ---------------------------------------------------------------------------

/**
 * Detects if output looks like a help/usage page (non-interactive).
 * These should NOT trigger prompt detection.
 */
export function detectsNonInteractiveHelpPattern(output: string): boolean {
  const lines = output.trimEnd().split('\n');
  if (lines.length < 5) return false;

  const text = lines.slice(-20).join('\n');

  // Common help page indicators
  if (/^usage:\s/im.test(text) && /^\s+-/m.test(text)) return true;
  if (/^options:\s*$/im.test(text)) return true;
  if (/^commands:\s*$/im.test(text)) return true;
  if (/^(?:flags|arguments):\s*$/im.test(text)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// 6. VS Code task finish pattern
// ---------------------------------------------------------------------------

/**
 * Detects VS Code's "press any key to close the terminal" message.
 */
export function detectsVSCodeTaskFinishMessage(output: string): boolean {
  return /terminal will be reused|press any key to close the terminal/i.test(output);
}

// ---------------------------------------------------------------------------
// 7. Generic "press any key" pattern
// ---------------------------------------------------------------------------

export function detectsGenericPressAnyKeyPattern(output: string): boolean {
  const lastLines = output.trimEnd().split('\n').slice(-3).join('\n');
  return /press\s+any\s+key/i.test(lastLines);
}
