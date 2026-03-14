import { activityStore } from '$shared/stores/activity.svelte';
import { assistantStore } from '$features/assistant/stores/assistant.svelte';
import { editorStore, isVoltVirtualPath } from '$features/editor/stores/editor.svelte';
import { problemsStore } from '$shared/stores/problems.svelte';
import { projectStore } from '$shared/stores/project.svelte';
import { terminalStore } from '$features/terminal/stores/terminal.svelte';
import { gitStore } from '$features/git/stores/git.svelte';
import { readFileQuiet } from '$core/services/file-system';
import { getEditorSelection } from '$core/services/monaco-models';
import { createContextBudget, estimateTextTokens, type ContextBudget, type ContextLane } from '$core/ai/context/context-budget';
import { buildHybridSemanticSnippets } from '$core/ai/retrieval/semantic-retrieval';
import {
  extractCursorWindow,
  extractQueryWindow,
  getLineCount,
  getLineWindow,
  scoreSnippetCandidate,
} from '$core/ai/context/context-v2-helpers';

export type ContextSource = 'editor' | 'disk';

export interface ContextSnippet {
  id: string;
  lane: ContextLane;
  path?: string;
  title: string;
  content: string;
  startLine?: number;
  endLine?: number;
  score: number;
  source: ContextSource;
  timestamp: number;
  stale: boolean;
  tokens: number;
}

export interface ContextV2 {
  query: string;
  builtAt: number;
  workspaceRoot?: string;
  activeFilePath?: string;
  workingSetSummary?: string;
  budget: ContextBudget;
  snippets: ContextSnippet[];
  diagnosticsSummary: string;
  runtimeSummary: string;
  insufficiencyHint?: string;
  stats: {
    estimatedTokensUsed: number;
    snippetsSelected: number;
    droppedCandidates: number;
    staleSnippetCount: number;
    freshSnippetCount: number;
    buildLatencyMs: number;
    fallbackUsed: boolean;
    semanticCandidates: number;
    semanticSelected: number;
    hybridDropped: number;
    semanticQueryMs: number;
    semanticIndexStalenessMs: number;
    semanticBackend: string;
    semanticModelLoadMs: number;
    semanticLastError?: string;
  };
}

export interface BuildContextV2Input {
  query?: string;
  modelId: string;
  workingSetSummary?: string;
}

interface SnippetDraft {
  lane: ContextLane;
  path?: string;
  title: string;
  content: string;
  startLine?: number;
  endLine?: number;
  score: number;
  source: ContextSource;
  timestamp: number;
  stale: boolean;
}

interface FileSnapshot {
  path: string;
  content: string;
  source: ContextSource;
  timestamp: number;
  stale: boolean;
}

interface CachedSnapshot {
  content: string;
  source: ContextSource;
  timestamp: number;
}

const snapshotCache = new Map<string, CachedSnapshot>();
const MAX_SNIPPETS = 16;
const MAX_FILES = 10;
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function toRelativePath(path: string, root?: string | null): string {
  const normalized = normalizePath(path);
  if (!root) return normalized;
  const rootNorm = normalizePath(root).replace(/\/$/, '');
  const lowerPath = normalized.toLowerCase();
  const lowerRoot = rootNorm.toLowerCase();
  if (lowerPath === lowerRoot) return '.';
  if (lowerPath.startsWith(`${lowerRoot}/`)) {
    return normalized.slice(rootNorm.length + 1);
  }
  return normalized;
}

function collectTouchedPaths(): string[] {
  const paths: string[] = [];
  const recentMessages = assistantStore.messages.slice(-140).reverse();
  for (const msg of recentMessages) {
    const toolCalls = [
      ...(msg.toolCalls ?? []),
      ...(msg.inlineToolCalls ?? []),
    ];
    for (const tc of toolCalls) {
      if (tc.status !== 'completed') continue;
      const toolName = String(tc.name || '');
      if (!/(apply_patch|str_replace|multi_replace|replace_lines|write_file|append_file|rename_path|delete_file)/.test(toolName)) {
        continue;
      }
      const metaPath = (tc.meta as Record<string, unknown> | undefined)?.fileEdit as Record<string, unknown> | undefined;
      const rel = typeof metaPath?.relativePath === 'string' ? String(metaPath.relativePath) : '';
      const argPath = typeof tc.arguments?.path === 'string' ? String(tc.arguments.path) : '';
      const candidate = normalizePath(rel || argPath);
      if (!candidate) continue;
      if (!paths.includes(candidate)) paths.push(candidate);
      if (paths.length >= 8) return paths;
    }
  }
  return paths;
}

