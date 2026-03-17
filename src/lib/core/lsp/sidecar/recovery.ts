export interface LspRecoveryControllerOptions {
  source: string;
  restart: () => Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  windowMs?: number;
}

export interface LspRecoveryState {
  scheduled: boolean;
  restarting: boolean;
  attemptsInWindow: number;
}

const DEFAULT_BASE_DELAY_MS = 750;
const DEFAULT_MAX_DELAY_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_WINDOW_MS = 120_000;

export class LspRecoveryController {
  private readonly source: string;
  private readonly restart: () => Promise<void>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  private restarting = false;
  private attemptTimestamps: number[] = [];

  constructor(options: LspRecoveryControllerOptions) {
    this.source = options.source;
    this.restart = options.restart;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  get state(): LspRecoveryState {
    this.pruneAttempts();
    return {
      scheduled: this.scheduledTimer !== null,
      restarting: this.restarting,
      attemptsInWindow: this.attemptTimestamps.length,
    };
  }

  schedule(reason: string): boolean {
    if (this.scheduledTimer || this.restarting) {
      return false;
    }

    this.pruneAttempts();
    if (this.attemptTimestamps.length >= this.maxAttempts) {
      console.warn(
        `[LSP Recovery] Refusing to restart ${this.source}; exceeded ${this.maxAttempts} attempts within ${this.windowMs}ms (${reason})`,
      );
      return false;
    }

    const delay = Math.min(
      this.baseDelayMs * 2 ** this.attemptTimestamps.length,
      this.maxDelayMs,
    );

    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = null;
      void this.runRestart(reason);
    }, delay);

    console.warn(
      `[LSP Recovery] Scheduling ${this.source} restart in ${delay}ms (${reason})`,
    );
    return true;
  }

  reset(): void {
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }
    this.restarting = false;
    this.attemptTimestamps = [];
  }

  dispose(): void {
    this.reset();
  }

  private pruneAttempts(): void {
    const cutoff = Date.now() - this.windowMs;
    this.attemptTimestamps = this.attemptTimestamps.filter((timestamp) => timestamp >= cutoff);
  }

  private async runRestart(reason: string): Promise<void> {
    if (this.restarting) {
      return;
    }

    this.restarting = true;
    this.attemptTimestamps.push(Date.now());
    this.pruneAttempts();

    try {
      console.warn(`[LSP Recovery] Restarting ${this.source} (${reason})`);
      await this.restart();
    } catch (error) {
      console.error(`[LSP Recovery] Failed to restart ${this.source}:`, error);
    } finally {
      this.restarting = false;
    }
  }
}

export function createLspRecoveryController(
  options: LspRecoveryControllerOptions,
): LspRecoveryController {
  return new LspRecoveryController(options);
}
