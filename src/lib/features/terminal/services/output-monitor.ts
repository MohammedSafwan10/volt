/**
 * Terminal Output Monitor
 *
 * State machine that monitors terminal output after a command starts executing.
 * Detects idle states, interactive prompts (Y/n, password, selections), and
 * timeouts. Modeled after VS Code Copilot agent's OutputMonitor.
 *
 * States:
 *   Initial → PollingForIdle → Idle → (handle prompts / stop) → Timeout
 *
 * Key behaviors:
 *   - Exponential backoff polling (500ms → 10s, max 20s first pass / 2min extended)
 *   - Regex-based input-required pattern detection
 *   - User-input-since-idle tracking (skip prompt UI if user typed)
 *   - Background async monitoring via wake-on-data
 */

import type { TerminalSession } from './terminal-client';
import {
  waitForIdle,
  detectsInputRequiredPattern,
  detectsCommonPromptPattern,
} from './idle-detection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const enum OutputMonitorState {
  Initial = 'Initial',
  Idle = 'Idle',
  PollingForIdle = 'PollingForIdle',
  Prompting = 'Prompting',
  Timeout = 'Timeout',
  Active = 'Active',
  Cancelled = 'Cancelled',
}

export interface OutputMonitorOptions {
  /** Terminal session to monitor */
  session: TerminalSession;
  /** Clean output offset at command start */
  startOffset: number;
  /** Callback when the monitor detects an interactive prompt */
  onPromptDetected?: (info: PromptInfo) => void;
  /** Callback when the monitor state changes */
  onStateChange?: (state: OutputMonitorState) => void;
  /** Callback for status updates */
  onUpdate?: (status: string) => void;
  /** First polling pass max duration (default: 20s) */
  firstPassMaxMs?: number;
  /** Extended polling max duration (default: 120s) */
  extendedPassMaxMs?: number;
}

export interface PromptInfo {
  /** The last few lines of output that triggered prompt detection */
  context: string;
  /** Detected prompt type */
  type: 'yes_no' | 'password' | 'selection' | 'input' | 'confirm' | 'generic';
  /** Suggested options if detected */
  options?: string[];
}

export interface PollingResult {
  output: string;
  state: OutputMonitorState;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_IDLE_EVENTS = 2;
const MIN_POLLING_DURATION_MS = 500;
const FIRST_POLLING_MAX_MS = 20_000;
const EXTENDED_POLLING_MAX_MS = 120_000;
const MAX_POLLING_INTERVAL_MS = 10_000;
const MAX_RECURSION_COUNT = 5;
const CONTEXT_LINES_FOR_PROMPT = 15;

// ---------------------------------------------------------------------------
// OutputMonitor
// ---------------------------------------------------------------------------

export class OutputMonitor {
  private _state: OutputMonitorState = OutputMonitorState.Initial;
  private _disposed = false;
  private _session: TerminalSession;
  private _startOffset: number;
  private _onPromptDetected?: (info: PromptInfo) => void;
  private _onStateChange?: (state: OutputMonitorState) => void;
  private _onUpdate?: (status: string) => void;
  private _firstPassMaxMs: number;
  private _extendedPassMaxMs: number;
  private _backgroundUnsub: (() => void) | null = null;

  constructor(options: OutputMonitorOptions) {
    this._session = options.session;
    this._startOffset = options.startOffset;
    this._onPromptDetected = options.onPromptDetected;
    this._onStateChange = options.onStateChange;
    this._onUpdate = options.onUpdate;
    this._firstPassMaxMs = options.firstPassMaxMs ?? FIRST_POLLING_MAX_MS;
    this._extendedPassMaxMs = options.extendedPassMaxMs ?? EXTENDED_POLLING_MAX_MS;
  }

  get state(): OutputMonitorState {
    return this._state;
  }

  private _setState(state: OutputMonitorState): void {
    if (this._state === state) return;
    this._state = state;
    this._onStateChange?.(state);
  }

  /**
   * Start monitoring with exponential backoff polling.
   * Resolves when the terminal is idle, a prompt is detected, or timeout.
   */
  async pollForIdle(): Promise<PollingResult> {
    if (this._disposed) return { output: '', state: OutputMonitorState.Cancelled };

    this._setState(OutputMonitorState.PollingForIdle);
    const result = await this._doPoll(this._firstPassMaxMs, 0);

    if (result.state === OutputMonitorState.Timeout && !this._disposed) {
      // Extended polling pass
      this._onUpdate?.('Command still running, extending wait...');
      const extended = await this._doPoll(this._extendedPassMaxMs, 0);
      return extended;
    }

    return result;
  }

  /**
   * Single polling pass with exponential backoff.
   */
  private async _doPoll(maxDurationMs: number, recursionCount: number): Promise<PollingResult> {
    if (this._disposed) return this._getCurrentResult(OutputMonitorState.Cancelled);
    if (recursionCount >= MAX_RECURSION_COUNT) return this._getCurrentResult(OutputMonitorState.Timeout);

    const startTime = Date.now();
    let intervalMs = MIN_POLLING_DURATION_MS;
    let idleEventCount = 0;

    while (Date.now() - startTime < maxDurationMs) {
      if (this._disposed) return this._getCurrentResult(OutputMonitorState.Cancelled);

      // Wait for idle with current interval
      const onData = (cb: (data: string) => void) => this._session.addDataListener(cb);
      const idle = waitForIdle(onData, intervalMs);

      // Race idle against remaining time
      const remaining = maxDurationMs - (Date.now() - startTime);
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), remaining),
      );

