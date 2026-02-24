import { invoke } from '@tauri-apps/api/core';
import { logOutput } from '$lib/stores/output.svelte';

export interface SemanticSnippetCandidate {
  snippetId: string;
  path: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  text: string;
  textHash: string;
  semanticScore: number;
  lexicalScore: number;
  combinedScore: number;
}

export interface SemanticQueryResult {
  candidates: SemanticSnippetCandidate[];
  totalCandidates: number;
  topK: number;
  laneCap: number;
  semanticEnabled: boolean;
  backend: string;
  queryMs: number;
}

export interface SemanticIndexStatus {
  rootPath: string;
  semanticEnabled: boolean;
  backend: string;
  fileCount: number;
  snippetCount: number;
  vectorCount: number;
  lastIndexedAt: number | null;
  staleMs: number | null;
  modelPath?: string | null;
  modelLoadMs?: number | null;
  lastError?: string | null;
}

interface SemanticMutationResult {
  processedFiles: number;
  processedPaths: string[];
  semanticEnabled: boolean;
  backend: string;
}

const DEFAULT_TOP_K = Number(import.meta.env.VITE_VOLT_SEMANTIC_TOP_K || 24);
const DEFAULT_MAX_SELECTED = Number(import.meta.env.VITE_VOLT_SEMANTIC_MAX_SELECTED || 8);
const DEFAULT_DEBOUNCE_MS = Number(import.meta.env.VITE_VOLT_SEMANTIC_REINDEX_DEBOUNCE_MS || 500);
const DEFAULT_IDLE_BATCH_SIZE = Number(import.meta.env.VITE_VOLT_SEMANTIC_IDLE_BATCH_SIZE || 32);
const DEFAULT_FORCE_FLUSH_MS = Number(import.meta.env.VITE_VOLT_SEMANTIC_FORCE_FLUSH_MS || 10000);
const ENABLED_BY_ENV = (() => {
  const value = String(import.meta.env.VITE_VOLT_SEMANTIC_INDEX ?? 'on').toLowerCase();
  return value === 'on' || value === '1' || value === 'true';
})();

let queueRoot: string | null = null;
let upsertQueue = new Set<string>();
let removeQueue = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let updateCounter = 0;
let queueFirstQueuedAt = 0;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function nowMs(): number {
  return Date.now();
}

function scheduleIdleFlush(task: () => void): void {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (
      window as Window & {
        requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      }
    ).requestIdleCallback(() => task(), { timeout: DEFAULT_FORCE_FLUSH_MS });
    return;
  }
  setTimeout(task, 120);
}

function dequeueBatch(queue: Set<string>, maxItems: number): string[] {
  const output: string[] = [];
  for (const value of queue) {
    output.push(value);
    queue.delete(value);
    if (output.length >= maxItems) break;
  }
  return output;
}

function scheduleFlush(debounceMs = DEFAULT_DEBOUNCE_MS): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const overdue = queueFirstQueuedAt > 0 && nowMs() - queueFirstQueuedAt >= DEFAULT_FORCE_FLUSH_MS;
    if (overdue) {
      void flushQueues();
      return;
    }
    scheduleIdleFlush(() => {
      void flushQueues();
    });
  }, debounceMs);
}

async function flushQueues(): Promise<void> {
  if (!isSemanticIndexEnabled()) return;
  const root = queueRoot;
  if (!root) return;

  const batchSize = Math.max(1, DEFAULT_IDLE_BATCH_SIZE);
  const removals = dequeueBatch(removeQueue, batchSize);
  const upserts = dequeueBatch(upsertQueue, batchSize);

  if (removals.length > 0) {
    try {
      await invoke<SemanticMutationResult>('semantic_index_remove_paths', {
        args: { rootPath: root, paths: removals },
      });
    } catch (error) {
      logOutput('Volt', `Semantic remove failed: ${error}`);
    }
  }

  if (upserts.length > 0) {
    try {
      await invoke<SemanticMutationResult>('semantic_index_upsert_files', {
        args: {
          rootPath: root,
          paths: upserts,
        },
      });
      updateCounter += upserts.length;
      if (updateCounter >= 250) {
        updateCounter = 0;
        void compactSemanticIndex(root);
      }
    } catch (error) {
      logOutput('Volt', `Semantic upsert failed: ${error}`);
    }
  }

  if (removeQueue.size > 0 || upsertQueue.size > 0) {
    scheduleIdleFlush(() => {
      void flushQueues();
    });
  } else {
    queueFirstQueuedAt = 0;
  }
}

