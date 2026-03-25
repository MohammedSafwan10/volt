import { describe, expect, it } from 'vitest';

import ProblemsView from './ProblemsView.svelte';

describe('ProblemsView layout guards', () => {
  const source = ProblemsView.toString().replace(/\s+/g, ' ');

  it('renders a panel body wrapper for empty states', () => {
    expect(source).toContain('panel-body empty-state-shell');
  });

  it('keeps empty states inside the shared flex panel body shell', () => {
    expect(source).toContain('class="panel-body empty-state-shell');
    expect(source).toContain('class="empty-state');
    expect(source).toContain('No current problems, but some diagnostics sources are stale');
    expect(source).toContain('No current problems; diagnostics are still warming up');
    expect(source).toContain('No current problems yet; diagnostics are still updating');
    expect(source).toContain('No errors or warnings detected in the workspace');
    expect(source).toContain('No Matching Problems');
    expect(source).toContain('problems hidden by filters');
  });
});
