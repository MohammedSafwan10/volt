export interface CompletionGateFreshness {
  status?: string;
  staleSources?: string[];
  isUpdating?: boolean;
}

export interface CompletionGateDecision {
  shouldBlock: boolean;
  code?: string;
  message?: string;
  output?: string;
}

export function evaluateCompletionGate(params: {
  errorCount: number;
  freshness: CompletionGateFreshness;
  structuralMutationPaths: string[];
}): CompletionGateDecision {
  const { errorCount, freshness, structuralMutationPaths } = params;
  const diagnosticsStale =
    freshness.status === 'stale' || freshness.status === 'updating';

  if (errorCount > 0 || diagnosticsStale) {
    return {
      shouldBlock: true,
      code: diagnosticsStale
        ? 'COMPLETION_BLOCKED_BY_STALE_DIAGNOSTICS'
        : 'COMPLETION_BLOCKED_BY_DIAGNOSTICS',
      message: errorCount > 0
        ? `Completion blocked by diagnostics: ${errorCount} error(s) remain in touched files.`
        : freshness.status === 'updating'
          ? 'Completion blocked because diagnostics are still updating for touched files. Wait for diagnostics to settle, then try again.'
          : `Completion blocked because diagnostics are stale${Array.isArray(freshness.staleSources) && freshness.staleSources.length > 0 ? ` (${freshness.staleSources.join(', ')})` : ''}. Refresh diagnostics and try again.`,
      output: errorCount > 0
        ? 'Completion is blocked because edited files still have diagnostics errors. Fix errors in touched files, then call attempt_completion again.'
        : freshness.status === 'updating'
          ? 'Completion is blocked because diagnostics are still updating. Wait for diagnostics to settle, re-run diagnostics, then call attempt_completion again.'
          : 'Completion is blocked because diagnostics are stale. Refresh diagnostics or wait for LSP recovery, then call attempt_completion again.',
    };
  }

  if (structuralMutationPaths.length > 0) {
    return {
      shouldBlock: true,
      code: 'COMPLETION_BLOCKED_BY_STRUCTURAL_MUTATION',
      message: `Completion blocked because structural changes were made (${structuralMutationPaths.join(', ')}). Re-check affected files and rerun diagnostics before calling attempt_completion again.`,
      output:
        'Completion is blocked because the task made structural changes such as rename/delete/create-dir. Re-open affected files or rerun diagnostics/verification, then call attempt_completion again.',
    };
  }

  return { shouldBlock: false };
}
