/**
 * Workspace search service
 * TypeScript wrapper for Rust search commands
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { showToast } from '$lib/stores/toast.svelte';
import { logOutput } from '$lib/stores/output.svelte';

/** Search options */
export interface SearchOptions {
  /** Search query (plain text or regex) */
  query: string;
  /** Root directory to search in */
  rootPath: string;
  /** Case sensitive search */
  caseSensitive?: boolean;
  /** Use regex pattern */
  useRegex?: boolean;
  /** Match whole word only */
  wholeWord?: boolean;
  /** Include hidden files */
  includeHidden?: boolean;
  /** File glob patterns to include (e.g., "*.ts", "*.js") */
  includePatterns?: string[];
  /** File glob patterns to exclude */
  excludePatterns?: string[];
  /** Maximum number of results (0 = unlimited) */
  maxResults?: number;

  /** Request id for cancellation/ordering (required) */
  requestId: number;
}

/** A single match within a file */
export interface SearchMatch {
  /** Line number (1-based) */
  line: number;
  /** Column start (0-based) */
  columnStart: number;
  /** Column end (0-based) */
  columnEnd: number;
  /** The matched text */
  matchText: string;
  /** The full line content */
  lineContent: string;
}

/** Search results for a single file */
export interface FileSearchResult {
  /** File path */
  path: string;
  /** Matches in this file */
  matches: SearchMatch[];
}

/** Overall search results */
export interface SearchResults {
  /** Results grouped by file */
  files: FileSearchResult[];
  /** Total number of matches */
  totalMatches: number;
  /** Total number of files with matches */
  totalFiles: number;
  /** Whether the search was truncated due to max_results */
  truncated: boolean;
  /** Runtime diagnostics for engine selection/fallback. */
  telemetry?: {
    requestedEngine: string;
    engine: string;
    fallbackUsed: boolean;
    fallbackReason?: string | null;
    elapsedMs: number;
  };
}

/** Search error from Rust */
interface SearchError {
  type: 'InvalidPattern' | 'Cancelled' | 'IoError' | 'InvalidPath' | 'InvalidRange';
  message?: string;
  path?: string;
}

export interface SearchChunkEvent {
  requestId: number;
  files: FileSearchResult[];
  totalMatches: number;
  truncated: boolean;
}

export interface SearchDoneEvent {
  requestId: number;
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
  cancelled: boolean;
  telemetry?: {
    requestedEngine: string;
    engine: string;
    fallbackUsed: boolean;
    fallbackReason?: string | null;
    elapsedMs: number;
  };
}

export interface SearchErrorEvent {
  requestId: number;
  error: SearchError;
}

function isSearchError(error: unknown): error is SearchError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof (error as SearchError).type === 'string'
  );
}

function getSearchErrorMessage(error: SearchError): string {
  switch (error.type) {
    case 'InvalidPattern':
      return `Invalid search pattern: ${error.message || 'Unknown error'}`;
    case 'Cancelled':
      return 'Search was cancelled';
    case 'IoError':
      return `Search error: ${error.message || 'Unknown I/O error'}`;
    case 'InvalidPath':
      return `Invalid path: ${error.path || 'Unknown path'}`;
    case 'InvalidRange':
      return `Invalid range: ${error.message || 'Unknown range error'}`;
    default:
      return 'Search failed';
  }
}

/**
 * Perform workspace search
 */
export async function workspaceSearch(options: SearchOptions): Promise<SearchResults | null> {
  try {
    logOutput('Volt', `Searching for "${options.query}" in ${options.rootPath}`);

    const results = await invoke<SearchResults>('workspace_search', { options });

    const telemetry = results.telemetry
      ? ` [engine=${results.telemetry.engine}${results.telemetry.fallbackUsed ? ', fallback' : ''}, ${results.telemetry.elapsedMs}ms]`
      : '';
    logOutput(
      'Volt',
      `Found ${results.totalMatches} matches in ${results.totalFiles} files${results.truncated ? ' (truncated)' : ''}${telemetry}`
    );

    return results;
  } catch (error) {
    if (isSearchError(error)) {
      // Cancellation is expected during fast typing; treat as silent.
      if (error.type === 'Cancelled') {
        return null;
      }
      const message = getSearchErrorMessage(error);
      showToast({ message, type: 'error' });
      logOutput('Volt', `Search error: ${message}`);
    } else {
      const message = error instanceof Error ? error.message : 'Search failed';
      showToast({ message, type: 'error' });
      logOutput('Volt', `Search error: ${message}`);
    }
    return null;
  }
}

