import { describe, expect, it } from 'vitest';

type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint';

interface ProblemLike {
  id: string;
  file: string;
  message: string;
  severity: ProblemSeverity;
  source: string;
  code?: string;
}

function getVisibleFilePaths(problems: ProblemLike[]): string[] {
  const visibleFiles = new Set<string>();

  for (const problem of problems) {
    visibleFiles.add(problem.file);
  }

  return Array.from(visibleFiles);
}

function getVisibleProblemsForFile(
  filePath: string,
  problems: ProblemLike[],
): ProblemLike[] {
  return problems.filter((problem) => problem.file === filePath);
}

describe('problems view model', () => {
  it('keeps file order aligned to first visible deduped problem occurrence', () => {
    const problems: ProblemLike[] = [
      {
        id: 'a',
        file: 'c:/repo/src/b.ts',
        message: 'b error',
        severity: 'error',
        source: 'typescript',
      },
      {
        id: 'b',
        file: 'c:/repo/src/a.ts',
        message: 'a warning',
        severity: 'warning',
        source: 'eslint',
      },
      {
        id: 'c',
        file: 'c:/repo/src/b.ts',
        message: 'b warning',
        severity: 'warning',
        source: 'eslint',
      },
    ];

    expect(getVisibleFilePaths(problems)).toEqual([
      'c:/repo/src/b.ts',
      'c:/repo/src/a.ts',
    ]);
    expect(getVisibleProblemsForFile('c:/repo/src/b.ts', problems).map((problem) => problem.id)).toEqual(['a', 'c']);
  });
});
