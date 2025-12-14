/**
 * File indexing service for quick file search
 * Scans project files and provides fuzzy search
 */

import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '$lib/types/files';

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

// Directories to skip when indexing
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svelte-kit',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'target',
  '.turbo',
  'coverage',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
]);

// File index cache
let fileIndex: IndexedFile[] = [];
let indexedRoot: string | null = null;
let indexing = false;

/**
 * Index all files in a project directory
 */
export async function indexProject(rootPath: string): Promise<void> {
  if (indexing) return;
  if (indexedRoot === rootPath && fileIndex.length > 0) return;

  indexing = true;
  fileIndex = [];
  indexedRoot = rootPath;

  try {
    await indexDirectory(rootPath, rootPath);
  } finally {
    indexing = false;
  }
}

/**
 * Recursively index a directory
 */
async function indexDirectory(dirPath: string, rootPath: string): Promise<void> {
  try {
    const result = await invoke<{ entries: FileEntry[]; skipped: unknown[] }>('list_dir_detailed', { path: dirPath });
    
    for (const entry of result.entries) {
      if (entry.isDir) {
        // Skip ignored directories
        if (IGNORED_DIRS.has(entry.name)) continue;
        // Recursively index subdirectories
        await indexDirectory(entry.path, rootPath);
      } else {
        // Add file to index
        const relativePath = getRelativePath(entry.path, rootPath);
        const parentDir = getParentDir(relativePath);
        
        fileIndex.push({
          name: entry.name,
          path: entry.path,
          relativePath,
          parentDir,
        });
      }
    }
  } catch {
    // Silently skip directories we can't read
  }
}

/**
 * Get relative path from root
 */
function getRelativePath(fullPath: string, rootPath: string): string {
  const normalizedFull = fullPath.replace(/\\/g, '/');
  const normalizedRoot = rootPath.replace(/\\/g, '/');
  
  if (normalizedFull.startsWith(normalizedRoot)) {
    let relative = normalizedFull.slice(normalizedRoot.length);
    if (relative.startsWith('/')) relative = relative.slice(1);
    return relative;
  }
  return normalizedFull;
}

/**
 * Get parent directory from relative path
 */
function getParentDir(relativePath: string): string {
  const parts = relativePath.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

/**
 * Clear the file index
 */
export function clearIndex(): void {
  fileIndex = [];
  indexedRoot = null;
}

/**
 * Check if index is ready
 */
export function isIndexReady(): boolean {
  return fileIndex.length > 0 && !indexing;
}

/**
 * Get index status
 */
export function getIndexStatus(): { count: number; indexing: boolean } {
  return { count: fileIndex.length, indexing };
}

/**
 * Fuzzy score for file search
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

  return results.slice(0, limit).map(r => r.file);
}
