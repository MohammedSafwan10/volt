export type StagedResourceState =
  | 'absent'
  | 'staged_new'
  | 'staged_modified'
  | 'staged_delete'
  | 'committed'
  | 'failed';

export type MutationPhase = 'prepare' | 'stage' | 'commit' | 'project' | 'finalize';

export type DiagnosticsBasis = 'committed_disk' | 'editor_buffer' | 'staged_tool_output';
export type DiagnosticsFreshness = 'fresh' | 'pending' | 'stale';
export type StructuralMutationKind = 'create' | 'rename' | 'delete';
export type FailureKind = 'preflight' | 'commit' | 'projection' | 'unknown';

export interface StructuralMutationDetails {
  kind: StructuralMutationKind;
  previousPath?: string;
  nextPath?: string;
}

export interface StateSnapshot {
  path: string;
  kind: 'file' | 'directory';
  exists: boolean;
  content?: string | null;
  version?: number;
}

export interface FailureMetadata {
  kind: FailureKind;
  message: string;
  phase: MutationPhase;
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface StagedResourceRecord {
  path: string;
  kind: 'file' | 'directory';
  state: StagedResourceState;
  phase: MutationPhase;
  committedContent?: string | null;
  stagedContent?: string | null;
  previousPath?: string;
  nextPath?: string;
  version?: number;
  error?: string;
  diagnosticsBasis?: DiagnosticsBasis;
  diagnosticsFreshness?: DiagnosticsFreshness;
  beforeState?: StateSnapshot | null;
  afterState?: StateSnapshot | null;
  structuralMutation?: StructuralMutationDetails;
  failure?: FailureMetadata;
  meta?: Record<string, unknown>;
}

interface FinalizeSuccessInput {
  committedContent?: string | null;
  version?: number;
  diagnosticsBasis?: DiagnosticsBasis;
  diagnosticsFreshness?: DiagnosticsFreshness;
}

interface SubscribeOptions<T> {
  selector?: (records: readonly StagedResourceRecord[]) => T;
  equality?: (left: T, right: T) => boolean;
  emitImmediately?: boolean;
}

interface DiagnosticsUpdate {
  basis?: DiagnosticsBasis;
  freshness?: DiagnosticsFreshness;
}

interface StructuralMutationInput {
  path: string;
  kind: 'file' | 'directory';
  mutation: StructuralMutationDetails;
  beforeState?: StateSnapshot | null;
  afterState?: StateSnapshot | null;
  phase?: MutationPhase;
  version?: number;
  meta?: Record<string, unknown>;
}

interface FailureInput {
  kind?: FailureKind;
  message: string;
  phase?: MutationPhase;
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

const DEFAULT_DIAGNOSTICS_BASIS: DiagnosticsBasis = 'committed_disk';
const DEFAULT_DIAGNOSTICS_FRESHNESS: DiagnosticsFreshness = 'fresh';

function cloneRecord(record: StagedResourceRecord): StagedResourceRecord {
  return {
    ...record,
    diagnosticsBasis: record.diagnosticsBasis ?? DEFAULT_DIAGNOSTICS_BASIS,
    diagnosticsFreshness: record.diagnosticsFreshness ?? DEFAULT_DIAGNOSTICS_FRESHNESS,
    beforeState: record.beforeState ? { ...record.beforeState } : undefined,
    afterState: record.afterState ? { ...record.afterState } : undefined,
    structuralMutation: record.structuralMutation ? { ...record.structuralMutation } : undefined,
    failure: record.failure
      ? {
          ...record.failure,
          details: record.failure.details ? { ...record.failure.details } : undefined,
        }
      : undefined,
    meta: record.meta ? { ...record.meta } : undefined,
  };
}

export function createStagedDocumentService() {
  const records = new Map<string, StagedResourceRecord>();
  const listeners = new Set<() => void>();

  function snapshot(): StagedResourceRecord[] {
    return [...records.values()].map(cloneRecord);
  }

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function store(record: StagedResourceRecord): void {
    records.set(record.path, cloneRecord(record));
    notify();
  }

  function subscribe(listener: () => void): () => void;
  function subscribe<T>(listener: (selected: T) => void, options: SubscribeOptions<T>): () => void;
  function subscribe<T>(
    listener: (() => void) | ((selected: T) => void),
    options?: SubscribeOptions<T>,
  ): () => void {
    if (!options) {
      const callback = listener as () => void;
      listeners.add(callback);
      return () => listeners.delete(callback);
    }

    const selector =
      options.selector ?? ((records: readonly StagedResourceRecord[]) => records as T);
    const equality = options.equality ?? Object.is;
    let current = selector(snapshot());

    const callback = () => {
      const nextSelected = selector(snapshot());
      if (equality(current, nextSelected)) {
        return;
      }

      current = nextSelected;
      (listener as (selected: T) => void)(nextSelected);
    };

    listeners.add(callback);

    if (options.emitImmediately ?? true) {
      (listener as (selected: T) => void)(current);
    }

    return () => listeners.delete(callback);
  }

  return {
    get(path: string): StagedResourceRecord | null {
      const record = records.get(path);
      return record ? cloneRecord(record) : null;
    },

    list(): StagedResourceRecord[] {
      return snapshot();
    },

    stage(record: StagedResourceRecord): void {
      store(record);
    },

    stageStructuralMutation(input: StructuralMutationInput): void {
      const mutationState: StagedResourceState =
        input.mutation.kind === 'delete' ? 'staged_delete' : 'staged_new';
      const targetPath = input.mutation.nextPath ?? input.path;
      store({
        path: targetPath,
        kind: input.kind,
        state: mutationState,
        phase: input.phase ?? 'stage',
        committedContent: input.beforeState?.content ?? null,
        stagedContent: input.afterState?.content ?? null,
        previousPath: input.mutation.previousPath ?? input.beforeState?.path,
        nextPath: input.mutation.nextPath ?? targetPath,
        version: input.version ?? input.afterState?.version ?? input.beforeState?.version,
        beforeState: input.beforeState ?? null,
        afterState: input.afterState ?? null,
        structuralMutation: { ...input.mutation },
        meta: input.meta,
      });
    },

    setPhase(path: string, phase: MutationPhase): void {
      const existing = records.get(path);
      if (!existing) {
        return;
      }

      store({ ...existing, phase });
    },

    updateDiagnostics(path: string, update: DiagnosticsUpdate): void {
      const existing = records.get(path);
      if (!existing) {
        return;
      }

      store({
        ...existing,
        diagnosticsBasis: update.basis ?? existing.diagnosticsBasis ?? DEFAULT_DIAGNOSTICS_BASIS,
        diagnosticsFreshness:
          update.freshness ??
          existing.diagnosticsFreshness ??
          DEFAULT_DIAGNOSTICS_FRESHNESS,
      });
    },

    finalizeSuccess(path: string, next: FinalizeSuccessInput = {}): void {
      const existing = records.get(path);
      if (!existing) {
        return;
      }

      const committedContent =
        next.committedContent ?? existing.stagedContent ?? existing.committedContent ?? null;

      store({
        ...existing,
        state: 'committed',
        phase: 'finalize',
        committedContent,
        stagedContent: committedContent,
        version: next.version ?? existing.version,
        error: undefined,
        failure: undefined,
        diagnosticsBasis:
          next.diagnosticsBasis ?? existing.diagnosticsBasis ?? DEFAULT_DIAGNOSTICS_BASIS,
        diagnosticsFreshness:
          next.diagnosticsFreshness ??
          existing.diagnosticsFreshness ??
          DEFAULT_DIAGNOSTICS_FRESHNESS,
      });
    },

    finalizeFailure(path: string, error: string | FailureInput): void {
      const existing = records.get(path);
      if (!existing) {
        return;
      }

      const failure =
        typeof error === 'string'
          ? ({
              kind: 'unknown',
              message: error,
              phase: existing.phase,
            } satisfies FailureMetadata)
          : ({
              kind: error.kind ?? 'unknown',
              message: error.message,
              phase: error.phase ?? existing.phase,
              code: error.code,
              retryable: error.retryable,
              details: error.details,
            } satisfies FailureMetadata);

      store({
        ...existing,
        state: 'failed',
        phase: 'finalize',
        error: failure.message,
        failure,
        diagnosticsFreshness: 'stale',
      });
    },

    clear(path: string): void {
      if (!records.delete(path)) {
        return;
      }

      notify();
    },

    subscribe,

    select<T>(selector: (records: readonly StagedResourceRecord[]) => T): T {
      return selector(snapshot());
    },

    selectors: {
      records(): readonly StagedResourceRecord[] {
        return snapshot();
      },
      byPath(path: string): StagedResourceRecord | null {
        const record = records.get(path);
        return record ? cloneRecord(record) : null;
      },
      structural(): readonly StagedResourceRecord[] {
        return snapshot().filter(
          (record) =>
            record.kind === 'directory' ||
            record.state === 'staged_new' ||
            record.state === 'staged_delete' ||
            Boolean(record.previousPath) ||
            Boolean(record.nextPath),
        );
      },
      mutationPhase(path: string): MutationPhase | null {
        return records.get(path)?.phase ?? null;
      },
      diagnostics(path: string): { basis: DiagnosticsBasis; freshness: DiagnosticsFreshness } | null {
        const record = records.get(path);
        if (!record) {
          return null;
        }

        return {
          basis: record.diagnosticsBasis ?? DEFAULT_DIAGNOSTICS_BASIS,
          freshness: record.diagnosticsFreshness ?? DEFAULT_DIAGNOSTICS_FRESHNESS,
        };
      },
    },
  };
}
