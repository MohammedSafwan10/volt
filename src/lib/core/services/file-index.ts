import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { writable } from 'svelte/store';
import { registerCleanup } from '$core/services/hmr-cleanup';
import { logOutput } from '$features/terminal/stores/output.svelte';
import { getFileInfoQuiet } from '$core/services/file-system';

export const indexUpdateTick = writable(0);

const FULL_RESCAN_THRESHOLD = 200;

function countChangedPaths(
  changes: Array<{
    kind: string;
    paths: string[];
    absolutePaths: string[];
  }>
): number {
  return changes.reduce((total, change) => {
    return total + Math.max(change.absolutePaths.length, change.paths.length, 1);
  }, 0);
}

export function shouldIgnorePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/');
  const ignoreDirs = ['node_modules', '.git', '.next', 'dist', 'target', 'build', 'out'];
  return parts.some((part) => ignoreDirs.includes(part));
}

export interface IndexedFile {
  name: string;
  path: string;
  relativePath: string;
  parentDir: string;
  isDir: boolean;
}

interface IndexChunkEvent {
  requestId: number;
  files: IndexedFile[];
  totalCount: number;
  done: boolean;
}

interface IndexDoneEvent {
  requestId: number;
  totalCount: number;
  cancelled: boolean;
  durationMs: number;
}

interface IndexErrorEvent {
  requestId: number;
  message: string;
}

interface IndexStatus {
  indexing: boolean;
  count: number;
  rootPath: string | null;
}

type SearchKind = 'all' | 'files' | 'directories';

let fileIndex: IndexedFile[] = [];
let fileByPath = new Map<string, IndexedFile>();
let indexedRoot: string | null = null;
let indexing = false;
let indexProgress = { current: 0, total: 0 };
let currentRequestId = 0;
let indexTimestamp = 0;
let currentSearchId = 0;
let unlistenChunk: UnlistenFn | null = null;
let unlistenDone: UnlistenFn | null = null;
let unlistenError: UnlistenFn | null = null;
let cleanupRegistered = false;
let indexCompletePromise: Promise<void> | null = null;
let indexCompleteResolver: (() => void) | null = null;

function generateRequestId(): number {
  return Date.now() + Math.floor(Math.random() * 10000);
}

