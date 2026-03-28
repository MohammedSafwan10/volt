import { describe, expect, it } from 'vitest';
import { buildRuntimeContextBlock } from '$core/ai/context/runtime-context';

describe('buildRuntimeContextBlock', () => {
  it('includes structured keys and truncates terminal list metadata correctly', () => {
    const block = buildRuntimeContextBlock({
      workspaceRoot: 'c:/repo',
      terminals: Array.from({ length: 10 }, (_, i) => ({
        id: `t${i}`,
        cwd: `c:/repo/${i}`,
        label: `terminal-${i}`,
      })),
      git: {
        isRepo: true,
        branch: 'main',
        staged: 1,
        unstaged: 2,
        untracked: 3,
        conflicted: 0,
      },
      now: new Date('2026-02-16T10:00:00.000Z'),
    });

    expect(block).toContain('# RUNTIME CONTEXT');
    expect(block).toContain('"iso_utc": "2026-02-16T10:00:00.000Z"');
    expect(block).toContain('"root": "c:/repo"');
    expect(block).toContain('"truncated": true');
    expect(block).toContain('"branch": "main"');
  });

  it('includes empty-workspace summary when the workspace has no visible root entries', () => {
    const block = buildRuntimeContextBlock({
      workspaceRoot: 'e:/volt-project/home',
      terminals: [],
      workspaceSummary: {
        rootEntryCount: 0,
        rootEntries: [],
        isProbablyEmpty: true,
      },
      now: new Date('2026-03-28T12:00:00.000Z'),
    });

    expect(block).toContain('"root_entry_count": 0');
    expect(block).toContain('"is_probably_empty": true');
    expect(block).toContain('"root_entries": []');
  });
});
