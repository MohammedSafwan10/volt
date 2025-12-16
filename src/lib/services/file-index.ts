/**
 * Scalable file indexing service for Quick Open
 * 
 * Uses Rust backend for fast filesystem walking with gitignore support.
 * Streams results to provide responsive Quick Open even for 500K+ file workspaces.
 * 
 * Supports incremental updates via file watching to avoid full rescans.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { logOutput } from '$lib/stores/output.svelte';
import { writable } from 'svelte/store';

// Emits a monotonic tick whenever the in-memory index changes.
// Used by Quick Open UI to refresh results as chunks stream in.
export const indexUpdateTick = writable(0);

// Threshold for triggering full rescan instead of incremental update
const FULL_RESCAN_THRESHOLD = 100;

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

/**
 * Internal indexed file with precomputed normalized fields for faster matching.
 * These are computed once when files are added to the index.
 */
interface NormalizedIndexedFile extends IndexedFile {
  /** Lowercased file name for fast matching */
  nameLower: string;
  /** Lowercased relative path for fast matching */
  pathLower: string;
  /** Path segments (split by / or \) for segment matching */
  pathSegments: string[];
  /** Lowercased path segments for segment matching */
  pathSegmentsLower: string[];
  /** CamelCase boundaries in name (indices where uppercase letters appear) */
  camelBoundaries: number[];
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
let fileIndex: NormalizedIndexedFile[] = [];
let fileByPath = new Map<string, NormalizedIndexedFile>();
let indexedRoot: string | null = null;
let indexing = false;
let indexProgress = { current: 0, total: 0 };
let currentRequestId = 0;
let unlistenChunk: UnlistenFn | null = null;
let unlistenDone: UnlistenFn | null = null;
let unlistenError: UnlistenFn | null = null;

/**
 * Precompute normalized fields for an IndexedFile.
 * This is done once when files are added to avoid repeated work during search.
 */
function normalizeFile(file: IndexedFile): NormalizedIndexedFile {
  const nameLower = file.name.toLowerCase();
  const pathLower = file.relativePath.toLowerCase();
  
  // Split path into segments for segment-based matching
  const pathSegments = file.relativePath.split(/[/\\]/).filter(Boolean);
  const pathSegmentsLower = pathSegments.map((s) => s.toLowerCase());
  
  // Find camelCase boundaries (indices where a new "word" starts)
  // Examples:
  // - "MyFile" => [0, 2]
  // - "XMLHttp" => [0, 3]
  const camelBoundaries: number[] = [];
  const originalName = file.name;
  for (let i = 1; i < originalName.length; i++) {
    const char = originalName[i];
    const prevChar = originalName[i - 1];
    const nextChar = i + 1 < originalName.length ? originalName[i + 1] : '';

    const isUpper = char >= 'A' && char <= 'Z';
    const prevIsLower = prevChar >= 'a' && prevChar <= 'z';
    const prevIsUpper = prevChar >= 'A' && prevChar <= 'Z';
    const nextIsLower = nextChar >= 'a' && nextChar <= 'z';

    // Start a new "word" when:
    // - Uppercase follows lowercase (myFile => F)
    // - Uppercase follows uppercase but next is lowercase (XMLHttp => H)
    if ((isUpper && prevIsLower) || (isUpper && prevIsUpper && nextIsLower)) {
      camelBoundaries.push(i);
    }
  }

  // Always include index 0 as a boundary
  camelBoundaries.unshift(0);
  
  return {
    ...file,
    nameLower,
    pathLower,
    pathSegments,
    pathSegmentsLower,
    camelBoundaries,
  };
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
  fileByPath = new Map();
  currentRequestId = generateRequestId();

  const requestId = currentRequestId;

  try {
    // Clean up previous listeners
    await cleanupListeners();

    // Set up event listeners
    unlistenChunk = await listen<IndexChunkEvent>('file-index://chunk', (event) => {
      if (event.payload.requestId !== requestId) return;
      
      // Normalize and append new files to index
      const normalizedFiles = event.payload.files.map(normalizeFile);
      for (const file of normalizedFiles) {
        fileByPath.set(file.path, file);
      }
      fileIndex.push(...normalizedFiles);
      
      // Update progress
      indexProgress = { current: fileIndex.length, total: event.payload.totalCount };
      
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
  fileByPath = new Map();
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
 * Get index status including progress information
 */
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
 * Check if query matches at camelCase boundaries.
 * E.g., "mf" matches "MyFile" at boundaries [0, 2]
 */
function matchesCamelCase(queryLower: string, nameLower: string, boundaries: number[]): boolean {
  if (boundaries.length < queryLower.length) return false;
  
  let queryIdx = 0;
  for (const boundaryIdx of boundaries) {
    if (queryIdx >= queryLower.length) break;
    if (nameLower[boundaryIdx] === queryLower[queryIdx]) {
      queryIdx++;
    }
  }
  return queryIdx === queryLower.length;
}

/**
 * Check if query matches path segments.
 * E.g., "src/comp" matches "src/lib/components"
 */
function matchesPathSegments(queryLower: string, segments: string[]): number {
  // Split query by / or space to get query segments
  const queryParts = queryLower.split(/[/\\ ]+/).filter(Boolean);
  if (queryParts.length === 0) return 0;
  
  let score = 0;
  let segmentIdx = 0;
  
  for (const queryPart of queryParts) {
    // Find a segment that starts with or contains this query part
    let found = false;
    for (let i = segmentIdx; i < segments.length; i++) {
      const segLower = segments[i];
      if (segLower.startsWith(queryPart)) {
        score += 50 + (queryPart.length / segLower.length) * 30;
        segmentIdx = i + 1;
        found = true;
        break;
      } else if (segLower.includes(queryPart)) {
        score += 20 + (queryPart.length / segLower.length) * 10;
        segmentIdx = i + 1;
        found = true;
        break;
      }
    }
    if (!found) return 0; // Query part not found in remaining segments
  }
  
  return score;
}

/**
 * Fuzzy score for file search using precomputed normalized fields.
 * Higher score = better match.
 * 
 * Scoring priorities (VS Code-like):
 * 1. Exact name match (1000)
 * 2. Name starts with query (800-900)
 * 3. CamelCase match in name (700-800)
 * 4. Name contains query as substring (500-600)
 * 5. Path segment match (300-500)
 * 6. Path contains query (200-300)
 * 7. Fuzzy character match in name (50-200)
 */
function fuzzyScore(queryLower: string, file: NormalizedIndexedFile): number {
  const { nameLower, pathLower, pathSegmentsLower, camelBoundaries } = file;

  // Exact name match (highest priority)
  if (nameLower === queryLower) return 1000;

  // Name starts with query (very high priority)
  if (nameLower.startsWith(queryLower)) {
    // Bonus for shorter names (more specific match)
    const lengthBonus = Math.max(0, 100 - (nameLower.length - queryLower.length) * 2);
    return 800 + lengthBonus;
  }

  // CamelCase match (e.g., "mf" matches "MyFile")
  if (queryLower.length >= 2 && matchesCamelCase(queryLower, nameLower, camelBoundaries)) {
    const lengthBonus = Math.max(0, 80 - (nameLower.length - queryLower.length));
    return 700 + lengthBonus;
  }

  // Name contains query as contiguous substring
  const nameContainsIdx = nameLower.indexOf(queryLower);
  if (nameContainsIdx !== -1) {
    // Bonus for match closer to start
    const positionBonus = Math.max(0, 50 - nameContainsIdx * 5);
    const lengthBonus = (queryLower.length / nameLower.length) * 50;
    return 500 + positionBonus + lengthBonus;
  }

  // Path segment matching (e.g., "src/comp" matches "src/lib/components")
  const segmentScore = matchesPathSegments(queryLower, pathSegmentsLower);
  if (segmentScore > 0) {
    return 300 + segmentScore;
  }

  // Path contains query as contiguous substring
  if (pathLower.includes(queryLower)) {
    const lengthBonus = (queryLower.length / pathLower.length) * 100;
    return 200 + lengthBonus;
  }

  // Fuzzy character matching on name (lowest priority but still useful)
  let queryIndex = 0;
  let score = 0;
  let consecutiveBonus = 0;
  let lastMatchIdx = -1;

  for (let i = 0; i < nameLower.length && queryIndex < queryLower.length; i++) {
    if (nameLower[i] === queryLower[queryIndex]) {
      // Bonus for consecutive matches
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5;
      
      // Bonus for match at word boundary (after _, -, or camelCase)
      if (i === 0 || camelBoundaries.includes(i) || nameLower[i - 1] === '_' || nameLower[i - 1] === '-') {
        score += 15;
      }
      
      // Penalty for large gaps between matches
      if (lastMatchIdx >= 0 && i - lastMatchIdx > 3) {
        score -= (i - lastMatchIdx - 3) * 2;
      }
      
      lastMatchIdx = i;
      queryIndex++;
    } else {
      consecutiveBonus = 0;
    }
  }

  // All query characters must be found
  if (queryIndex < queryLower.length) return -1;

  // Ensure fuzzy matches don't score too high
  return Math.min(score, 199);
}

// ============================================================================
// Async Search with Yielding (prevents UI jank on large indexes)
// ============================================================================

// Threshold for when to use async search (file count)
const ASYNC_SEARCH_THRESHOLD = 10000;
// How many files to process before yielding to the event loop
const SEARCH_BATCH_SIZE = 2000;

/**
 * Yield to the event loop to prevent UI blocking
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Search files with fuzzy matching (sync version for small indexes).
 * Uses precomputed normalized fields for fast matching.
 */
export function searchFiles(query: string, recentPaths: string[] = [], limit = 50): IndexedFile[] {
  const trimmedQuery = query.trim();
  
  if (!trimmedQuery) {
    // No query - show recent files first, then some other files
    const recent: IndexedFile[] = [];
    const recentSet = new Set(recentPaths);
    for (const path of recentPaths) {
      const file = fileByPath.get(path);
      if (file) {
        recent.push(file);
      }
    }

    const others: IndexedFile[] = [];
    for (const file of fileIndex) {
      if (others.length + recent.length >= limit) break;
      if (recentSet.has(file.path)) continue;
      others.push(file);
    }

    return [...recent, ...others];
  }

  // Precompute lowercase query once (not per-file)
  const queryLower = trimmedQuery.toLowerCase();
  
  const results: Array<{ file: NormalizedIndexedFile; score: number }> = [];
  const recentSet = new Set(recentPaths);

  for (const file of fileIndex) {
    const score = fuzzyScore(queryLower, file);
    if (score > 0) {
      // Boost recent/open files
      const boost = recentSet.has(file.path) ? 100 : 0;
      results.push({ file, score: score + boost });
    }
  }

  // Sort by score (descending)
  results.sort((a, b) => b.score - a.score);

  // Return only the public IndexedFile interface (strip internal normalized fields)
  return results.slice(0, limit).map((r) => ({
    name: r.file.name,
    path: r.file.path,
    relativePath: r.file.relativePath,
    parentDir: r.file.parentDir,
  }));
}

// Track current async search to allow cancellation
let currentSearchId = 0;

/**
 * Search files with fuzzy matching (async version for large indexes).
 * Yields to the event loop periodically to prevent UI jank.
 * Returns null if cancelled by a newer search.
 */
export async function searchFilesAsync(
  query: string,
  recentPaths: string[] = [],
  limit = 50
): Promise<IndexedFile[] | null> {
  const searchId = ++currentSearchId;
  const trimmedQuery = query.trim();
  
  // For small indexes or empty query, use sync version
  if (!trimmedQuery || fileIndex.length < ASYNC_SEARCH_THRESHOLD) {
    return searchFiles(query, recentPaths, limit);
  }

  const queryLower = trimmedQuery.toLowerCase();
  const results: Array<{ file: NormalizedIndexedFile; score: number }> = [];
  const recentSet = new Set(recentPaths);

  // Process in batches, yielding between batches
  for (let i = 0; i < fileIndex.length; i += SEARCH_BATCH_SIZE) {
    // Check if cancelled
    if (currentSearchId !== searchId) {
      return null;
    }

    const end = Math.min(i + SEARCH_BATCH_SIZE, fileIndex.length);
    
    for (let j = i; j < end; j++) {
      const file = fileIndex[j];
      const score = fuzzyScore(queryLower, file);
      if (score > 0) {
        const boost = recentSet.has(file.path) ? 100 : 0;
        results.push({ file, score: score + boost });
      }
    }

    // Yield to event loop after each batch (except the last)
    if (end < fileIndex.length) {
      await yieldToMain();
    }
  }

  // Final cancellation check
  if (currentSearchId !== searchId) {
    return null;
  }

  // Sort by score (descending)
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit).map((r) => ({
    name: r.file.name,
    path: r.file.path,
    relativePath: r.file.relativePath,
    parentDir: r.file.parentDir,
  }));
}

/**
 * Cancel any in-flight async search
 */
export function cancelAsyncSearch(): void {
  currentSearchId++;
}

// ============================================================================
// Incremental Index Updates (File Watch Integration)
// ============================================================================

/**
 * Add a file to the index (called when file is created)
 */
export function addFileToIndex(absolutePath: string, relativePath: string): void {
  // Don't add if already exists
  if (fileByPath.has(absolutePath)) {
    return;
  }

  const name = getBasename(relativePath);
  const parentDir = getParentDir(relativePath);

  const newFile: IndexedFile = {
    name,
    path: absolutePath,
    relativePath,
    parentDir,
  };

  // Normalize and add to index
  const normalized = normalizeFile(newFile);
  fileByPath.set(absolutePath, normalized);
  fileIndex.push(normalized);
  indexUpdateTick.update((n) => n + 1);
}

/**
 * Remove a file from the index (called when file is deleted)
 */
export function removeFileFromIndex(absolutePath: string): void {
  if (!fileByPath.delete(absolutePath)) {
    return;
  }

  const initialLength = fileIndex.length;
  fileIndex = fileIndex.filter((f) => f.path !== absolutePath);
  
  if (fileIndex.length !== initialLength) {
    indexUpdateTick.update((n) => n + 1);
  }
}

/**
 * Update a file in the index (called when file is renamed)
 */
export function updateFileInIndex(
  oldAbsolutePath: string,
  newAbsolutePath: string,
  newRelativePath: string
): void {
  const index = fileIndex.findIndex((f) => f.path === oldAbsolutePath);
  
  if (index !== -1) {
    const name = getBasename(newRelativePath);
    const parentDir = getParentDir(newRelativePath);

    const updatedFile: IndexedFile = {
      name,
      path: newAbsolutePath,
      relativePath: newRelativePath,
      parentDir,
    };
    
    // Normalize and update
    const normalized = normalizeFile(updatedFile);
    fileIndex[index] = normalized;
    fileByPath.delete(oldAbsolutePath);
    fileByPath.set(newAbsolutePath, normalized);
    
    // Trigger reactivity by reassigning
    fileIndex = [...fileIndex];
    indexUpdateTick.update((n) => n + 1);
  }
}

/**
 * Handle a batch of file changes from the file watcher
 * Returns true if handled incrementally, false if full rescan is needed
 */
export function handleFileChangeBatch(
  changes: Array<{
    kind: string;
    paths: string[];
    absolutePaths: string[];
  }>
): boolean {
  // If too many changes, suggest full rescan
  if (changes.length > FULL_RESCAN_THRESHOLD) {
    return false;
  }

  for (const change of changes) {
    // Rename events can include [old, new] paths.
    if (change.kind === 'rename' && change.absolutePaths.length >= 2 && change.paths.length >= 2) {
      const oldAbs = change.absolutePaths[0];
      const newAbs = change.absolutePaths[1];
      const newRel = change.paths[1];

      updateFileInIndex(oldAbs, newAbs, newRel);
      continue;
    }

    for (let i = 0; i < change.absolutePaths.length; i++) {
      const absPath = change.absolutePaths[i];
      const relPath = change.paths[i];

      switch (change.kind) {
        case 'create':
          addFileToIndex(absPath, relPath);
          break;
        case 'delete':
          removeFileFromIndex(absPath);
          break;
        case 'rename':
          // If we only got the new path, fall back to add (best-effort).
          addFileToIndex(absPath, relPath);
          break;
        case 'modify':
          // File content changed, no index update needed
          break;
      }
    }
  }

  return true;
}

/**
 * Get the current indexed root path
 */
export function getIndexedRoot(): string | null {
  return indexedRoot;
}
