import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  setProblemsForFileMock,
  clearProblemsForFileMock,
} = vi.hoisted(() => ({
  setProblemsForFileMock: vi.fn(),
  clearProblemsForFileMock: vi.fn(),
}));

vi.mock('$shared/stores/problems.svelte', () => ({
  problemsStore: {
    setProblemsForFile: setProblemsForFileMock,
    clearProblemsForFile: clearProblemsForFileMock,
  },
}));

vi.mock('./terminal-client', () => ({
  onTerminalData: vi.fn(async () => () => {}),
  onTerminalExit: vi.fn(async () => () => {}),
}));

import {
  TerminalProblemMatcher,
  setTerminalProblemMatcherProjectRootResolver,
} from './terminal-problem-matcher';

function latestSetProblemsCall(): [string, Array<{ message: string }>, string] {
  const calls = setProblemsForFileMock.mock.calls;
  return calls[calls.length - 1] as [string, Array<{ message: string }>, string];
}

describe('TerminalProblemMatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTerminalProblemMatcherProjectRootResolver(() => 'c:/repo');
  });

  it('removes only the exiting terminal problems for a file/source pair', async () => {
    const matcher = new TerminalProblemMatcher();

    await (matcher as any).addProblem(
      'terminal-a',
      { file: 'src/main.ts', line: 10, column: 4, severity: 'error', message: 'first terminal error' },
      'terminal',
    );
    await (matcher as any).addProblem(
      'terminal-b',
      { file: 'src/main.ts', line: 10, column: 4, severity: 'error', message: 'second terminal error' },
      'terminal',
    );

    expect(latestSetProblemsCall()[1].map((problem) => problem.message)).toEqual([
      'first terminal error',
      'second terminal error',
    ]);

    await (matcher as any).handleTerminalExit('terminal-a');

    expect(latestSetProblemsCall()[1].map((problem) => problem.message)).toEqual([
      'second terminal error',
    ]);
    expect(clearProblemsForFileMock).not.toHaveBeenCalled();

    await (matcher as any).handleTerminalExit('terminal-b');

    expect(clearProblemsForFileMock).toHaveBeenCalledWith('c:/repo/src/main.ts', 'terminal');
  });

  it('keeps distinct diagnostics that share a location and long common prefix', async () => {
    const matcher = new TerminalProblemMatcher();
    const prefix = 'Shared prefix that exceeds twenty chars ';

    await (matcher as any).addProblem(
      'terminal-a',
      { file: 'src/app.ts', line: 5, column: 2, severity: 'error', message: `${prefix}alpha` },
      'terminal',
    );
    await (matcher as any).addProblem(
      'terminal-a',
      { file: 'src/app.ts', line: 5, column: 2, severity: 'error', message: `${prefix}beta` },
      'terminal',
    );

    expect(latestSetProblemsCall()[1].map((problem) => problem.message)).toEqual([
      `${prefix}alpha`,
      `${prefix}beta`,
    ]);
  });
});
