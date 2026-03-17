import { describe, expect, it } from 'vitest';

import ProblemsView from './ProblemsView.svelte';

describe('ProblemsView layout guards', () => {
  it('renders a panel body wrapper for empty states', () => {
    const source = ProblemsView.toString();
    expect(source).toContain('panel-body empty-state-shell');
  });

  it('uses flex-based empty state layout instead of height 100%', () => {
    const source = ProblemsView.toString();
    expect(source).toContain('.panel-body');
    expect(source).toContain('flex: 1');
    expect(source).not.toContain('height: 100%');
  });
});