async function loadSnapshot(path: string): Promise<FileSnapshot | null> {
  const normalized = normalizePath(path);
  const openFile = editorStore.openFiles.find((f) => normalizePath(f.path) === normalized);
  if (openFile) {
    const snap: FileSnapshot = {
      path: normalized,
      content: openFile.content,
      source: 'editor',
      timestamp: Date.now(),
      stale: false,
    };
    snapshotCache.set(normalized, {
      content: snap.content,
      source: snap.source,
      timestamp: snap.timestamp,
    });
    return snap;
  }

  try {
    const content = await readFileQuiet(path);
    if (typeof content !== 'string' || !content) return null;

    const cached = snapshotCache.get(normalized);
    const stale = cached ? cached.content !== content : false;
    const timestamp = Date.now();
    snapshotCache.set(normalized, { content, source: 'disk', timestamp });

    return {
      path: normalized,
      content,
      source: 'disk',
      timestamp,
      stale,
    };
  } catch {
    return null;
  }
}

function buildRuntimeSummary(): string {
  const terminals = terminalStore.sessions.slice(0, 4).map((s) => ({
    cwd: s.cwd || s.info.cwd,
    label: terminalStore.getSessionLabel(s.id),
  }));
  const payload = {
    time_utc: new Date().toISOString(),
    workspace: projectStore.rootPath || null,
    terminals,
    git: {
      isRepo: gitStore.isRepo,
      branch: gitStore.status?.branch ?? null,
      staged: gitStore.status?.staged.length ?? 0,
      unstaged: gitStore.status?.unstaged.length ?? 0,
      untracked: gitStore.status?.untracked.length ?? 0,
      conflicted: gitStore.status?.conflicted.length ?? 0,
    },
  };
  return JSON.stringify(payload, null, 2);
}

function buildDiagnosticsSummary(root?: string | null): string {
  const totalErrors = problemsStore.errorCount;
  const totalWarnings = problemsStore.warningCount;
  const hotFiles = problemsStore.filesWithProblems.slice(0, 5).map((path) => {
    const list = problemsStore.getProblemsForFile(path);
    const errors = list.filter((p) => p.severity === 'error').length;
    const warnings = list.filter((p) => p.severity === 'warning').length;
    return `${toRelativePath(path, root)} (E:${errors} W:${warnings})`;
  });
  const lines = [
    `Errors: ${totalErrors}`,
    `Warnings: ${totalWarnings}`,
  ];
  if (hotFiles.length > 0) lines.push(`Top files: ${hotFiles.join(', ')}`);
  return lines.join('\n');
}

function addDraft(
  drafts: SnippetDraft[],
  laneUsage: Record<ContextLane, number>,
  budget: ContextBudget,
  state: { totalTokens: number; dropped: number },
  draft: SnippetDraft,
): void {
  const content = draft.content.trim();
  if (!content) {
    state.dropped++;
    return;
  }
  const tokens = estimateTextTokens(content);
  if (tokens <= 0) {
    state.dropped++;
    return;
  }
  const laneBudget = budget.laneBudgets[draft.lane] ?? 0;
  if (laneUsage[draft.lane] + tokens > laneBudget || state.totalTokens + tokens > budget.availableContextTokens) {
    state.dropped++;
    return;
  }
  laneUsage[draft.lane] += tokens;
  state.totalTokens += tokens;
  drafts.push(draft);
}