function getBasename(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function getParentDir(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '';
}

function addToMirror(file: IndexedFile): void {
  if (shouldIgnorePath(file.relativePath)) return;

  const normalized: IndexedFile = {
    ...file,
    relativePath: file.relativePath.replace(/\\/g, '/'),
    parentDir: file.parentDir.replace(/\\/g, '/'),
  };

  const existingIndex = fileIndex.findIndex((entry) => entry.path === normalized.path);
  if (existingIndex >= 0) {
    fileIndex[existingIndex] = normalized;
  } else {
    fileIndex.push(normalized);
  }
  fileByPath.set(normalized.path, normalized);
}

function removeFromMirror(absolutePath: string): void {
  if (!fileByPath.delete(absolutePath)) return;
  fileIndex = fileIndex.filter((entry) => entry.path !== absolutePath);
}

function fallbackSearch(query: string, recentPaths: string[], limit: number, kind: SearchKind): IndexedFile[] {
  const recentSet = new Set(recentPaths);
  const isMatch = (file: IndexedFile): boolean => {
    if (shouldIgnorePath(file.relativePath)) return false;
    if (kind === 'files' && file.isDir) return false;
    if (kind === 'directories' && !file.isDir) return false;
    if (!query.trim()) {
      if (kind === 'all') return !file.isDir;
      return true;
    }
    const lowered = query.trim().toLowerCase();
    return (
      file.name.toLowerCase().includes(lowered) || file.relativePath.toLowerCase().includes(lowered)
    );
  };

  if (!query.trim()) {
    const results: IndexedFile[] = [];
    for (const path of recentPaths) {
      const file = fileByPath.get(path);
      if (file && isMatch(file)) {
        results.push(file);
      }
    }

    for (const file of fileIndex) {
      if (results.length >= limit) break;
      if (recentSet.has(file.path) || !isMatch(file)) continue;
      results.push(file);
    }
    return results;
  }

  return fileIndex
    .filter((file) => isMatch(file))
    .sort((left, right) => Number(recentSet.has(right.path)) - Number(recentSet.has(left.path)))
    .slice(0, limit);
}

async function cleanupListeners(): Promise<void> {
  if (unlistenChunk) {
    unlistenChunk();
    unlistenChunk = null;
  }
  if (unlistenDone) {
    unlistenDone();
    unlistenDone = null;
  }
  if (unlistenError) {
    unlistenError();
    unlistenError = null;
  }
}

async function cleanupIndexingForReload(): Promise<void> {
  if (indexing && currentRequestId > 0) {
    try {
      await invoke('cancel_index_workspace', { requestId: currentRequestId });
    } catch {
      // Best effort during HMR.
    }
  }

  indexing = false;
  currentRequestId = 0;
  indexCompletePromise = null;
  indexCompleteResolver = null;
  await cleanupListeners();
}

function ensureIndexCleanupRegistered(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  registerCleanup('file-index', () => cleanupIndexingForReload());
}

export async function indexProject(rootPath: string, useCache = true): Promise<void> {
  ensureIndexCleanupRegistered();

  if (indexedRoot === rootPath && fileIndex.length > 0 && useCache && !indexing) return;
  if (indexing && indexedRoot === rootPath && indexCompletePromise) {
    return indexCompletePromise;
  }

  if (indexing && currentRequestId > 0) {
    await cancelIndexing();
  }

  indexing = true;
  indexCompletePromise = new Promise((resolve) => {
    indexCompleteResolver = resolve;
  });
  indexedRoot = rootPath;
  fileIndex = [];
  fileByPath = new Map();
  indexProgress = { current: 0, total: 0 };
  currentRequestId = generateRequestId();
  const requestId = currentRequestId;

  try {
    await cleanupListeners();

    unlistenChunk = await listen<IndexChunkEvent>('file-index://chunk', (event) => {
      if (event.payload.requestId !== requestId) return;

      for (const file of event.payload.files) {
        addToMirror(file);
      }
      indexProgress = { current: fileIndex.length, total: event.payload.totalCount };
      indexUpdateTick.update((n) => n + 1);
    });

    unlistenDone = await listen<IndexDoneEvent>('file-index://done', (event) => {
      if (event.payload.requestId !== requestId) return;

      indexing = false;
      indexTimestamp = Date.now();
      indexProgress = { current: fileIndex.length, total: event.payload.totalCount };
      indexUpdateTick.update((n) => n + 1);

      if (event.payload.cancelled) {
        logOutput('Volt', `File indexing cancelled after ${event.payload.durationMs}ms`);
      } else {
        logOutput('Volt', `Indexed ${event.payload.totalCount} files in ${event.payload.durationMs}ms`);
      }

      if (indexCompleteResolver) {
        indexCompleteResolver();
        indexCompleteResolver = null;
      }
      indexCompletePromise = null;
      void cleanupListeners();
    });

    unlistenError = await listen<IndexErrorEvent>('file-index://error', (event) => {
      if (event.payload.requestId !== requestId) return;

      indexing = false;
      logOutput('Volt', `File indexing error: ${event.payload.message}`);
      indexUpdateTick.update((n) => n + 1);

      if (indexCompleteResolver) {
        indexCompleteResolver();
        indexCompleteResolver = null;
      }
      indexCompletePromise = null;
      void cleanupListeners();
    });

    await invoke('index_workspace_stream', { rootPath, requestId, useCache });
    return indexCompletePromise || Promise.resolve();
  } catch (error) {
    indexing = false;
    logOutput('Volt', `File indexing failed: ${error}`);
    if (indexCompleteResolver) {
      indexCompleteResolver();
      indexCompleteResolver = null;
    }
    indexCompletePromise = null;
    indexUpdateTick.update((n) => n + 1);
    await cleanupListeners();
  }
}

export async function cancelIndexing(): Promise<void> {
  if (!indexing || currentRequestId === 0) return;

  try {
    await invoke('cancel_index_workspace', { requestId: currentRequestId });
  } catch {
    // Best effort cancellation.
  }

  indexing = false;
  indexUpdateTick.update((n) => n + 1);
  await cleanupListeners();
}

export async function clearIndex(clearBackendCache = false): Promise<void> {
  await cancelIndexing();

  fileIndex = [];
  fileByPath = new Map();
  indexedRoot = null;
  indexProgress = { current: 0, total: 0 };
  indexUpdateTick.update((n) => n + 1);

  if (clearBackendCache) {
    try {
      await invoke('clear_index_cache', { rootPath: null });
    } catch {
      // Ignore clear failures.
    }
  }
}

export function isIndexReady(): boolean {
  return fileIndex.length > 0;
}

export function getIndexAge(): number {
  if (indexTimestamp === 0) return Infinity;
  return Date.now() - indexTimestamp;
}

export function isIndexing(): boolean {
  return indexing;
}

export function getIndexStatus(): {
  count: number;
  indexing: boolean;
  rootPath: string | null;
  progress: { current: number; total: number };
} {
  return {
    count: fileIndex.length,
    indexing,
    rootPath: indexedRoot,
    progress: indexProgress,
  };
}

export async function getBackendIndexStatus(rootPath: string): Promise<IndexStatus | null> {
  try {
    return await invoke<IndexStatus>('get_index_status', { rootPath });
  } catch {
    return null;
  }
}

async function runBackendSearch(
  query: string,
  recentPaths: string[],
  limit: number,
  kind: SearchKind,
  requestId: number
): Promise<IndexedFile[] | null> {
  if (!indexedRoot) return [];

  // While a fresh index is still streaming, use the local mirror so Quick Open
  // and mentions can surface partial results instead of waiting for completion.
  if (indexing) {
    return fallbackSearch(query, recentPaths, limit, kind);
  }

  try {
    const results = await invoke<IndexedFile[]>('search_indexed_files', {
      rootPath: indexedRoot,
      query,
      recentPaths,
      limit,
      kind,
    });

    if (requestId !== currentSearchId) return null;
    return results;
  } catch (error) {
    if (requestId !== currentSearchId) return null;
    logOutput('Volt', `Backend file search failed, using local fallback: ${error}`);
    return fallbackSearch(query, recentPaths, limit, kind);
  }
}

export async function searchFiles(
  query: string,
  recentPaths: string[] = [],
  limit = 50,
  kind: SearchKind = 'all'
): Promise<IndexedFile[]> {
  const results = await searchFilesAsync(query, recentPaths, limit, kind);
  return results ?? [];
}

export async function searchFilesAsync(
  query: string,
  recentPaths: string[] = [],
  limit = 50,
  kind: SearchKind = 'all'
): Promise<IndexedFile[] | null> {
  const requestId = ++currentSearchId;
  return runBackendSearch(query, recentPaths, limit, kind, requestId);
}

export function cancelAsyncSearch(): void {
  currentSearchId += 1;
}

async function getDirectoryFlag(path: string): Promise<boolean> {
  const info = await getFileInfoQuiet(path);
  return info?.isDir ?? false;
}

export function addFileToIndex(absolutePath: string, relativePath: string, isDir = false): void {
  if (shouldIgnorePath(relativePath)) {
    removeFileFromIndex(absolutePath);
    return;
  }

  const next: IndexedFile = {
    name: getBasename(relativePath),
    path: absolutePath,
    relativePath,
    parentDir: getParentDir(relativePath),
    isDir,
  };

  addToMirror(next);
  indexUpdateTick.update((n) => n + 1);

  if (indexedRoot) {
    void invoke('upsert_indexed_file', {
      rootPath: indexedRoot,
      absolutePath,
      relativePath,
      isDir,
    });
  }
}

export function removeFileFromIndex(absolutePath: string): void {
  removeFromMirror(absolutePath);
  indexUpdateTick.update((n) => n + 1);

  if (indexedRoot) {
    void invoke('remove_indexed_file', {
      rootPath: indexedRoot,
      absolutePath,
    });
  }
}

export function updateFileInIndex(
  oldAbsolutePath: string,
  newAbsolutePath: string,
  newRelativePath: string,
  isDir = false
): void {
  removeFromMirror(oldAbsolutePath);

  if (!shouldIgnorePath(newRelativePath)) {
    addToMirror({
      name: getBasename(newRelativePath),
      path: newAbsolutePath,
      relativePath: newRelativePath,
      parentDir: getParentDir(newRelativePath),
      isDir,
    });
  }

  indexUpdateTick.update((n) => n + 1);

  if (indexedRoot) {
    void invoke('rename_indexed_file', {
      rootPath: indexedRoot,
      oldAbsolutePath,
      newAbsolutePath,
      newRelativePath,
      isDir,
    });
  }
}

export async function handleFileChangeBatch(
  changes: Array<{
    kind: string;
    paths: string[];
    absolutePaths: string[];
  }>
): Promise<boolean> {
  if (countChangedPaths(changes) > FULL_RESCAN_THRESHOLD) {
    return false;
  }

  for (const change of changes) {
    if (change.kind === 'rename' && change.absolutePaths.length >= 2 && change.paths.length >= 2) {
      const isDir = await getDirectoryFlag(change.absolutePaths[1]);
      updateFileInIndex(change.absolutePaths[0], change.absolutePaths[1], change.paths[1], isDir);
      continue;
    }

    for (let i = 0; i < change.absolutePaths.length; i++) {
      const absPath = change.absolutePaths[i];
      const relPath = change.paths[i];

      switch (change.kind) {
        case 'create': {
          const isDir = await getDirectoryFlag(absPath);
          addFileToIndex(absPath, relPath, isDir);
          break;
        }
        case 'delete':
          removeFileFromIndex(absPath);
          break;
        case 'rename': {
          const isDir = await getDirectoryFlag(absPath);
          addFileToIndex(absPath, relPath, isDir);
          break;
        }
        case 'modify':
          break;
      }
    }
  }

  return true;
}

export function getAllFiles(): IndexedFile[] {
  return [...fileIndex];
}

export function getIndexedRoot(): string | null {
  return indexedRoot;
}
