export type TerminalToolRunState =
  | 'queued'
  | 'launching'
  | 'running'
  | 'streaming_output'
  | 'detaching'
  | 'detached'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TerminalToolExecutionMode =
  | 'foreground'
  | 'background_detached'
  | 'reused_background';

export interface TerminalToolRunRecord {
  runId: string;
  toolCallId: string;
  terminalId?: string;
  processId?: number;
  command: string;
  cwd?: string;
  captureStartOffset: number;
  captureCurrentOffset: number;
  captureEndOffset?: number;
  executionMode: TerminalToolExecutionMode;
  state: TerminalToolRunState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  failureReason?: string;
  detectedUrl?: string;
  excerpt?: string;
  transcriptTruncated?: boolean;
}

export interface TerminalToolRunStore {
  get(runId: string): TerminalToolRunRecord | undefined;
  upsert(run: TerminalToolRunRecord): void;
  patch(runId: string, patch: Partial<TerminalToolRunRecord>): void;
  list(): TerminalToolRunRecord[];
  clear(): void;
}

const IDENTITY_FIELDS = new Set<keyof TerminalToolRunRecord>(['runId', 'toolCallId']);

function cloneRun(run: TerminalToolRunRecord): TerminalToolRunRecord {
  return { ...run };
}

export function createTerminalToolRunStore(): TerminalToolRunStore {
  const runs = new Map<string, TerminalToolRunRecord>();

  return {
    get(runId) {
      const run = runs.get(runId);
      return run ? cloneRun(run) : undefined;
    },
    upsert(run) {
      runs.set(run.runId, cloneRun(run));
    },
    patch(runId, patch) {
      const current = runs.get(runId);
      if (!current) {
        throw new Error(`Terminal tool run not found: ${runId}`);
      }
      const sanitizedPatch = { ...patch };
      for (const field of IDENTITY_FIELDS) {
        delete sanitizedPatch[field];
      }
      runs.set(runId, { ...current, ...sanitizedPatch });
    },
    list() {
      return Array.from(runs.values(), cloneRun);
    },
    clear() {
      runs.clear();
    },
  };
}