/**
 * Cancel an in-flight workspace search (best-effort)
 */
export async function cancelWorkspaceSearch(requestId: number): Promise<void> {
  if (!requestId) return;
  try {
    await invoke<void>('cancel_workspace_search', { requestId });
  } catch {
    // Best-effort cancellation; ignore errors.
  }
}

export async function workspaceSearchStream(
  options: SearchOptions,
  handlers: {
    onChunk: (chunk: SearchChunkEvent) => void;
    onDone: (done: SearchDoneEvent) => void;
    onError?: (error: SearchErrorEvent) => void;
  }
): Promise<UnlistenFn> {
  const chunkUnlisten = await listen<SearchChunkEvent>('search://chunk', (event) => {
    if (event.payload.requestId !== options.requestId) return;
    handlers.onChunk(event.payload);
  });

  const doneUnlisten = await listen<SearchDoneEvent>('search://done', (event) => {
    if (event.payload.requestId !== options.requestId) return;
    handlers.onDone(event.payload);
  });

  const errorUnlisten = await listen<SearchErrorEvent>('search://error', (event) => {
    if (event.payload.requestId !== options.requestId) return;
    handlers.onError?.(event.payload);
  });

  // Fire-and-forget: Rust command immediately returns, scan continues in background.
  invoke<void>('workspace_search_stream', { options }).catch(() => {
    // ignore (best-effort)
  });

  return () => {
    chunkUnlisten();
    doneUnlisten();
    errorUnlisten();
  };
}

/** Replace options */
export interface ReplaceInFileOptions {
  /** File path */
  path: string;
  /** Search pattern */
  search: string;
  /** Replacement text */
  replace: string;
  /** Case sensitive */
  caseSensitive?: boolean;
  /** Use regex */
  useRegex?: boolean;
  /** Whole word */
  wholeWord?: boolean;
}

export interface ReplaceOneInFileOptions {
  path: string;
  /** 1-based line */
  line: number;
  /** UTF-16 column start (0-based) */
  columnStart: number;
  /** UTF-16 column end (0-based) */
  columnEnd: number;
  /** Optional expected text at the range */
  expected?: string;
  replace: string;
}

/** Replace result */
export interface ReplaceResult {
  /** Number of replacements made */
  replacements: number;
  /** New file content */
  content: string;
}

/**
 * Replace text in a single file
 */
export async function replaceInFile(options: ReplaceInFileOptions): Promise<ReplaceResult | null> {
  try {
    logOutput('Volt', `Replacing "${options.search}" with "${options.replace}" in ${options.path}`);

    const result = await invoke<ReplaceResult>('replace_in_file', { options });

    logOutput('Volt', `Made ${result.replacements} replacements in ${options.path}`);

    return result;
  } catch (error) {
    if (isSearchError(error)) {
      const message = getSearchErrorMessage(error);
      showToast({ message, type: 'error' });
      logOutput('Volt', `Replace error: ${message}`);
    } else {
      const message = error instanceof Error ? error.message : 'Replace failed';
      showToast({ message, type: 'error' });
      logOutput('Volt', `Replace error: ${message}`);
    }
    return null;
  }
}

/**
 * Replace a single occurrence in a file at a specific range
 */
export async function replaceOneInFile(
  options: ReplaceOneInFileOptions
): Promise<ReplaceResult | null> {
  try {
    logOutput('Volt', `Replacing one occurrence in ${options.path}`);

    const result = await invoke<ReplaceResult>('replace_one_in_file', { options });

    logOutput('Volt', `Made ${result.replacements} replacement in ${options.path}`);
    return result;
  } catch (error) {
    if (isSearchError(error)) {
      const message = getSearchErrorMessage(error);
      showToast({ message, type: 'error' });
      logOutput('Volt', `Replace error: ${message}`);
    } else {
      const message = error instanceof Error ? error.message : 'Replace failed';
      showToast({ message, type: 'error' });
      logOutput('Volt', `Replace error: ${message}`);
    }
    return null;
  }
}
