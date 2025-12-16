/**
 * File watching service for incremental index updates
 * 
 * Listens to filesystem changes from the Rust backend and updates
 * the file index and file tree incrementally without full rescans.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { logOutput } from '$lib/stores/output.svelte';
import { indexUpdateTick } from './file-index';

export interface FileChangeEvent {
  /** Type of change: "create", "delete", "rename", "modify" */
  kind: string;
  /** Affected file paths (relative to workspace root) */
  paths: string[];
  /** Full absolute paths */
  absolutePaths: string[];
  /** Workspace root this event belongs to */
  workspaceRoot: string;
}

export interface FileChangeBatchEvent {
  /** All changes in this batch */
  changes: FileChangeEvent[];
  /** Workspace root */
  workspaceRoot: string;
  /** Number of changes in batch */
  totalChanges: number;
}

// State
let currentWorkspace: string | null = null;
let unlistenChange: UnlistenFn | null = null;

// Callbacks for external consumers
type ChangeHandler = (batch: FileChangeBatchEvent) => void;
const changeHandlers: Set<ChangeHandler> = new Set();

/**
 * Register a handler for file change events
 */
export function onFileChange(handler: ChangeHandler): () => void {
  changeHandlers.add(handler);
  return () => changeHandlers.delete(handler);
}

/**
 * Start watching a workspace for file changes
 */
export async function startWatching(workspaceRoot: string): Promise<boolean> {
  // Stop any existing watcher
  if (currentWorkspace) {
    await stopWatching();
  }

  try {
    // Set up event listener first
    unlistenChange = await listen<FileChangeBatchEvent>('file-watch://change', (event) => {
      handleFileChangeBatch(event.payload);
    });

    // Start the Rust watcher
    await invoke('start_file_watch', { workspaceRoot });
    currentWorkspace = workspaceRoot;
    
    logOutput('Volt', `Started file watcher for ${workspaceRoot}`);
    return true;
  } catch (error) {
    // Clean up listener if watcher failed to start
    if (unlistenChange) {
      unlistenChange();
      unlistenChange = null;
    }
    
    // Don't log "already watching" as an error
    const errorStr = String(error);
    if (!errorStr.includes('AlreadyWatching')) {
      logOutput('Volt', `Failed to start file watcher: ${error}`);
    }
    return false;
  }
}

/**
 * Stop watching the current workspace
 */
export async function stopWatching(): Promise<void> {
  if (unlistenChange) {
    unlistenChange();
    unlistenChange = null;
  }

  if (currentWorkspace) {
    try {
      await invoke('stop_file_watch', { workspaceRoot: currentWorkspace });
      logOutput('Volt', `Stopped file watcher for ${currentWorkspace}`);
    } catch {
      // Ignore errors when stopping
    }
    currentWorkspace = null;
  }
}

/**
 * Check if currently watching a workspace
 */
export function isWatching(): boolean {
  return currentWorkspace !== null;
}

/**
 * Get the currently watched workspace
 */
export function getWatchedWorkspace(): string | null {
  return currentWorkspace;
}

/**
 * Handle a batch of file changes
 */
function handleFileChangeBatch(batch: FileChangeBatchEvent): void {
  // Log large batches (likely git checkout or npm install)
  if (batch.totalChanges > 50) {
    logOutput('Volt', `File watcher: ${batch.totalChanges} changes detected (batch)`);
  }

  // Notify all registered handlers
  for (const handler of changeHandlers) {
    try {
      handler(batch);
    } catch (e) {
      console.error('[FileWatch] Handler error:', e);
    }
  }

  // Trigger index update tick so Quick Open refreshes
  indexUpdateTick.update((n) => n + 1);
}
