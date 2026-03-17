export type ReadEvidenceKind = 'outline' | 'read';

export interface ReadEvidenceRecord {
  kind: ReadEvidenceKind;
  timestamp: number;
  ranges?: Array<{ start: number; end: number }>;
  symbol?: string;
}

export interface FreshReadCheckResult {
  ok: boolean;
  kindRequired: ReadEvidenceKind;
  kindFound?: ReadEvidenceKind;
  reason?: 'missing_read' | 'stale_after_write';
}

function parseLineNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function collectReadPaths(
  toolName: string,
  args: Record<string, unknown>,
): Array<{ path: string; kind: ReadEvidenceKind; ranges?: Array<{ start: number; end: number }>; symbol?: string }> {
  const records: Array<{ path: string; kind: ReadEvidenceKind; ranges?: Array<{ start: number; end: number }>; symbol?: string }> = [];

  if (toolName === 'read_file') {
    const path = typeof args.path === 'string' ? args.path : '';
    if (!path) return records;
    const offsetRaw =
      typeof args.offset === 'number' ? args.offset : Number(args.offset);
    const limitRaw =
      typeof args.limit === 'number' ? args.limit : Number(args.limit);
    const hasOffset = Number.isFinite(offsetRaw);
    const hasLimit = Number.isFinite(limitRaw);
    let ranges: Array<{ start: number; end: number }> | undefined;
    if (hasOffset || hasLimit) {
      const offset = hasOffset ? Math.max(0, Math.floor(offsetRaw)) : 0;
      const limit = hasLimit ? Math.max(1, Math.floor(limitRaw)) : 120;
      const start = offset + 1;
      const end = Math.max(start, start + limit - 1);
      ranges = [{ start, end }];
    } else {
      const start = parseLineNumber(args.start_line ?? args.startLine);
      const end = parseLineNumber(args.end_line ?? args.endLine);
      ranges = start && end && end >= start ? [{ start, end }] : undefined;
    }
    records.push({ path, kind: 'read', ranges });
    return records;
  }

  if (toolName === 'read_code') {
    const path = typeof args.path === 'string' ? args.path : '';
    const symbol = typeof args.symbol === 'string' && args.symbol.trim() ? args.symbol.trim() : undefined;
    if (path) records.push({ path, kind: 'read', symbol });
    return records;
  }

  if (toolName === 'read_files') {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    for (const value of paths) {
      if (typeof value === 'string' && value.trim()) {
        records.push({ path: value, kind: 'read' });
      }
    }
    return records;
  }

  if (toolName === 'file_outline') {
    const path = typeof args.path === 'string' ? args.path : '';
    if (path) records.push({ path, kind: 'outline' });
    return records;
  }

  if (toolName === 'list_dir') {
    const path = typeof args.path === 'string' ? args.path : '';
    if (path) records.push({ path, kind: 'outline' });
  }

  return records;
}

function collectMutatingPaths(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  switch (toolName) {
    case 'write_file':
    case 'append_file':
    case 'str_replace':
    case 'multi_replace':
    case 'replace_lines':
    case 'apply_patch':
    case 'delete_file':
    {
      return typeof args.path === 'string' && args.path.trim() ? [args.path] : [];
    }
    case 'rename_path': {
      const out: string[] = [];
      if (typeof args.oldPath === 'string' && args.oldPath.trim()) out.push(args.oldPath);
      if (typeof args.newPath === 'string' && args.newPath.trim()) out.push(args.newPath);
      return out;
    }
    default:
      return [];
  }
}

export class ToolLoopState {
  readonly readEvidenceByPath = new Map<string, ReadEvidenceRecord>();
  readonly lastWriteByPath = new Map<string, number>();

  private toKey(path: string): string {
    if (!path) return path;
    let normalized = path.replace(/\\/g, '/').trim();
    normalized = normalized.replace(/^\.\/+/, '');
    normalized = normalized.replace(/\/\.\//g, '/');
    normalized = normalized.replace(/\/+/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) {
      return normalized.toLowerCase();
    }
    return normalized;
  }

  markRead(
    path: string,
    record: Omit<ReadEvidenceRecord, 'timestamp'>,
    timestamp = Date.now(),
  ): void {
    const key = this.toKey(path);
    const existing = this.readEvidenceByPath.get(key);
    const nextKind: ReadEvidenceKind =
      existing?.kind === 'read' || record.kind === 'read' ? 'read' : 'outline';
    this.readEvidenceByPath.set(key, {
      kind: nextKind,
      timestamp,
      ranges: record.ranges ?? existing?.ranges,
      symbol: record.symbol ?? existing?.symbol,
    });
  }

  markWrite(path: string, timestamp = Date.now()): void {
    this.lastWriteByPath.set(this.toKey(path), timestamp);
  }

  recordToolOutcome(
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean },
    timestamp = Date.now(),
  ): void {
    if (!result.success) return;

    const readPaths = collectReadPaths(toolName, args);
    for (const entry of readPaths) {
      this.markRead(
        entry.path,
        {
          kind: entry.kind,
          ranges: entry.ranges,
          symbol: entry.symbol,
        },
        timestamp,
      );
    }

    const writtenPaths = collectMutatingPaths(toolName, args);
    for (const path of writtenPaths) {
      this.markWrite(path, timestamp);
    }
  }

  checkFreshRead(path: string, kindRequired: ReadEvidenceKind): FreshReadCheckResult {
    const key = this.toKey(path);
    const evidence = this.readEvidenceByPath.get(key);
    if (!evidence) {
      return { ok: false, kindRequired, reason: 'missing_read' };
    }
    if (kindRequired === 'read' && evidence.kind !== 'read') {
      return { ok: false, kindRequired, kindFound: evidence.kind, reason: 'missing_read' };
    }

    const lastWrite = this.lastWriteByPath.get(key);
    if (typeof lastWrite === 'number' && lastWrite >= evidence.timestamp) {
      return {
        ok: false,
        kindRequired,
        kindFound: evidence.kind,
        reason: 'stale_after_write',
      };
    }

    return { ok: true, kindRequired, kindFound: evidence.kind };
  }
}

export function createToolLoopState(): ToolLoopState {
  return new ToolLoopState();
}
