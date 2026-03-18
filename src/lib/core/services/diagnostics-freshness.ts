export type DiagnosticSourceHealth = 'idle' | 'updating' | 'fresh' | 'warming' | 'stale';

export interface DiagnosticSourceSnapshot {
  source: string;
  lastUpdated: number;
  isUpdating: boolean;
  isStale: boolean;
  fileCount: number;
  problemCount: number;
}

export interface DiagnosticFreshnessSummary {
  status: DiagnosticSourceHealth;
  isUpdating: boolean;
  hasFreshSources: boolean;
  hasWarmingSources: boolean;
  lastUpdated: number;
  activeSources: string[];
  staleSources: string[];
  sourceStatuses: Array<DiagnosticSourceSnapshot & { status: DiagnosticSourceHealth }>;
}

export const DIAGNOSTICS_FRESH_MS = 15_000;
export const DIAGNOSTICS_WARMING_MS = 45_000;

export function getDiagnosticSourceHealth(
  lastUpdated: number,
  isUpdating: boolean,
  isStale = false,
  now = Date.now(),
): DiagnosticSourceHealth {
  if (isUpdating) return 'updating';
  if (isStale) return 'stale';
  if (!lastUpdated) return 'idle';
  if (now - lastUpdated <= DIAGNOSTICS_FRESH_MS) return 'fresh';
  if (now - lastUpdated <= DIAGNOSTICS_WARMING_MS) return 'warming';
  return 'stale';
}

export function summarizeDiagnosticSources(
  sources: DiagnosticSourceSnapshot[],
  now = Date.now(),
): DiagnosticFreshnessSummary {
  const sourceStatuses = sources.map((source) => ({
    ...source,
    status: getDiagnosticSourceHealth(
      source.lastUpdated,
      source.isUpdating,
      source.isStale,
      now,
    ),
  }));

  const activeSources = sourceStatuses.map((source) => source.source);
  const staleSources = sourceStatuses
    .filter((source) => source.status === 'stale')
    .map((source) => source.source);
  const isUpdating = sourceStatuses.some((source) => source.status === 'updating');
  const hasFreshSources = sourceStatuses.some((source) => source.status === 'fresh');
  const hasWarmingSources = sourceStatuses.some((source) => source.status === 'warming');
  const lastUpdated = sourceStatuses.reduce(
    (latest, source) => Math.max(latest, source.lastUpdated),
    0,
  );

  let status: DiagnosticSourceHealth = 'idle';
  if (isUpdating) {
    status = 'updating';
  } else if (hasFreshSources) {
    status = 'fresh';
  } else if (hasWarmingSources) {
    status = 'warming';
  } else if (staleSources.length > 0) {
    status = 'stale';
  }

  return {
    status,
    isUpdating,
    hasFreshSources,
    hasWarmingSources,
    lastUpdated,
    activeSources,
    staleSources,
    sourceStatuses,
  };
}
