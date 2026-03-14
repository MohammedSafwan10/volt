import type { ToolResult } from '$core/ai/tools';

interface ToolTrackingDeps {
  isFileMutatingTool: (toolName: string) => boolean;
  normalizeQueueKey: (path: string) => string;
  resolvePath: (path: string) => string;
  classifyRecoveryIssue: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ) => string | null;
  getFileInfo: (path: string) => Promise<void>;
  onToolOutcome: (toolName: string, args: Record<string, unknown>, result: ToolResult) => void;
}

export function createToolTrackingState(deps: ToolTrackingDeps) {
  const touchedFilePaths = new Set<string>();
  const structuralMutationPaths = new Set<string>();
  const pendingVerificationState = new Set<string>();
  const pathExistenceCache = new Map<string, boolean>();

  let lastMeaningfulAction: string | null = null;
  let lastFailureClass: string | null = null;
  let openBlocker: string | null = null;

  const invalidatePathExistence = (...paths: Array<string | undefined>): void => {
    for (const candidate of paths) {
      if (!candidate) continue;
      const normalized = candidate.trim();
      if (!normalized) continue;
      pathExistenceCache.delete(deps.normalizeQueueKey(normalized));
    }
  };

  const trackTouchedFile = (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): void => {
    if (!result.success || !deps.isFileMutatingTool(toolName)) return;
    const argPath = typeof args.path === 'string' ? args.path.trim() : '';
    const oldPath = typeof args.oldPath === 'string' ? args.oldPath.trim() : '';
    const newPath = typeof args.newPath === 'string' ? args.newPath.trim() : '';
    invalidatePathExistence(argPath, oldPath, newPath);

    if (toolName === 'delete_file' || toolName === 'rename_path' || toolName === 'create_dir') {
      if (toolName === 'rename_path') {
        if (oldPath) structuralMutationPaths.add(oldPath);
        if (newPath) structuralMutationPaths.add(newPath);
        if (newPath) touchedFilePaths.add(newPath);
      } else if (argPath) {
        structuralMutationPaths.add(argPath);
        touchedFilePaths.add(argPath);
      }
      return;
    }

    const resultMeta = result.meta as Record<string, unknown> | undefined;
    const fileEdit = resultMeta?.fileEdit as Record<string, unknown> | undefined;
    const relativeFromMeta =
      typeof fileEdit?.relativePath === 'string' ? String(fileEdit.relativePath) : '';
    if (relativeFromMeta) {
      touchedFilePaths.add(relativeFromMeta);
      return;
    }
    if (argPath) touchedFilePaths.add(argPath);
  };

  const trackToolOutcome = (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): void => {
    deps.onToolOutcome(toolName, args, result);
    trackTouchedFile(toolName, args, result);

    if (result.success) {
      lastMeaningfulAction = `${toolName}${typeof args.path === 'string' ? `(${args.path})` : ''}`;
      openBlocker = null;
    }

    const recoveryClass = deps.classifyRecoveryIssue(toolName, args, result);
    if (recoveryClass) {
      lastFailureClass = recoveryClass;
      openBlocker = String(result.error ?? result.output ?? '').trim().slice(0, 220) || openBlocker;
    }

    if (toolName === 'get_diagnostics') {
      pendingVerificationState.delete('diagnostics');
      if (!result.success) {
        pendingVerificationState.add('diagnostics');
      }
    }

    if (toolName === 'run_command' && typeof args.command === 'string') {
      const normalizedCommand = args.command.trim();
      if (normalizedCommand) {
        pendingVerificationState.delete(`command:${normalizedCommand}`);
        if (!result.success) {
          pendingVerificationState.add(`command:${normalizedCommand}`);
        }
      }
    }

    if (toolName === 'attempt_completion' && result.success) {
      pendingVerificationState.clear();
    }
  };

  const doesPathExist = async (rawPath: string): Promise<boolean> => {
    const key = deps.normalizeQueueKey(rawPath);
    if (pathExistenceCache.has(key)) {
      return Boolean(pathExistenceCache.get(key));
    }
    try {
      await deps.getFileInfo(deps.resolvePath(rawPath));
      pathExistenceCache.set(key, true);
      return true;
    } catch {
      pathExistenceCache.set(key, false);
      return false;
    }
  };

  return {
    touchedFilePaths,
    structuralMutationPaths,
    pendingVerificationState,
    get lastMeaningfulAction() {
      return lastMeaningfulAction;
    },
    get lastFailureClass() {
      return lastFailureClass;
    },
    set lastFailureClass(value: string | null) {
      lastFailureClass = value;
    },
    get openBlocker() {
      return openBlocker;
    },
    set openBlocker(value: string | null) {
      openBlocker = value;
    },
    invalidatePathExistence,
    trackToolOutcome,
    doesPathExist,
  };
}