export async function buildContextV2(input: BuildContextV2Input): Promise<ContextV2> {
  const startedAt = Date.now();
  const query = (input.query ?? '').trim();
  const workspaceRoot = projectStore.rootPath ?? undefined;
  const budget = createContextBudget(input.modelId);
  const drafts: SnippetDraft[] = [];
  const laneUsage: Record<ContextLane, number> = {
    active: 0,
    selection: 0,
    touched: 0,
    query: 0,
    imports: 0,
    diagnostics: 0,
    runtime: 0,
  };
  const state = { totalTokens: 0, dropped: 0 };
  let hybridStats: {
    semanticCandidates: number;
    semanticSelected: number;
    hybridDropped: number;
    semanticQueryMs: number;
    semanticIndexStalenessMs: number;
    semanticBackend: string;
    semanticModelLoadMs: number;
    semanticLastError?: string;
  } | null = null;

  const active = editorStore.activeFile && !isVoltVirtualPath(editorStore.activeFile.path)
    ? editorStore.activeFile
    : null;

  if (active) {
    const cursorLine = editorStore.cursorPosition.line || 1;
    const cursorWindow = extractCursorWindow(active.content, cursorLine);
    const queryWin = query ? extractQueryWindow(active.content, query) : null;
    addDraft(drafts, laneUsage, budget, state, {
      lane: 'active',
      path: toRelativePath(active.path, workspaceRoot),
      title: `Active file focus (${toRelativePath(active.path, workspaceRoot)})`,
      content: (queryWin?.content || cursorWindow.content).slice(0, 8000),
      startLine: queryWin?.startLine || cursorWindow.startLine,
      endLine: queryWin?.endLine || cursorWindow.endLine,
      score: scoreSnippetCandidate('active', queryWin?.hitCount ?? 0, 20),
      source: 'editor',
      timestamp: Date.now(),
      stale: false,
    });
  }

  const selection = getEditorSelection();
  if (selection?.text && selection.path) {
    addDraft(drafts, laneUsage, budget, state, {
      lane: 'selection',
      path: toRelativePath(selection.path, workspaceRoot),
      title: `Editor selection (${toRelativePath(selection.path, workspaceRoot)})`,
      content: selection.text.slice(0, 4000),
      startLine: selection.range?.startLineNumber,
      endLine: selection.range?.endLineNumber,
      score: scoreSnippetCandidate('selection', query ? 1 : 0, 30),
      source: 'editor',
      timestamp: Date.now(),
      stale: false,
    });
  }

  const touchedPaths = collectTouchedPaths();
  for (const path of touchedPaths.slice(0, MAX_FILES)) {
    const snapshot = await loadSnapshot(path);
    if (!snapshot) continue;
    const queryWin = query ? extractQueryWindow(snapshot.content, query) : null;
    const lineCount = getLineCount(snapshot.content);
    const startLine = queryWin?.startLine ?? 1;
    const endLine = queryWin?.endLine ?? Math.min(lineCount, 60);
    const snippetContent = queryWin?.content ?? getLineWindow(snapshot.content, startLine, endLine);
    addDraft(drafts, laneUsage, budget, state, {
      lane: 'touched',
      path: toRelativePath(snapshot.path, workspaceRoot),
      title: `Recently touched file (${toRelativePath(snapshot.path, workspaceRoot)})`,
      content: snippetContent.slice(0, 5000),
      startLine,
      endLine,
      score: scoreSnippetCandidate('touched', queryWin?.hitCount ?? 0),
      source: snapshot.source,
      timestamp: snapshot.timestamp,
      stale: snapshot.stale,
    });
  }

  const candidateOpenFiles = editorStore.openFiles
    .filter((f) => !isVoltVirtualPath(f.path))
    .slice(0, MAX_FILES);

  if (query) {
    for (const file of candidateOpenFiles) {
      if (active && normalizePath(file.path) === normalizePath(active.path)) continue;
      const queryWin = extractQueryWindow(file.content, query);
      if (!queryWin) continue;
      addDraft(drafts, laneUsage, budget, state, {
        lane: 'query',
        path: toRelativePath(file.path, workspaceRoot),
        title: `Query evidence (${toRelativePath(file.path, workspaceRoot)})`,
        content: queryWin.content.slice(0, 4000),
        startLine: queryWin.startLine,
        endLine: queryWin.endLine,
        score: scoreSnippetCandidate('query', queryWin.hitCount),
        source: 'editor',
        timestamp: Date.now(),
        stale: false,
      });
    }
  }

  if (active) {
    const importRegex = /from\s+['\"]([^'\"]+)['\"]/g;
    const importTargets: string[] = [];
    for (const match of active.content.matchAll(importRegex)) {
      const spec = match[1] || '';
      if (!spec.startsWith('.')) continue;
      importTargets.push(spec.split('/').pop() || spec);
    }
    for (const target of importTargets.slice(0, 3)) {
      const neighbor = candidateOpenFiles.find((f) => f.name.toLowerCase().includes(target.toLowerCase()));
      if (!neighbor) continue;
      const lineCount = getLineCount(neighbor.content);
      addDraft(drafts, laneUsage, budget, state, {
        lane: 'imports',
        path: toRelativePath(neighbor.path, workspaceRoot),
        title: `Import neighbor (${toRelativePath(neighbor.path, workspaceRoot)})`,
        content: getLineWindow(neighbor.content, 1, Math.min(50, lineCount)).slice(0, 3200),
        startLine: 1,
        endLine: Math.min(50, lineCount),
        score: scoreSnippetCandidate('imports', 0),
        source: 'editor',
        timestamp: Date.now(),
        stale: false,
      });
    }
  }

  const diagnosticFiles = problemsStore.filesWithProblems.slice(0, 4);
  for (const filePath of diagnosticFiles) {
    const snapshot = await loadSnapshot(filePath);
    if (!snapshot) continue;
    const problems = problemsStore.getProblemsForFile(filePath);
    const primary = problems.find((p) => p.severity === 'error') || problems[0];
    if (!primary) continue;
    const lineCount = getLineCount(snapshot.content);
    const startLine = Math.max(1, primary.line - 5);
    const endLine = Math.min(lineCount, primary.endLine + 5);
    addDraft(drafts, laneUsage, budget, state, {
      lane: 'diagnostics',
      path: toRelativePath(filePath, workspaceRoot),
      title: `Diagnostics focus (${toRelativePath(filePath, workspaceRoot)})`,
      content: getLineWindow(snapshot.content, startLine, endLine).slice(0, 2800),
      startLine,
      endLine,
      score: scoreSnippetCandidate('diagnostics', 0, 5),
      source: snapshot.source,
      timestamp: snapshot.timestamp,
      stale: snapshot.stale,
    });
  }

  // Hybrid semantic retrieval lane: lexical + semantic candidates, then strict budget gate.
  if (query && workspaceRoot) {
    const hybrid = await buildHybridSemanticSnippets({
      rootPath: workspaceRoot,
      query,
      touchedPaths: touchedPaths.map((p) => toRelativePath(p, workspaceRoot)),
      activePath: active ? toRelativePath(active.path, workspaceRoot) : undefined,
      diagnosticsPaths: diagnosticFiles.map((p) => toRelativePath(p, workspaceRoot)),
    });
    hybridStats = {
      semanticCandidates: hybrid.semanticCandidates,
      semanticSelected: hybrid.semanticSelected,
      hybridDropped: hybrid.hybridDropped,
      semanticQueryMs: hybrid.semanticQueryMs,
      semanticIndexStalenessMs: hybrid.semanticIndexStalenessMs,
      semanticBackend: hybrid.semanticBackend,
      semanticModelLoadMs: hybrid.semanticModelLoadMs,
      semanticLastError: hybrid.semanticLastError,
    };
    for (const semantic of hybrid.snippets) {
      addDraft(drafts, laneUsage, budget, state, {
        lane: semantic.lane,
        path: semantic.path,
        title: semantic.title,
        content: semantic.content.slice(0, 3600),
        startLine: semantic.startLine,
        endLine: semantic.endLine,
        score: semantic.score,
        source: semantic.source,
        timestamp: semantic.timestamp,
        stale: semantic.stale,
      });
    }
  }

  const ranked = drafts
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SNIPPETS)
    .map((draft, index) => {
      const tokens = estimateTextTokens(draft.content);
      return {
        id: `ctxv2-${index + 1}`,
        lane: draft.lane,
        path: draft.path,
        title: draft.title,
        content: draft.content,
        startLine: draft.startLine,
        endLine: draft.endLine,
        score: draft.score,
        source: draft.source,
        timestamp: draft.timestamp,
        stale: draft.stale,
        tokens,
      } satisfies ContextSnippet;
    });

  const staleSnippetCount = ranked.filter((s) => s.stale).length;
  const freshSnippetCount = ranked.length - staleSnippetCount;
  const estimatedTokensUsed = ranked.reduce((sum, s) => sum + s.tokens, 0);

  const context: ContextV2 = {
    query,
    builtAt: Date.now(),
    workspaceRoot,
    activeFilePath: active ? toRelativePath(active.path, workspaceRoot) : undefined,
    workingSetSummary: input.workingSetSummary?.trim() || undefined,
    budget,
    snippets: ranked,
    diagnosticsSummary: buildDiagnosticsSummary(workspaceRoot),
    runtimeSummary: buildRuntimeSummary(),
    insufficiencyHint:
      ranked.length <= 1
        ? 'Context is intentionally minimal. If evidence is insufficient, use file_outline/read_file/read_code for targeted reads.'
        : undefined,
    stats: {
      estimatedTokensUsed,
      snippetsSelected: ranked.length,
      droppedCandidates: state.dropped,
      staleSnippetCount,
      freshSnippetCount,
      buildLatencyMs: Date.now() - startedAt,
      fallbackUsed: false,
      semanticCandidates: 0,
      semanticSelected: 0,
      hybridDropped: 0,
      semanticQueryMs: 0,
      semanticIndexStalenessMs: 0,
      semanticBackend: 'disabled',
      semanticModelLoadMs: 0,
    },
  };

  if (hybridStats) {
    context.stats.semanticCandidates = hybridStats.semanticCandidates;
    context.stats.semanticSelected = hybridStats.semanticSelected;
    context.stats.hybridDropped = hybridStats.hybridDropped;
    context.stats.semanticQueryMs = hybridStats.semanticQueryMs;
    context.stats.semanticIndexStalenessMs = hybridStats.semanticIndexStalenessMs;
    context.stats.semanticBackend = hybridStats.semanticBackend;
    context.stats.semanticModelLoadMs = hybridStats.semanticModelLoadMs;
    context.stats.semanticLastError = hybridStats.semanticLastError;
  }

  return context;
}

