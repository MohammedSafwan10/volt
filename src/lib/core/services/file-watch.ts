/**
 * File watching service for incremental index updates
 * 
 * Listens to filesystem changes from the Rust backend and updates
 * the file index and file tree incrementally without full rescans.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { logOutput } from '$features/terminal/stores/output.svelte';
import { indexUpdateTick } from './file-index';
import { registerCleanup } from '$core/services/hmr-cleanup';

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
let pausedWorkspace: string | null = null;

// Callbacks for external consumers
type ChangeHandler = (batch: FileChangeBatchEvent) => void;
const changeHandlers: Set<ChangeHandler> = new Set();

// Register HMR cleanup to prevent orphaned event listeners
registerCleanup('file-watch', () => stopWatching());

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

    // Recover from stale backend watcher state (e.g. reload/HMR):
    // if Rust still watches this workspace, stop it first so re-attach is reliable.
    try {
      await invoke('stop_file_watch', { workspaceRoot });
    } catch {
      // ignore if it was not watching
    }

    // Start the Rust watcher
    await invoke('start_file_watch', { workspaceRoot });
    currentWorkspace = workspaceRoot;
    
    logOutput('Volt', `Started file watcher for ${workspaceRoot}`);
    return true;
  } catch (error) {
    // Clean up listener if watcher failed to start
    // Special-case: backend already watching (race/reload). Keep listener and proceed.
    const errorStr = String(error);
    if (errorStr.includes('AlreadyWatching')) {
      currentWorkspace = workspaceRoot;
      logOutput('Volt', `Reusing existing file watcher for ${workspaceRoot}`);
      return true;
    }

    if (unlistenChange) {
      unlistenChange();
      unlistenChange = null;
    }
    logOutput('Volt', `Failed to start file watcher: ${error}`);
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
 * Temporarily pause file watching (for file move operations on Windows)
 * Returns true if watching was paused, false if not watching
 */
export async function pauseWatching(): Promise<boolean> {
  if (!currentWorkspace) return false;
  
  pausedWorkspace = currentWorkspace;
  await stopWatching();
  return true;
}

/**
 * Resume file watching after a pause
 */
export async function resumeWatching(): Promise<void> {
  if (pausedWorkspace) {
    await startWatching(pausedWorkspace);
    pausedWorkspace = null;
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
