import { describe, expect, it } from 'vitest';

import {
  DIAGNOSTICS_FRESH_MS,
  DIAGNOSTICS_WARMING_MS,
  getDiagnosticSourceHealth,
  summarizeDiagnosticSources,
} from './diagnostics-freshness';

describe('diagnostics-freshness', () => {
  it('marks updating sources as updating regardless of age', () => {
    expect(getDiagnosticSourceHealth(0, true, false, 1_000)).toBe('updating');
    expect(getDiagnosticSourceHealth(1, true, false, 99_999)).toBe('updating');
  });

  it('classifies fresh and stale sources by last update age', () => {
    expect(getDiagnosticSourceHealth(10_000, false, false, 10_000 + DIAGNOSTICS_FRESH_MS - 1)).toBe('fresh');
    expect(getDiagnosticSourceHealth(10_000, false, false, 10_000 + DIAGNOSTICS_FRESH_MS + 1)).toBe('warming');
    expect(getDiagnosticSourceHealth(10_000, false, false, 10_000 + DIAGNOSTICS_WARMING_MS + 1)).toBe('stale');
    expect(getDiagnosticSourceHealth(50_000, false, true, 50_001)).toBe('stale');
    expect(getDiagnosticSourceHealth(0, false, false, 10_000)).toBe('idle');
  });

  it('summarizes mixed source states', () => {
    const summary = summarizeDiagnosticSources(
      [
        { source: 'typescript', lastUpdated: 99_000, isUpdating: false, isStale: false, fileCount: 2, problemCount: 4 },
        { source: 'eslint', lastUpdated: 60_000, isUpdating: false, isStale: false, fileCount: 1, problemCount: 1 },
        { source: 'svelte', lastUpdated: 0, isUpdating: true, isStale: false, fileCount: 0, problemCount: 0 },
      ],
      100_000,
    );

    expect(summary.status).toBe('updating');
    expect(summary.isUpdating).toBe(true);
    expect(summary.staleSources).toEqual([]);
    expect(summary.hasWarmingSources).toBe(true);
    expect(summary.activeSources).toEqual(['typescript', 'eslint', 'svelte']);
    expect(summary.sourceStatuses.map((item) => item.status)).toEqual(['fresh', 'warming', 'updating']);
  });

  it('summarizes warming status when nothing is fresh yet', () => {
    const summary = summarizeDiagnosticSources(
      [
        { source: 'eslint', lastUpdated: 20_000, isUpdating: false, isStale: false, fileCount: 2, problemCount: 2 },
      ],
      20_000 + DIAGNOSTICS_FRESH_MS + 5,
    );

    expect(summary.status).toBe('warming');
    expect(summary.hasFreshSources).toBe(false);
    expect(summary.hasWarmingSources).toBe(true);
  });

  it('prefers fresh aggregate status over unrelated stale sources', () => {
    const summary = summarizeDiagnosticSources(
      [
        { source: 'typescript', lastUpdated: 99_500, isUpdating: false, isStale: false, fileCount: 2, problemCount: 1 },
        { source: 'eslint', lastUpdated: 10_000, isUpdating: false, isStale: true, fileCount: 1, problemCount: 3 },
      ],
      100_000,
    );

    expect(summary.status).toBe('fresh');
    expect(summary.staleSources).toEqual(['eslint']);
    expect(summary.hasFreshSources).toBe(true);
  });
});
