export interface StructuralVerificationPlan {
  requiresFollowUp: boolean;
  recommendedTools: string[];
  notes: string[];
}

export function buildStructuralVerificationPlan(paths: string[]): StructuralVerificationPlan {
  if (paths.length === 0) {
    return { requiresFollowUp: false, recommendedTools: [], notes: [] };
  }

  return {
    requiresFollowUp: true,
    recommendedTools: ['get_diagnostics', 'read_file', 'list_dir'],
    notes: [
      'Re-open moved or deleted paths to verify final workspace state.',
      'Re-run diagnostics after structural changes before attempting completion.',
      'Inspect nearby imports/references that may still point to old paths.',
    ],
  };
}
