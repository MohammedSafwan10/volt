import type { FileDocument, WriteOptions, WriteResult } from './file-service';
import type { FileInfo } from '$core/types/files';
import type {
  DiagnosticsBasis,
  DiagnosticsFreshness,
  StagedResourceRecord,
  StateSnapshot,
  StructuralMutationDetails,
} from './staged-document-service';
import { fileService } from './file-service';
import { createStagedDocumentService } from './staged-document-service';

export type ContentMutationIntent = {
  type: 'write';
  path: string;
  content: string;
  createIfMissing?: boolean;
  relativePath?: string;
  sync?: {
    normalizedPath: string;
    firstChangedLine?: number;
    lastChangedLine?: number;
  };
};

export type MutationIntent =
  | ContentMutationIntent
  | { type: 'delete'; path: string; openPaths?: string[] }
  | { type: 'create_dir'; path: string }
  | { type: 'rename'; oldPath: string; newPath: string; openPaths?: string[] };

export interface StructuralMutationResult {
  success: boolean;
  error?: string;
}

export interface ContentMutationProjectionContext {
  normalizedPath: string;
  relativePath?: string;
  firstChangedLine?: number;
  lastChangedLine?: number;
}

export interface WorkspaceMutationProjectionPort {
  refreshTree?(): Promise<void>;
  syncContentMutation?(
    path: string,
    content: string,
    context: ContentMutationProjectionContext,
  ): Promise<void>;
  closePaths?(paths: string[]): Promise<void>;
  reopenPaths?(paths: string[]): Promise<void>;
}

export interface FileBackend {
  read(path: string, forceRefresh?: boolean): Promise<FileDocument | null>;
  write(path: string, content: string, options?: WriteOptions): Promise<WriteResult>;
  getInfo?(path: string): Promise<FileInfo | null>;
  deletePath?(path: string): Promise<StructuralMutationResult>;
  createDir?(path: string): Promise<StructuralMutationResult>;
  renamePath?(oldPath: string, newPath: string): Promise<StructuralMutationResult>;
}

export function createWorkspaceMutationFileBackend(fileBackend: FileBackend): FileBackend {
  return fileBackend;
}

interface StagedDocumentsPort {
  get?(path: string): StagedResourceRecord | null;
  stage(record: StagedResourceRecord): void;
  stageStructuralMutation(input: {
    path: string;
    kind: 'file' | 'directory';
    mutation: StructuralMutationDetails;
    beforeState?: StateSnapshot | null;
    afterState?: StateSnapshot | null;
    phase?: 'prepare' | 'stage' | 'commit' | 'project' | 'finalize';
    version?: number;
    meta?: Record<string, unknown>;
  }): void;
  setPhase(path: string, phase: 'prepare' | 'stage' | 'commit' | 'project' | 'finalize'): void;
  updateDiagnostics(path: string, update: { basis?: DiagnosticsBasis; freshness?: DiagnosticsFreshness }): void;
  finalizeSuccess(
    path: string,
    next?: {
      committedContent?: string | null;
      version?: number;
      diagnosticsBasis?: DiagnosticsBasis;
      diagnosticsFreshness?: DiagnosticsFreshness;
    },
  ): void;
  finalizeFailure(
    path: string,
    error:
      | string
      | {
          kind?: 'preflight' | 'commit' | 'projection' | 'unknown';
          message: string;
          phase?: 'prepare' | 'stage' | 'commit' | 'project' | 'finalize';
          code?: string;
          retryable?: boolean;
          details?: Record<string, unknown>;
        },
  ): void;
}

export type WorkspaceMutationResult =
  | { success: false; error?: string }
  | { success: true; record?: StagedResourceRecord };

function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function isSameOrChildPath(candidate: string, target: string): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedTarget = normalizeForCompare(target);
  return (
    normalizedCandidate === normalizedTarget ||
    normalizedCandidate.startsWith(`${normalizedTarget}/`)
  );
}

