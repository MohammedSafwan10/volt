import { describe, expect, it, vi } from 'vitest';

import {
  DIAGNOSTICS_FRESH_MS,
  DIAGNOSTICS_WARMING_MS,
  getDiagnosticSourceHealth,
} from './diagnostics-freshness';

describe('diagnostics freshness timing', () => {
  it('progresses from fresh to warming to stale over time', () => {
    const now = 1_000_000;

    expect(getDiagnosticSourceHealth(now, false, false, now)).toBe('fresh');
    expect(
      getDiagnosticSourceHealth(now, false, false, now + DIAGNOSTICS_FRESH_MS + 1),
    ).toBe('warming');
    expect(
      getDiagnosticSourceHealth(now, false, false, now + DIAGNOSTICS_WARMING_MS + 1),
    ).toBe('stale');
  });

  it('keeps updating sources in updating state regardless of age', () => {
    const now = 1_000_000;
    expect(
      getDiagnosticSourceHealth(now, true, false, now + DIAGNOSTICS_WARMING_MS + 10_000),
    ).toBe('updating');
  });

  it('keeps stale sources stale regardless of age', () => {
    const now = 1_000_000;
    expect(getDiagnosticSourceHealth(now, false, true, now + 1000)).toBe('stale');
  });
});