export function formatContextV2(context: ContextV2): string {
  const lines: string[] = [];
  lines.push('# CONTEXT V2');
  lines.push('Use this focused evidence pack. If missing details, run targeted read/search tools before editing.');
  if (context.workspaceRoot) lines.push(`Workspace: ${context.workspaceRoot}`);
  if (context.activeFilePath) lines.push(`Active file: ${context.activeFilePath}`);
  if (context.query) lines.push(`User query: ${context.query}`);
  if (context.workingSetSummary) {
    lines.push('## Compact Working Set');
    lines.push('```yaml');
    lines.push(context.workingSetSummary);
    lines.push('```');
  }
  lines.push(
    `Budget: ~${context.stats.estimatedTokensUsed}/${context.budget.availableContextTokens} context tokens; snippets=${context.stats.snippetsSelected}; dropped=${context.stats.droppedCandidates}`,
  );
  lines.push(
    `Hybrid retrieval: backend=${context.stats.semanticBackend}; semanticCandidates=${context.stats.semanticCandidates}; semanticSelected=${context.stats.semanticSelected}; hybridDropped=${context.stats.hybridDropped}; semanticQueryMs=${context.stats.semanticQueryMs}; modelLoadMs=${context.stats.semanticModelLoadMs}`,
  );

  lines.push('## Evidence Snippets');
  if (context.snippets.length === 0) {
    lines.push('- No snippets selected. Use focused tools (find_files/workspace_search/read_file/read_code).');
  } else {
    for (const s of context.snippets) {
      const pathPart = s.path ? ` path=${s.path}` : '';
      const rangePart =
        typeof s.startLine === 'number' && typeof s.endLine === 'number'
          ? ` lines=${s.startLine}-${s.endLine}`
          : '';
      lines.push(`### ${s.title}`);
      lines.push(`lane=${s.lane}${pathPart}${rangePart} source=${s.source} stale=${s.stale} score=${s.score}`);
      lines.push('```text');
      lines.push(s.content);
      lines.push('```');
    }
  }

  lines.push('## Diagnostics Summary');
  lines.push('```text');
  lines.push(context.diagnosticsSummary);
  lines.push('```');

  lines.push('## Runtime Summary');
  lines.push('```json');
  lines.push(context.runtimeSummary);
  lines.push('```');

  if (context.insufficiencyHint) {
    lines.push('## Context Hint');
    lines.push(context.insufficiencyHint);
  }

  return lines.join('\n');
}

export function buildMinimalContextFallback(query: string): string {
  const active = editorStore.activeFile && !isVoltVirtualPath(editorStore.activeFile.path)
    ? editorStore.activeFile
    : null;
  const selection = getEditorSelection();
  const root = projectStore.rootPath ?? null;
  const lines: string[] = [];
  lines.push('# CONTEXT V2 (Fallback)');
  lines.push('Focused context build failed; using minimal runtime/editor context.');
  if (root) lines.push(`Workspace: ${root}`);
  if (query.trim()) lines.push(`User query: ${query.trim()}`);
  if (active) lines.push(`Active file: ${toRelativePath(active.path, root)}`);
  if (selection?.path && selection?.range) {
    lines.push(`Selection: ${toRelativePath(selection.path, root)}:${selection.range.startLineNumber}-${selection.range.endLineNumber}`);
  }
  lines.push('Use targeted tools next: file_outline, read_code, read_file, workspace_search.');
  return lines.join('\n');
}

export function clearContextV2Cache(): void {
  snapshotCache.clear();
}