function computeRenameProjectionPaths(openPaths: string[], oldPath: string, newPath: string): string[] {
  const oldAbsNorm = normalizeForCompare(oldPath);
  const newPathNormalized = newPath.replace(/\\/g, '/');

  return openPaths.map((openPath) => {
    const openNorm = normalizeForCompare(openPath);
    if (!isSameOrChildPath(openPath, oldPath)) {
      return openPath;
    }

    if (openNorm === oldAbsNorm) {
      return newPath;
    }

    const suffix = openPath.replace(/\\/g, '/').slice(oldAbsNorm.length);
    return `${newPathNormalized}${suffix}`.replace(/\//g, '\\');
  });
}

export function createWorkspaceMutationCoordinator(deps: {
  stagedDocuments: StagedDocumentsPort;
  fileBackend: FileBackend;
  projections?: WorkspaceMutationProjectionPort;
}) {
  function withRecord(result: { success: boolean; error?: string }, path: string): WorkspaceMutationResult {
    if (!result.success) {
      return result;
    }
    const record = 'get' in deps.stagedDocuments ? (deps.stagedDocuments as StagedDocumentsPort & {
      get?: (path: string) => StagedResourceRecord | null;
    }).get?.(path) ?? undefined : undefined;
    return {
      ...result,
      record,
    };
  }

  function toStateSnapshot(
    path: string,
    document: FileDocument | null,
    overrides: Partial<StateSnapshot> = {},
  ): StateSnapshot {
    return {
      path,
      kind: 'file',
      exists: document !== null,
      content: document?.content ?? null,
      version: document?.version,
      ...overrides,
    };
  }

  async function runWrite(intent: Extract<MutationIntent, { type: 'write' }>) {
    const current = await deps.fileBackend.read(intent.path, true);

    deps.stagedDocuments.stage({
      path: intent.path,
      kind: 'file',
      state: current ? 'staged_modified' : 'staged_new',
      phase: 'stage',
      committedContent: current?.content ?? null,
      stagedContent: intent.content,
      version: current?.version,
      beforeState: toStateSnapshot(intent.path, current),
      afterState: toStateSnapshot(intent.path, current, {
        exists: true,
        content: intent.content,
        version: current?.version,
      }),
      diagnosticsBasis: 'staged_tool_output',
      diagnosticsFreshness: 'pending',
      meta: {
        intent: 'write',
      },
    });
    deps.stagedDocuments.setPhase(intent.path, 'prepare');
    deps.stagedDocuments.setPhase(intent.path, 'commit');

    const writeResult = await deps.fileBackend.write(intent.path, intent.content, {
      expectedVersion: current?.version,
      createIfMissing: intent.createIfMissing ?? !current,
      source: 'ai',
    });

    if (!writeResult.success) {
      deps.stagedDocuments.finalizeFailure(intent.path, {
        kind: 'commit',
        message: writeResult.error ?? 'write failed',
        phase: 'commit',
      });
      return { success: false, error: writeResult.error ?? 'write failed' };
    }

    deps.stagedDocuments.setPhase(intent.path, 'project');

    try {
      if (intent.createIfMissing && !current) {
        await deps.projections?.refreshTree?.();
      }
      if (intent.sync) {
        await deps.projections?.syncContentMutation?.(intent.path, intent.content, {
          normalizedPath: intent.sync.normalizedPath,
          relativePath: intent.relativePath,
          firstChangedLine: intent.sync.firstChangedLine,
          lastChangedLine: intent.sync.lastChangedLine,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.stagedDocuments.finalizeFailure(intent.path, {
        kind: 'projection',
        message,
        phase: 'project',
      });
      return { success: false, error: message };
    }

    deps.stagedDocuments.updateDiagnostics(intent.path, {
      basis: 'committed_disk',
      freshness: 'fresh',
    });
    deps.stagedDocuments.stage({
      path: intent.path,
      kind: 'file',
      state: current ? 'staged_modified' : 'staged_new',
      phase: 'project',
      committedContent: current?.content ?? null,
      stagedContent: intent.content,
      version: writeResult.newVersion ?? current?.version,
      beforeState: toStateSnapshot(intent.path, current),
      afterState: toStateSnapshot(intent.path, current, {
        exists: true,
        content: intent.content,
        version: writeResult.newVersion ?? current?.version,
      }),
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
      meta: {
        intent: 'write',
      },
    });
    deps.stagedDocuments.finalizeSuccess(intent.path, {
      committedContent: intent.content,
      version: writeResult.newVersion,
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
    });

    return withRecord({ success: true }, intent.path);
  }

  async function runDelete(intent: Extract<MutationIntent, { type: 'delete' }>) {
    const current = await deps.fileBackend.read(intent.path, true);
    const info = current ? null : await deps.fileBackend.getInfo?.(intent.path);
    const isDirectory = info?.isDir === true;
    if (!current && !isDirectory) {
      deps.stagedDocuments.stageStructuralMutation({
        path: intent.path,
        kind: 'file',
        mutation: {
          kind: 'delete',
          previousPath: intent.path,
        },
        beforeState: toStateSnapshot(intent.path, current),
        afterState: toStateSnapshot(intent.path, current, {
          exists: false,
          content: null,
        }),
        phase: 'prepare',
        meta: {
          intent: 'delete',
        },
      });
      deps.stagedDocuments.finalizeFailure(intent.path, {
        kind: 'preflight',
        message: 'delete target missing',
        phase: 'prepare',
      });
      return { success: false, error: 'delete target missing' };
    }

    deps.stagedDocuments.stageStructuralMutation({
      path: intent.path,
      kind: isDirectory ? 'directory' : 'file',
      mutation: {
        kind: 'delete',
        previousPath: intent.path,
      },
      beforeState: isDirectory
        ? {
            path: intent.path,
            kind: 'directory',
            exists: true,
          }
        : toStateSnapshot(intent.path, current),
      afterState: isDirectory
        ? {
            path: intent.path,
            kind: 'directory',
            exists: false,
          }
        : toStateSnapshot(intent.path, current, {
            exists: false,
            content: null,
          }),
      meta: {
        intent: 'delete',
      },
    });
    deps.stagedDocuments.setPhase(intent.path, 'prepare');
    deps.stagedDocuments.setPhase(intent.path, 'commit');

    const result = await deps.fileBackend.deletePath?.(intent.path);
    if (!result?.success) {
      deps.stagedDocuments.finalizeFailure(intent.path, {
        kind: 'commit',
        message: result?.error ?? 'delete failed',
        phase: 'commit',
      });
      return { success: false, error: result?.error ?? 'delete failed' };
    }

    deps.stagedDocuments.setPhase(intent.path, 'project');
    const openPaths = intent.openPaths ?? [];

    try {
      if (openPaths.length > 0) {
        await deps.projections?.closePaths?.(openPaths);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.stagedDocuments.finalizeFailure(intent.path, {
        kind: 'projection',
        message,
        phase: 'project',
      });
      return { success: false, error: message };
    }

    deps.stagedDocuments.stage({
      path: intent.path,
      kind: isDirectory ? 'directory' : 'file',
      state: 'staged_delete',
      phase: 'project',
      committedContent: null,
      stagedContent: null,
      version: current?.version,
      beforeState: isDirectory
        ? {
            path: intent.path,
            kind: 'directory',
            exists: true,
          }
        : toStateSnapshot(intent.path, current),
      afterState: isDirectory
        ? {
            path: intent.path,
            kind: 'directory',
            exists: false,
          }
        : toStateSnapshot(intent.path, current, {
          exists: false,
          content: null,
        }),
      structuralMutation: {
        kind: 'delete',
        previousPath: intent.path,
      },
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
      meta: {
        intent: 'delete',
      },
    });
    deps.stagedDocuments.finalizeSuccess(intent.path, {
      committedContent: null,
      version: current?.version,
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
    });
    return withRecord({ success: true }, intent.path);
  }

  async function runCreateDir(intent: Extract<MutationIntent, { type: 'create_dir' }>) {
    if (!deps.fileBackend.createDir) {
      deps.stagedDocuments.stageStructuralMutation({
        path: intent.path,
        kind: 'directory',
        mutation: {
          kind: 'create',
          nextPath: intent.path,
        },
        afterState: {
          path: intent.path,
          kind: 'directory',
          exists: true,
        },
        phase: 'prepare',
        meta: {
          intent: 'create_dir',
        },
      });
      deps.stagedDocuments.finalizeFailure(intent.path, {
        kind: 'preflight',
        message: 'create_dir is not supported by the current backend',
        phase: 'prepare',
      });
      return { success: false, error: 'create_dir is not supported by the current backend' };
    }

    deps.stagedDocuments.stageStructuralMutation({
      path: intent.path,
      kind: 'directory',
      mutation: {
        kind: 'create',
        nextPath: intent.path,
      },
      afterState: {
        path: intent.path,
        kind: 'directory',
        exists: true,
      },
      meta: {
        intent: 'create_dir',
      },
    });
    deps.stagedDocuments.setPhase(intent.path, 'prepare');
    deps.stagedDocuments.setPhase(intent.path, 'commit');

    const result = await deps.fileBackend.createDir(intent.path);
    if (!result.success) {
      deps.stagedDocuments.finalizeFailure(intent.path, {
        kind: 'commit',
        message: result.error ?? 'create_dir failed',
        phase: 'commit',
      });
      return { success: false, error: result.error ?? 'create_dir failed' };
    }

    deps.stagedDocuments.setPhase(intent.path, 'project');
    try {
      await deps.projections?.refreshTree?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.stagedDocuments.finalizeFailure(intent.path, {
        kind: 'projection',
        message,
        phase: 'project',
      });
      return { success: false, error: message };
    }

    deps.stagedDocuments.finalizeSuccess(intent.path, {
      committedContent: null,
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
    });
    return withRecord({ success: true }, intent.path);
  }

  async function runRename(intent: Extract<MutationIntent, { type: 'rename' }>) {
    if (!deps.fileBackend.renamePath) {
      deps.stagedDocuments.stageStructuralMutation({
        path: intent.newPath,
        kind: 'file',
        mutation: {
          kind: 'rename',
          previousPath: intent.oldPath,
          nextPath: intent.newPath,
        },
        beforeState: toStateSnapshot(intent.oldPath, null, {
          path: intent.oldPath,
          exists: false,
        }),
        afterState: toStateSnapshot(intent.newPath, null, {
          path: intent.newPath,
          exists: false,
        }),
        phase: 'prepare',
        meta: {
          intent: 'rename',
        },
      });
      deps.stagedDocuments.finalizeFailure(intent.newPath, {
        kind: 'preflight',
        message: 'rename is not supported by the current backend',
        phase: 'prepare',
      });
      return { success: false, error: 'rename is not supported by the current backend' };
    }

    const current = await deps.fileBackend.read(intent.oldPath, true);
    const target = await deps.fileBackend.read(intent.newPath, true);
    if (!current) {
      deps.stagedDocuments.stageStructuralMutation({
        path: intent.newPath,
        kind: 'file',
        mutation: {
          kind: 'rename',
          previousPath: intent.oldPath,
          nextPath: intent.newPath,
        },
        beforeState: toStateSnapshot(intent.oldPath, current, {
          path: intent.oldPath,
          exists: false,
        }),
        afterState: toStateSnapshot(intent.newPath, target, {
          path: intent.newPath,
          exists: target !== null,
        }),
        phase: 'prepare',
        meta: {
          intent: 'rename',
        },
      });
      deps.stagedDocuments.finalizeFailure(intent.newPath, {
        kind: 'preflight',
        message: 'rename source missing',
        phase: 'prepare',
      });
      return { success: false, error: 'rename source missing' };
    }
    if (target) {
      deps.stagedDocuments.stageStructuralMutation({
        path: intent.newPath,
        kind: 'file',
        mutation: {
          kind: 'rename',
          previousPath: intent.oldPath,
          nextPath: intent.newPath,
        },
        beforeState: toStateSnapshot(intent.oldPath, current),
        afterState: toStateSnapshot(intent.newPath, target, {
          path: intent.newPath,
          exists: true,
        }),
        phase: 'prepare',
        meta: {
          intent: 'rename',
        },
      });
      deps.stagedDocuments.finalizeFailure(intent.newPath, {
        kind: 'preflight',
        message: 'rename target already exists',
        phase: 'prepare',
      });
      return { success: false, error: 'rename target already exists' };
    }

    deps.stagedDocuments.stageStructuralMutation({
      path: intent.newPath,
      kind: 'file',
      mutation: {
        kind: 'rename',
        previousPath: intent.oldPath,
        nextPath: intent.newPath,
      },
      beforeState: toStateSnapshot(intent.oldPath, current),
      afterState: toStateSnapshot(intent.newPath, current, {
        path: intent.newPath,
        exists: true,
      }),
      meta: {
        intent: 'rename',
      },
    });
    deps.stagedDocuments.setPhase(intent.newPath, 'prepare');
    deps.stagedDocuments.setPhase(intent.newPath, 'commit');

    const result = await deps.fileBackend.renamePath(intent.oldPath, intent.newPath);
    if (!result.success) {
      deps.stagedDocuments.finalizeFailure(intent.newPath, {
        kind: 'commit',
        message: result.error ?? 'rename failed',
        phase: 'commit',
      });
      return { success: false, error: result.error ?? 'rename failed' };
    }

    deps.stagedDocuments.setPhase(intent.newPath, 'project');
    const openPaths = intent.openPaths ?? [];
    const reopenPaths = computeRenameProjectionPaths(openPaths, intent.oldPath, intent.newPath);

    try {
      if (openPaths.length > 0) {
        await deps.projections?.closePaths?.(openPaths);
      }
      if (reopenPaths.length > 0) {
        await deps.projections?.reopenPaths?.(reopenPaths);
      }
      await deps.projections?.refreshTree?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.stagedDocuments.finalizeFailure(intent.newPath, {
        kind: 'projection',
        message,
        phase: 'project',
      });
      return { success: false, error: message };
    }

    deps.stagedDocuments.stage({
      path: intent.newPath,
      kind: 'file',
      state: 'staged_new',
      phase: 'project',
      committedContent: current?.content ?? null,
      stagedContent: current?.content ?? null,
      previousPath: intent.oldPath,
      nextPath: intent.newPath,
      version: current?.version,
      beforeState: toStateSnapshot(intent.oldPath, current),
      afterState: toStateSnapshot(intent.newPath, current, {
        path: intent.newPath,
        exists: true,
        version: current?.version,
      }),
      structuralMutation: {
        kind: 'rename',
        previousPath: intent.oldPath,
        nextPath: intent.newPath,
      },
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
      meta: {
        intent: 'rename',
      },
    });
    deps.stagedDocuments.finalizeSuccess(intent.newPath, {
      committedContent: current?.content ?? null,
      version: current?.version,
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
    });
    return withRecord({ success: true }, intent.newPath);
  }

  return {
    async run(intent: MutationIntent): Promise<WorkspaceMutationResult> {
      switch (intent.type) {
        case 'write':
          return runWrite(intent);
        case 'delete':
          return runDelete(intent);
        case 'create_dir':
          return runCreateDir(intent);
        case 'rename':
          return runRename(intent);
        default:
          return { success: false, error: `Unsupported intent: ${String((intent as { type: string }).type)}` };
      }
    },
  };
}

const defaultStagedDocuments = createStagedDocumentService();
let defaultCoordinator: ReturnType<typeof createWorkspaceMutationCoordinator> | null = null;

function getDefaultCoordinator(): ReturnType<typeof createWorkspaceMutationCoordinator> {
  if (!defaultCoordinator) {
    defaultCoordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: defaultStagedDocuments,
      fileBackend: fileService,
    });
  }

  return defaultCoordinator;
}

export const workspaceMutationCoordinator = {
  stagedDocuments: defaultStagedDocuments,
  async run(intent: MutationIntent): Promise<WorkspaceMutationResult> {
    return getDefaultCoordinator().run(intent);
  },
};
