import { describe, expect, it } from 'vitest';

import { matchesRequestedDiagnosticPath } from './diagnostics-paths';

describe('diagnostics path matching', () => {
  it('matches exact normalized paths only', () => {
    expect(matchesRequestedDiagnosticPath('src/index.ts', 'src/index.ts')).toBe(true);
    expect(matchesRequestedDiagnosticPath('src/routes/index.ts', 'index.ts')).toBe(false);
    expect(matchesRequestedDiagnosticPath('src/routes/index.ts', 'src/index.ts')).toBe(false);
  });
});
