import type { AgentLoopState } from '$features/assistant/stores/assistant/loop-state';
import type {
  SpecPhase,
  SpecVerificationPayload,
  SpecTaskStatus,
  VoltSpecContext,
  VoltSpecManifest,
  VoltSpecTask,
} from '$features/specs/types';

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function ensureTrailingNewline(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trimEnd();
  return normalized.length > 0 ? `${normalized}\n` : '';
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'spec';
}

export function phaseFromPath(path: string): SpecPhase | null {
  const normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith('/requirements.md')) return 'requirements';
  if (normalized.endsWith('/design.md')) return 'design';
  if (normalized.endsWith('/tasks.md')) return 'tasks';
  return null;
}

export function isRuntimeActive(state: AgentLoopState, isStreaming: boolean): boolean {
  return (
    isStreaming ||
    state === 'running' ||
    state === 'waiting_tool' ||
    state === 'waiting_approval' ||
    state === 'completing'
  );
}

export function renderTaskCheckbox(status: SpecTaskStatus): string {
  return status === 'done' ? '[x]' : '[ ]';
}

export function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

export function parseTaggedJson<T>(content: string): T | null {
  const tagged = content.match(/<volt-spec-json>\s*([\s\S]*?)\s*<\/volt-spec-json>/i);
  if (tagged?.[1]) {
    try {
      return JSON.parse(tagged[1]) as T;
    } catch {
      return null;
    }
  }

  const fenced = content.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      return null;
    }
  }

  return null;
}

export function parseVerificationTaggedJson(content: string): SpecVerificationPayload | null {
  const tagged = content.match(/<volt-spec-verify-json>\s*([\s\S]*?)\s*<\/volt-spec-verify-json>/i);
  if (!tagged?.[1]) return null;

  try {
    return JSON.parse(tagged[1]) as SpecVerificationPayload;
  } catch {
    return null;
  }
}

export function summarizeAssistantExcerpt(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const excerpt = content.replace(/\s+/g, ' ').trim();
  return excerpt.length > 240 ? `${excerpt.slice(0, 237)}...` : excerpt;
}

export function parseTaskCheckboxStates(
  content: string,
  taskIds: string[],
): Map<string, 'done' | 'todo'> {
  const states = new Map<string, 'done' | 'todo'>();
  const remaining = new Set(taskIds);
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)$/);
    if (!match) continue;

    const checkbox = match[1].toLowerCase() === 'x' ? 'done' : 'todo';
    const label = match[2].trim();
    for (const taskId of remaining) {
      if (label.startsWith(`${taskId}. `)) {
        states.set(taskId, checkbox);
        remaining.delete(taskId);
        break;
      }
    }
  }

  return states;
}

export function buildSpecContext(rootPath: string, slug: string): VoltSpecContext {
  const normalizedRoot = normalizePath(rootPath);
  const specDir = `${normalizedRoot}/.volt/specs/${slug}`;
  return {
    rootPath: normalizedRoot,
    specDir,
    manifestPath: `${specDir}/spec.json`,
    requirementsPath: `${specDir}/requirements.md`,
    designPath: `${specDir}/design.md`,
    tasksPath: `${specDir}/tasks.md`,
  };
}

export function sanitizeTask(rawTask: Record<string, unknown>, fallbackIndex: number): VoltSpecTask {
  const idValue = typeof rawTask.id === 'string' && rawTask.id.trim().length > 0
    ? rawTask.id.trim()
    : String(fallbackIndex + 1);
  const titleValue = typeof rawTask.title === 'string' && rawTask.title.trim().length > 0
    ? rawTask.title.trim()
    : `Task ${idValue}`;
  const summary = typeof rawTask.summary === 'string' ? rawTask.summary.trim() : '';
  const verification = typeof rawTask.verification === 'string'
    ? rawTask.verification.trim()
    : 'Run relevant diagnostics and targeted verification.';

  return {
    id: idValue,
    title: titleValue,
    summary,
    requirementIds: sanitizeStringArray(rawTask.requirementIds),
    dependencyIds: sanitizeStringArray(rawTask.dependencyIds),
    scopeHints: sanitizeStringArray(rawTask.scopeHints),
    verification,
    status: 'todo',
    runs: [],
    verifications: [],
  };
}

export function renderTasksMarkdown(spec: VoltSpecManifest): string {
  const lines: string[] = [
    `# Task List: ${spec.title}`,
    '',
    '## Overview',
    '',
    `Status: ${spec.status}`,
    '',
    '## Tasks',
    '',
  ];

  for (const task of spec.tasks) {
    const latestRun = task.latestRunId ? task.runs.find((run) => run.runId === task.latestRunId) : undefined;
    lines.push(`- ${renderTaskCheckbox(task.status)} ${task.id}. ${task.title}`);
    lines.push(`  <!-- volt:task ${task.id} -->`);
    if (task.summary) lines.push(`  - Summary: ${task.summary}`);
    if (task.requirementIds.length > 0) lines.push(`  - Requirements: ${task.requirementIds.join(', ')}`);
    if (task.dependencyIds.length > 0) lines.push(`  - Depends on: ${task.dependencyIds.join(', ')}`);
    if (task.scopeHints.length > 0) lines.push(`  - Scope hints: ${task.scopeHints.join(', ')}`);
    if (task.verification) lines.push(`  - Verification: ${task.verification}`);
    if (latestRun) {
      lines.push(`  - Latest run: ${latestRun.status}`);
      if (latestRun.lastStatusMessage) lines.push(`  - Run status: ${latestRun.lastStatusMessage}`);
      if (latestRun.lastAssistantExcerpt) lines.push(`  - Assistant: ${latestRun.lastAssistantExcerpt}`);
      if (latestRun.error) lines.push(`  - Error: ${latestRun.error}`);
    }
    const latestVerification = task.latestVerificationId
      ? task.verifications.find((entry) => entry.verificationId === task.latestVerificationId)
      : undefined;
    if (latestVerification) {
      lines.push(`  - Latest verification: ${latestVerification.status}${latestVerification.isStale ? ' (stale)' : ''}`);
      if (typeof latestVerification.completenessScore === 'number') {
        lines.push(
          `  - Verification scores: completeness ${latestVerification.completenessScore}/10, quality ${latestVerification.qualityScore ?? '-'}, spec adherence ${latestVerification.specAdherenceScore ?? '-'}`,
        );
      }
      if (latestVerification.summary) lines.push(`  - Review summary: ${latestVerification.summary}`);
      if (latestVerification.error) lines.push(`  - Review error: ${latestVerification.error}`);
    }
    lines.push('');
  }

  return ensureTrailingNewline(lines.join('\n'));
}

export function findTaskLineNumber(spec: VoltSpecManifest, taskId: string): number | null {
  const markdown = renderTasksMarkdown(spec);
  const lines = markdown.split('\n');
  const marker = `<!-- volt:task ${taskId} -->`;
  const markerIndex = lines.findIndex((line) => line.includes(marker));
  if (markerIndex === -1) return null;

  // Prefer the visible checkbox/title line immediately above the metadata marker.
  return Math.max(1, markerIndex);
}
