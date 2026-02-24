import { describe, expect, it } from 'vitest';

import { createContextBudget } from './context-budget';

describe('context-budget', () => {
  it('honors model limits and lane caps within total budget', () => {
    const budget = createContextBudget('mistralai/mistral-small-3.1-24b-instruct:free');

    expect(budget.availableContextTokens).toBeGreaterThan(0);
    expect(budget.availableContextTokens).toBeLessThanOrEqual(48_000);

    const laneTotal = Object.values(budget.laneBudgets).reduce((sum, value) => sum + value, 0);
    expect(laneTotal).toBeLessThanOrEqual(budget.availableContextTokens + 32);
    expect(budget.reserveOutputTokens).toBeGreaterThan(0);
    expect(budget.reserveSystemTokens).toBeGreaterThan(0);
  });

  it('is deterministic for same model and options', () => {
    const a = createContextBudget('mistralai/mistral-small-3.1-24b-instruct:free', {
      reserveOutputTokens: 6000,
      reserveSystemTokens: 5000,
      safetyTokens: 1200,
    });
    const b = createContextBudget('mistralai/mistral-small-3.1-24b-instruct:free', {
      reserveOutputTokens: 6000,
      reserveSystemTokens: 5000,
      safetyTokens: 1200,
    });

    expect(a).toEqual(b);
  });
});
