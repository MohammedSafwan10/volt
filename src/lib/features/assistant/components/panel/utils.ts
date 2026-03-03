import { resolvePath } from '$core/ai/tools/utils';
import type { ToolResult } from '$core/ai/tools';

export type VerificationProfile = {
  id: string;
  label: string;
  commandPattern: RegExp;
  suggestedCommands: string[];
  requiresTerminalVerification: boolean;
};

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
