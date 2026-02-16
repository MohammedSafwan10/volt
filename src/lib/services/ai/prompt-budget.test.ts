import { describe, expect, it } from 'vitest';
import { joinPromptWithBudget } from './prompt-budget';

describe('joinPromptWithBudget', () => {
  it('fits prompt under budget and appends budget marker when compacted', () => {
    const parts = [
      '# CORE\n' + 'a'.repeat(2000),
      '# LARGE PROJECT STRATEGY\n' + 'b'.repeat(3000),
      '# CONTEXT AWARENESS\n' + 'c'.repeat(3000),
      '# ERROR RECOVERY\n' + 'd'.repeat(3000),
    ];
    const out = joinPromptWithBudget(parts, 5000);
    expect(out.length).toBeLessThanOrEqual(5064);
    expect(out).toContain('# PROMPT BUDGET');
  });
});

