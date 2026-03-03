import { describe, expect, it } from 'vitest';

import { createToolLoopState } from './tool-loop-state';

describe('ToolLoopState', () => {
  it('requires read before edit', () => {
    const state = createToolLoopState();
    const check = state.checkFreshRead('src/app.ts', 'read');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('missing_read');
  });

  it('accepts read_file evidence for edits', () => {
    const state = createToolLoopState();
    state.recordToolOutcome('read_file', { path: 'src/app.ts' }, { success: true }, 10);
    const check = state.checkFreshRead('src/app.ts', 'read');
    expect(check.ok).toBe(true);
  });

  it('accepts read_file offset/limit evidence for apply_patch guard', () => {
    const state = createToolLoopState();
    state.recordToolOutcome(
      'read_file',
      { path: 'src/app.ts', offset: 40, limit: 80 },
      { success: true },
      10,
    );
    const check = state.checkFreshRead('src/app.ts', 'read');
    expect(check.ok).toBe(true);
    const record = state.readEvidenceByPath.get('src/app.ts');
    expect(record?.ranges?.[0]).toEqual({ start: 41, end: 120 });
  });

  it('normalizes relative path variants for read/write freshness checks', () => {
    const state = createToolLoopState();
    state.recordToolOutcome(
      'read_file',
      { path: './style.css', offset: 0, limit: 120 },
      { success: true },
      10,
    );
    const check = state.checkFreshRead('style.css', 'read');
    expect(check.ok).toBe(true);
  });

  it('invalidates read evidence after a successful write', () => {
    const state = createToolLoopState();
    state.recordToolOutcome('read_file', { path: 'src/app.ts' }, { success: true }, 10);
    state.recordToolOutcome('str_replace', { path: 'src/app.ts' }, { success: true }, 20);
    const check = state.checkFreshRead('src/app.ts', 'read');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('stale_after_write');
  });

  it('allows outline evidence for delete checks', () => {
    const state = createToolLoopState();
    state.recordToolOutcome('file_outline', { path: 'src/app.ts' }, { success: true }, 10);
    const check = state.checkFreshRead('src/app.ts', 'outline');
    expect(check.ok).toBe(true);
  });

  it('records read_code symbol metadata as read evidence', () => {
    const state = createToolLoopState();
    state.recordToolOutcome(
      'read_code',
      { path: 'src/app.ts', symbol: 'renderGame' },
      { success: true },
      10,
    );
    const record = state.readEvidenceByPath.get('src/app.ts');
    expect(record?.kind).toBe('read');
    expect(record?.symbol).toBe('renderGame');
  });
});