      const raceResult = await Promise.race([
        idle.promise.then(() => 'idle' as const),
        timeoutPromise,
      ]);

      idle.dispose();

      if (raceResult === 'timeout') {
        this._setState(OutputMonitorState.Timeout);
        return this._getCurrentResult(OutputMonitorState.Timeout);
      }

      // Terminal went idle
      idleEventCount++;

      // Check for input-required patterns in recent output
      const output = this._session.getRecentCleanOutput(4000);
      if (detectsInputRequiredPattern(output)) {
        this._setState(OutputMonitorState.Idle);
        const promptInfo = this._classifyPrompt(output);
        if (promptInfo) {
          this._setState(OutputMonitorState.Prompting);
          this._onPromptDetected?.(promptInfo);
        }
        return this._getCurrentResult(OutputMonitorState.Idle);
      }

      // Check for prompt patterns on the last line
      const lastLine = output.trimEnd().split('\n').pop() ?? '';
      if (
        idleEventCount >= MIN_IDLE_EVENTS &&
        detectsCommonPromptPattern(lastLine).detected
      ) {
        this._setState(OutputMonitorState.Idle);
        return this._getCurrentResult(OutputMonitorState.Idle);
      }

      // Exponential backoff
      intervalMs = Math.min(intervalMs * 2, MAX_POLLING_INTERVAL_MS);
      this._onUpdate?.(`Waiting for command output... (${Math.round((Date.now() - startTime) / 1000)}s)`);
    }

    this._setState(OutputMonitorState.Timeout);
    return this._getCurrentResult(OutputMonitorState.Timeout);
  }

  /**
   * Classify the type of prompt detected in the output.
   */
  private _classifyPrompt(output: string): PromptInfo | null {
    const lastLines = output.trimEnd().split('\n').slice(-CONTEXT_LINES_FOR_PROMPT).join('\n');

    // Yes/No prompts
    if (/\[Y\/n\]/i.test(lastLines) || /\[y\/N\]/i.test(lastLines) || /\(y(?:es)?\/n(?:o)?\)/i.test(lastLines)) {
      return {
        context: lastLines,
        type: 'yes_no',
        options: ['y', 'n'],
      };
    }

    // Password/secret prompts
    if (/(?:password|passphrase|token|api[_ ]?key|secret)\s*:\s*$/im.test(lastLines)) {
      return {
        context: lastLines,
        type: 'password',
      };
    }

    // Overwrite/confirm prompts
    if (/overwrite\s+.+\?\s*$/im.test(lastLines) || /\bconfirm\b.{0,30}\?\s*$/im.test(lastLines)) {
      return {
        context: lastLines,
        type: 'confirm',
        options: ['y', 'n'],
      };
    }

    // Selection menus (enquirer/inquirer style)
    if (/\?\s+.{3,60}\s+›/m.test(lastLines)) {
      const options = this._extractSelectionOptions(lastLines);
      return {
        context: lastLines,
        type: 'selection',
        options: options.length > 0 ? options : undefined,
      };
    }

    // Generic input prompts ending with colon
    if (/(?:enter|type|input|provide|specify)\s+.{1,40}:\s*$/im.test(lastLines)) {
      return {
        context: lastLines,
        type: 'input',
      };
    }

    // Generic prompt detection
    if (detectsInputRequiredPattern(output)) {
      return {
        context: lastLines,
        type: 'generic',
      };
    }

    return null;
  }

  /**
   * Extract selection options from terminal output.
   * Looks for patterns like "  ❯ option1\n    option2\n    option3"
   */
  private _extractSelectionOptions(text: string): string[] {
    const options: string[] = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*[❯›>○●◯◉\s]*\s+(.+)$/);
      if (match && match[1].trim().length > 0) {
        const option = match[1].trim();
        if (option.length < 100 && !option.includes('?')) {
          options.push(option);
        }
      }
    }
    return options;
  }

  private _getCurrentResult(state: OutputMonitorState): PollingResult {
    const output = this._session.getCleanOutputSince(this._startOffset);
    return { output, state };
  }

  /**
   * Continue monitoring in background mode. Wakes only on new terminal data
   * events (not on a fixed interval), so resource cost is proportional to
   * actual terminal activity.
   */
  continueMonitoringAsync(onNewActivity?: () => void): void {
    if (this._disposed) return;

    this._setState(OutputMonitorState.Active);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    this._backgroundUnsub = this._session.addDataListener(() => {
      if (this._disposed) return;

      // Reset idle timer on each data event
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (this._disposed) return;

        // Terminal went idle after data — check for prompts
        const output = this._session.getRecentCleanOutput(4000);
        if (detectsInputRequiredPattern(output)) {
          const promptInfo = this._classifyPrompt(output);
          if (promptInfo) {
            this._setState(OutputMonitorState.Prompting);
            this._onPromptDetected?.(promptInfo);
          }
        }

        onNewActivity?.();
      }, MIN_POLLING_DURATION_MS);
    });
  }

  dispose(): void {
    this._disposed = true;
    this._setState(OutputMonitorState.Cancelled);
    if (this._backgroundUnsub) {
      this._backgroundUnsub();
      this._backgroundUnsub = null;
    }
  }
}
