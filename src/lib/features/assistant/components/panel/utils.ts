import { resolvePath } from '$core/ai/tools/utils';
import type { ToolResult } from '$core/ai/tools';

export type VerificationProfile = {
  id: string;
  label: string;
  commandPattern: RegExp;
  suggestedCommands: string[];
  requiresTerminalVerification: boolean;
};

export interface CompactWorkingSetInput {
  goal: string;
  touchedFiles: string[];
  lastMeaningfulAction?: string | null;
  failureClass?: string | null;
  pendingVerification?: string[];
  openBlocker?: string | null;
}

export function normalizeQueueKey(path: string): string {
  if (!path) return path;
  const resolved = resolvePath(path);
  const normalized = resolved.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

export function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function getToolIdempotencyKey(
  scopeId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  return `${scopeId}:${toolCallId}:${toolName}:${stableStringify(args)}`;
}

export function buildVerificationCommandGuidance(
  profiles: VerificationProfile[],
): string {
  const suggestions = profiles
    .flatMap((p) => p.suggestedCommands)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 4);
  if (suggestions.length === 0) return 'Run a relevant validation command.';
  return `Run at least one relevant terminal verification command, for example: ${suggestions.map((s) => `\`${s}\``).join(', ')}.`;
}

export function buildCompactWorkingSetSummary(
  input: CompactWorkingSetInput,
): string {
  const touched = input.touchedFiles.slice(0, 8);
  const pending = (input.pendingVerification ?? []).slice(0, 6);
  const lines = [
    `goal: ${JSON.stringify(input.goal.trim() || 'Continue current task')}`,
    `touched_files: [${touched.map((value) => JSON.stringify(value)).join(', ')}]`,
    `last_meaningful_action: ${JSON.stringify(input.lastMeaningfulAction?.trim() || 'none')}`,
    `failure_class: ${JSON.stringify(input.failureClass?.trim() || 'none')}`,
    `pending_verification: [${pending.map((value) => JSON.stringify(value)).join(', ')}]`,
    `open_blocker: ${JSON.stringify(input.openBlocker?.trim() || 'none')}`,
  ];
  return lines.join('\n');
}

export function isTerminalVerificationCommand(
  command: string,
  profiles: VerificationProfile[],
): boolean {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return false;
  return profiles.some((profile) => profile.commandPattern.test(cmd));
}

export function isVerificationTool(
  toolName: string,
  args: Record<string, unknown>,
  profiles: VerificationProfile[],
): boolean {
  if (toolName === 'get_diagnostics' || toolName.startsWith('lsp_')) {
    return true;
  }
  if (toolName === 'run_command') {
    return isTerminalVerificationCommand(String(args.command ?? ''), profiles);
  }
  if (
    toolName === 'browser_get_errors' ||
    toolName === 'browser_get_console_logs' ||
    toolName === 'browser_get_summary' ||
    toolName === 'browser_get_network_requests' ||
    toolName === 'browser_get_application_storage' ||
    toolName === 'browser_get_security_report'
  ) {
    return true;
  }
  return false;
}

export function hasStructuredCompletionReport(content: string): boolean {
  const hasChanges =
    /\b(changed|updated|modified|created|deleted|refactored|files?\s+(changed|updated|touched))\b/i.test(
      content,
    );
  const hasVerification =
    /\b(verify|verified|verification|diagnostic|diagnostics|test|tests|lint|build|check)\b/i.test(
      content,
    );
  const hasRisks =
    /\b(risk|risks|remaining|follow-?up|next steps?|limitations?)\b/i.test(
      content,
    );
  return hasChanges && hasVerification && hasRisks;
}

export function getFailureSignature(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
): string | null {
  if (result.success) return null;
  const raw = String(result.error ?? result.output ?? '').trim().toLowerCase();
  if (!raw) return null;
  const condensed = raw.replace(/\s+/g, ' ').slice(0, 220);
  const pathHint = String(args.path ?? args.filePath ?? '').toLowerCase();
  return `${toolName}:${pathHint}:${condensed}`;
}

export type RecoveryClass =
  | 'stale_file'
  | 'empty_search'
  | 'broad_search'
  | 'command_timeout'
  | 'diagnostics_blocked'
  | 'permission'
  | 'generic';

export function classifyRecoveryIssue(
  toolName: string,
  args: Record<string, unknown>,
  result: { success: boolean; error?: string; output?: string },
): RecoveryClass | null {
  if (result.success) return null;

  const error = String(result.error ?? '').toLowerCase();
  const output = String(result.output ?? '').toLowerCase();
  const combined = `${error}\n${output}`;

  if (
    combined.includes('content changed on disk') ||
    combined.includes('patch apply failed') ||
    combined.includes('version conflict') ||
    combined.includes('no match')
  ) {
    return 'stale_file';
  }

  if (toolName === 'workspace_search') {
    if (
      combined.includes('0 matches') ||
      combined.includes('no matches') ||
      combined.includes('no results')
    ) {
      return 'empty_search';
    }
    if (
      combined.includes('too many matches') ||
      combined.includes('too many results') ||
      combined.includes('broad search')
    ) {
      return 'broad_search';
    }
  }

  if (toolName === 'run_command' && combined.includes('timed out')) {
    return 'command_timeout';
  }

  if (toolName === 'get_diagnostics' && (combined.includes('blocking diagnostics') || combined.includes('diagnostic'))) {
    return 'diagnostics_blocked';
  }

  if (combined.includes('permission') || combined.includes('denied')) {
    return 'permission';
  }

  return 'generic';
}

export function buildRecoveryHint(
  recoveryClass: RecoveryClass,
  context?: { toolName?: string; path?: string },
): string {
  const pathText = context?.path ? ` for \`${context.path}\`` : '';
  switch (recoveryClass) {
    case 'stale_file':
      return `Previous edit context is stale${pathText}. Re-read the file with a focused slice, rebuild a smaller patch from fresh content, then retry once.`;
    case 'empty_search':
      return 'Search returned nothing. Retry once with alternate casing, a related symbol, or a narrower folder/file pattern.';
    case 'broad_search':
      return 'Search was too broad. Add includePattern or more specific query terms before searching again.';
    case 'command_timeout':
      return 'The command timed out. Do not repeat it unchanged; switch to a narrower validator or use read/search tools if this was exploration.';
    case 'diagnostics_blocked':
      return 'Diagnostics are still blocking completion. Fix the touched file errors or explain the exact blocker before attempting completion.';
    case 'permission':
      return 'This failed due to permissions or approval constraints. Choose a safer alternative or wait for user approval instead of retrying blindly.';
    case 'generic':
    default:
      return `The previous ${context?.toolName ?? 'tool'} attempt failed. Change strategy before retrying the same action.`;
  }
}

export function getAdaptiveFileEditConcurrency(queueCount: number): number {
  if (queueCount >= 12) return 2;
  if (queueCount >= 6) return 3;
  return 4;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const bounded = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: bounded }, () => runWorker()));
  return results;
}
