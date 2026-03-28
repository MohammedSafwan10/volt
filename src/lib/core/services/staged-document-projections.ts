import type {
  DiagnosticsBasis,
  DiagnosticsFreshness,
  StagedResourceRecord,
  StructuralMutationDetails,
} from './staged-document-service';

export interface TreeMutationProjection {
  kind: 'file' | 'directory';
  state: StagedResourceRecord['state'];
  previousPath?: string;
  nextPath?: string;
  structuralMutation?: StructuralMutationDetails;
}

export interface DiagnosticsStateProjection {
  basis: DiagnosticsBasis;
  freshness: DiagnosticsFreshness;
}

export function projectTreeMutationState(
  records: readonly StagedResourceRecord[],
): Record<string, TreeMutationProjection> {
  const duplicatePaths = new Set<string>();
  const seenPaths = new Set<string>();

  for (const record of records) {
    if (seenPaths.has(record.path)) {
      duplicatePaths.add(record.path);
      continue;
    }

    seenPaths.add(record.path);
  }

  if (duplicatePaths.size > 0) {
    throw new Error(
      `projectTreeMutationState received duplicate record paths: ${Array.from(duplicatePaths).join(', ')}`,
    );
  }

  return Object.fromEntries(
    records.map((record) => [
      record.path,
      {
        kind: record.kind,
        state: record.state,
        previousPath: record.previousPath,
        nextPath: record.nextPath,
        structuralMutation: record.structuralMutation,
      },
    ]),
  );
}

export function projectDiagnosticsState(
  record: StagedResourceRecord | null,
): DiagnosticsStateProjection {
  return {
    basis: record?.diagnosticsBasis ?? 'committed_disk',
    freshness: record?.diagnosticsFreshness ?? 'fresh',
  };
}
