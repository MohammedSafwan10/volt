/**
 * Scalable file indexing service for Quick Open
 * 
 * Uses Rust backend for fast filesystem walking with gitignore support.
 * Streams results to provide responsive Quick Open even for 500K+ file workspaces.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { logOutput } from '$lib/stores/output.svelte';
import { writable } from 'svelte/store';

// Emits a monotonic tick whenever the in-memory index changes.
// Used by Quick Open UI to refresh results as chunks stream in.
export const indexUpdateTick = writable(0);

export interface IndexedFile {
  /** File name */
  name: string;
  /** Full path */
  path: string;
  /** Relative path from project root */
  relativePath: string;
  /** Parent directory name */
  parentDir: string;
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

// File index state
let fileIndex: IndexedFile[] = [];
let indexedRoot: string | null = null;
let indexing = false;
let currentRequestId = 0;
let unlistenChunk: UnlistenFn | null = null;
let unlistenDone: UnlistenFn | null = null;
let unlistenError: UnlistenFn | null = null;


/**
 * Generate a unique request ID
 */
function generateRequestId(): number {
  return Date.now() + Math.floor(Math.random() * 10000);
}

/**
 * Clean up event listeners
 */
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

/**
 * Index all files in a project directory using streaming Rust backend
 */
export async function indexProject(rootPath: string, useCache = true): Promise<void> {
  // Don't re-index if already indexing the same path
  if (indexing && indexedRoot === rootPath) return;
  
  // If already indexed this path and not forcing refresh, skip
  if (indexedRoot === rootPath && fileIndex.length > 0 && useCache) return;

  // Cancel any previous indexing
  if (indexing && currentRequestId > 0) {
    await cancelIndexing();
  }

  indexing = true;
  indexedRoot = rootPath;
  fileIndex = [];
  currentRequestId = generateRequestId();

  const requestId = currentRequestId;

  try {
    // Clean up previous listeners
    await cleanupListeners();

    // Set up event listeners
    unlistenChunk = await listen<IndexChunkEvent>('file-index://chunk', (event) => {
      if (event.payload.requestId !== requestId) return;
      
      // Append new files to index
      fileIndex.push(...event.payload.files);
      indexUpdateTick.update((n) => n + 1);
    });

    unlistenDone = await listen<IndexDoneEvent>('file-index://done', (event) => {
      if (event.payload.requestId !== requestId) return;
      
      indexing = false;
      indexUpdateTick.update((n) => n + 1);
      
      if (event.payload.cancelled) {
        logOutput('Volt', `File indexing cancelled after ${event.payload.durationMs}ms`);
      } else {
        logOutput(
          'Volt',
          `Indexed ${event.payload.totalCount} files in ${event.payload.durationMs}ms`
        );
      }
      
      // Clean up listeners after completion
      void cleanupListeners();
    });

    unlistenError = await listen<IndexErrorEvent>('file-index://error', (event) => {
      if (event.payload.requestId !== requestId) return;
      
      indexing = false;
      logOutput('Volt', `File indexing error: ${event.payload.message}`);

      indexUpdateTick.update((n) => n + 1);
      
      void cleanupListeners();
    });

    // Start indexing
    logOutput('Volt', `Starting file indexing for ${rootPath}...`);
    
    await invoke('index_workspace_stream', {
      rootPath,
      requestId,
      useCache,
    });
  } catch (error) {
    indexing = false;
    logOutput('Volt', `File indexing failed: ${error}`);
    indexUpdateTick.update((n) => n + 1);
    await cleanupListeners();
  }
}

/**
 * Cancel current indexing operation
 */
export async function cancelIndexing(): Promise<void> {
  if (!indexing || currentRequestId === 0) return;
  
  try {
    await invoke('cancel_index_workspace', { requestId: currentRequestId });
  } catch {
    // Best-effort cancellation
  }
  
  indexing = false;
  indexUpdateTick.update((n) => n + 1);
  await cleanupListeners();
}

/**
 * Clear the file index and optionally the backend cache
 */
export async function clearIndex(clearBackendCache = false): Promise<void> {
  await cancelIndexing();
  
  fileIndex = [];
  indexedRoot = null;
  indexUpdateTick.update((n) => n + 1);
  
  if (clearBackendCache) {
    try {
      await invoke('clear_index_cache', { rootPath: null });
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Check if index is ready (has files and not currently indexing)
 */
export function isIndexReady(): boolean {
  return fileIndex.length > 0;
}

/**
 * Check if currently indexing
 */
export function isIndexing(): boolean {
  return indexing;
}

/**
 * Get index status
 */
export function getIndexStatus(): { count: number; indexing: boolean; rootPath: string | null } {
  return { count: fileIndex.length, indexing, rootPath: indexedRoot };
}

/**
 * Get backend index status
 */
export async function getBackendIndexStatus(rootPath: string): Promise<IndexStatus | null> {
  try {
    return await invoke<IndexStatus>('get_index_status', { rootPath });
  } catch {
    return null;
  }
}


/**
 * Fuzzy score for file search
 * Higher score = better match
 */
function fuzzyScore(query: string, file: IndexedFile): number {
  const queryLower = query.toLowerCase();
  const nameLower = file.name.toLowerCase();
  const pathLower = file.relativePath.toLowerCase();

  // Exact name match
  if (nameLower === queryLower) return 1000;

  // Name starts with query
  if (nameLower.startsWith(queryLower)) return 800 + (queryLower.length / nameLower.length) * 100;

  // Name contains query
  if (nameLower.includes(queryLower)) return 500 + (queryLower.length / nameLower.length) * 100;

  // Path contains query
  if (pathLower.includes(queryLower)) return 200 + (queryLower.length / pathLower.length) * 50;

  // Fuzzy character matching on name
  let queryIndex = 0;
  let score = 0;
  let consecutiveBonus = 0;

  for (let i = 0; i < nameLower.length && queryIndex < queryLower.length; i++) {
    if (nameLower[i] === queryLower[queryIndex]) {
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5;
      queryIndex++;
    } else {
      consecutiveBonus = 0;
    }
  }

  // All query characters must be found
  if (queryIndex < queryLower.length) return -1;

  return score;
}

/**
 * Search files with fuzzy matching
 */
export function searchFiles(query: string, recentPaths: string[] = [], limit = 50): IndexedFile[] {
  if (!query.trim()) {
    // No query - show recent files first, then some other files
    const recentSet = new Set(recentPaths);
    const recent: IndexedFile[] = [];
    const others: IndexedFile[] = [];

    for (const file of fileIndex) {
      if (recentSet.has(file.path)) {
        recent.push(file);
      } else if (others.length < limit - recentPaths.length) {
        others.push(file);
      }
    }

    // Sort recent by their order in recentPaths
    recent.sort((a, b) => recentPaths.indexOf(a.path) - recentPaths.indexOf(b.path));

    return [...recent, ...others].slice(0, limit);
  }

  const results: Array<{ file: IndexedFile; score: number }> = [];
  const recentSet = new Set(recentPaths);

  for (const file of fileIndex) {
    const score = fuzzyScore(query, file);
    if (score > 0) {
      // Boost recent files
      const boost = recentSet.has(file.path) ? 100 : 0;
      results.push({ file, score: score + boost });
    }
  }

  // Sort by score
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit).map((r) => r.file);
}
