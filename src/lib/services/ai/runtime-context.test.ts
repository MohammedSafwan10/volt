import { describe, expect, it } from 'vitest';
import { buildRuntimeContextBlock } from './runtime-context';

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
});

