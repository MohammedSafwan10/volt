/**
 * HMR Cleanup Registry
 * 
 * Provides a central place to register cleanup functions that need to be
 * called when the page is reloaded (via HMR or full reload).
 * 
 * This prevents the "[TAURI] Couldn't find callback id" warnings that occur
 * when Tauri event listeners from a previous page load are still active.
 */

import { invoke } from '@tauri-apps/api/core';

type CleanupFn = () => void | Promise<void>;

// Registry of cleanup functions by service name
const cleanupRegistry = new Map<string, CleanupFn>();

// Track if we've already set up the beforeunload handler
let initialized = false;
let backendWatchCleanupDone = false;
const BACKEND_CLEANUP_SESSION_KEY = 'volt.hmrCleanupDone';
const CLEANUP_TRACE_STORAGE_KEY = 'volt.hmrCleanup.trace';

function isCleanupTraceEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CLEANUP_TRACE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Best-effort startup cleanup for stale backend watchers left from a previous
 * reload/session. This prevents callback-id warning floods during dev reloads.
 */
export async function cleanupStaleBackendWatchers(): Promise<void> {
  if (backendWatchCleanupDone) return;

  if (typeof window !== 'undefined') {
    try {
      if (window.sessionStorage.getItem(BACKEND_CLEANUP_SESSION_KEY) === 'true') {
        backendWatchCleanupDone = true;
        return;
      }
      window.sessionStorage.setItem(BACKEND_CLEANUP_SESSION_KEY, 'true');
    } catch {
      // Ignore session storage failures; the in-memory guard still helps for this page lifecycle.
    }
  }

  backendWatchCleanupDone = true;

  await Promise.allSettled([
    invoke('stop_all_watch_commands'),
    invoke('stop_all_file_watches'),
    invoke('cancel_index_workspace', { requestId: 0 }),
    invoke('cancel_workspace_search', { requestId: 0 }),
    invoke('lsp_stop_all'),
  ]);
}

/**
 * Register a cleanup function for a service.
 * If the service was already registered, replace it without running the old cleanup.
 * Running cleanup eagerly during re-registration can tear down live services when
 * modules are re-evaluated or components remount within the same page session.
 */
export function registerCleanup(serviceName: string, cleanup: CleanupFn): void {
  const existing = cleanupRegistry.get(serviceName);
  if (existing && existing !== cleanup && isCleanupTraceEnabled()) {
    console.warn(`[HMR Cleanup] Replacing cleanup handler for ${serviceName} without eager cleanup`);
  }

  cleanupRegistry.set(serviceName, cleanup);
  initializeIfNeeded();
}

/**
 * Unregister a cleanup function
 */
export function unregisterCleanup(serviceName: string): void {
  cleanupRegistry.delete(serviceName);
}

/**
 * Run all registered cleanup functions
 */
export async function runAllCleanups(): Promise<void> {
  const promises: Promise<void>[] = [];
  
  for (const [name, cleanup] of cleanupRegistry) {
    try {
      const result = cleanup();
      if (result instanceof Promise) {
        promises.push(result.catch((e) => {
          console.warn(`[HMR Cleanup] Async cleanup error for ${name}:`, e);
        }));
      }
    } catch (e) {
      console.warn(`[HMR Cleanup] Cleanup error for ${name}:`, e);
    }
  }

  await Promise.all(promises);
  cleanupRegistry.clear();
}

/**
 * Initialize the beforeunload handler (only once)
 */
function initializeIfNeeded(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  // Handle page unload (full reload, navigation away)
  window.addEventListener('beforeunload', () => {
    runAllCleanups();
  });

  // Handle Vite HMR if available
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      runAllCleanups();
    });
  }
}

/**
 * Helper to create a cleanup function that calls multiple unlisten functions
 */
export function createUnlistenCleanup(
  unlisteners: (() => void)[]
): CleanupFn {
  return () => {
    for (const unlisten of unlisteners) {
      try {
        unlisten();
      } catch {
        // Ignore - listener might already be cleaned up
      }
    }
  };
}