export function isSemanticIndexEnabled(): boolean {
  return ENABLED_BY_ENV;
}

export function getSemanticDefaults(): { topK: number; maxSelected: number; debounceMs: number } {
  return {
    topK: Math.max(1, DEFAULT_TOP_K),
    maxSelected: Math.max(1, DEFAULT_MAX_SELECTED),
    debounceMs: Math.max(50, DEFAULT_DEBOUNCE_MS),
  };
}

export async function warmSemanticIndex(rootPath: string): Promise<void> {
  if (!isSemanticIndexEnabled()) return;
  queueRoot = normalizePath(rootPath);
  try {
    await invoke<SemanticMutationResult>('semantic_index_upsert_files', {
      args: {
        rootPath: queueRoot,
      },
    });
  } catch (error) {
    logOutput('Volt', `Semantic warm index failed: ${error}`);
  }
}

export async function rebuildSemanticIndex(rootPath: string): Promise<void> {
  if (!isSemanticIndexEnabled()) return;
  queueRoot = normalizePath(rootPath);
  await invoke<SemanticMutationResult>('semantic_index_rebuild', {
    args: { rootPath: queueRoot },
  });
}

export async function compactSemanticIndex(rootPath: string): Promise<void> {
  if (!isSemanticIndexEnabled()) return;
  await invoke<SemanticMutationResult>('semantic_index_compact', {
    args: { rootPath: normalizePath(rootPath) },
  });
}

export async function getSemanticStatus(rootPath: string): Promise<SemanticIndexStatus | null> {
  if (!isSemanticIndexEnabled()) return null;
  try {
    return await invoke<SemanticIndexStatus>('semantic_index_status', {
      args: { rootPath: normalizePath(rootPath) },
    });
  } catch {
    return null;
  }
}

export async function querySemanticIndex(
  rootPath: string,
  query: string,
  options?: { topK?: number; laneCap?: number },
): Promise<SemanticQueryResult | null> {
  if (!isSemanticIndexEnabled() || !query.trim()) return null;
  try {
    return await invoke<SemanticQueryResult>('semantic_index_query', {
      args: {
        query,
        rootPath: normalizePath(rootPath),
        topK: options?.topK ?? Math.max(1, DEFAULT_TOP_K),
        laneCap: options?.laneCap ?? Math.max(1, DEFAULT_MAX_SELECTED),
      },
    });
  } catch {
    return null;
  }
}

export function queueSemanticUpsert(rootPath: string, absolutePath: string): void {
  if (!isSemanticIndexEnabled()) return;
  if (!queueFirstQueuedAt) queueFirstQueuedAt = nowMs();
  queueRoot = normalizePath(rootPath);
  const normalized = normalizePath(absolutePath);
  removeQueue.delete(normalized);
  upsertQueue.add(normalized);
  scheduleFlush();
}

export function queueSemanticRemove(rootPath: string, absolutePath: string): void {
  if (!isSemanticIndexEnabled()) return;
  if (!queueFirstQueuedAt) queueFirstQueuedAt = nowMs();
  queueRoot = normalizePath(rootPath);
  const normalized = normalizePath(absolutePath);
  upsertQueue.delete(normalized);
  removeQueue.add(normalized);
  scheduleFlush();
}

export function clearSemanticQueue(): void {
  upsertQueue.clear();
  removeQueue.clear();
  queueRoot = null;
  queueFirstQueuedAt = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
