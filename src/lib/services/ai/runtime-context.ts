export interface RuntimeTerminalSummary {
  id: string;
  cwd?: string;
  label?: string;
}

export interface RuntimeGitSummary {
  isRepo: boolean;
  branch?: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface RuntimeContextInput {
  workspaceRoot?: string | null;
  terminals?: RuntimeTerminalSummary[];
  git?: RuntimeGitSummary;
  now?: Date;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildRuntimeContextBlock(input: RuntimeContextInput): string {
  const now = input.now ?? new Date();
  const localOffsetMinutes = -now.getTimezoneOffset();
  const sign = localOffsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(localOffsetMinutes);
  const hh = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const mm = String(absMinutes % 60).padStart(2, '0');
  const timezoneOffset = `${sign}${hh}:${mm}`;

  const terminals = (input.terminals ?? []).slice(0, 8).map((terminal) => ({
    id: terminal.id,
    label: safeString(terminal.label) ?? null,
    cwd: safeString(terminal.cwd) ?? null,
  }));

  const payload = {
    time: {
      iso_utc: now.toISOString(),
      local: now.toLocaleString(),
      timezone_offset: timezoneOffset,
    },
    workspace: {
      root: safeString(input.workspaceRoot ?? undefined) ?? null,
    },
    active_terminals: {
      count: input.terminals?.length ?? 0,
      items: terminals,
      truncated: (input.terminals?.length ?? 0) > terminals.length,
    },
    git_status: input.git ?? {
      isRepo: false,
      branch: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
  };

  return [
    '# RUNTIME CONTEXT',
    'Use this structured runtime context for all time- and environment-sensitive decisions.',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}
