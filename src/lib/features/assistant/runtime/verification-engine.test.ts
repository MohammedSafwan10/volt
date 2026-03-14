import { describe, expect, it } from 'vitest';

import { buildStructuralVerificationPlan } from './verification-engine';

describe('verification engine', () => {
  it('recommends follow-up steps for structural mutations', () => {
    const plan = buildStructuralVerificationPlan(['src/renamed.ts']);

    expect(plan.requiresFollowUp).toBe(true);
    expect(plan.recommendedTools).toEqual(['get_diagnostics', 'read_file', 'list_dir']);
    expect(plan.notes.length).toBeGreaterThan(0);
  });
});
