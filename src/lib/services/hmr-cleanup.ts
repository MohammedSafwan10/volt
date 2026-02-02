/**
 * HMR Cleanup Registry
 * 
 * Provides a central place to register cleanup functions that need to be
 * called when the page is reloaded (via HMR or full reload).
 * 
 * This prevents the "[TAURI] Couldn't find callback id" warnings that occur
 * when Tauri event listeners from a previous page load are still active.
 */

type CleanupFn = () => void | Promise<void>;

// Registry of cleanup functions by service name
const cleanupRegistry = new Map<string, CleanupFn>();

// Track if we've already set up the beforeunload handler
let initialized = false;

/**
 * Register a cleanup function for a service.
 * If the service was already registered, the old cleanup is called first.
 */
export function registerCleanup(serviceName: string, cleanup: CleanupFn): void {
  // Call existing cleanup if re-registering (HMR scenario)
  const existing = cleanupRegistry.get(serviceName);
  if (existing) {
    try {
      const result = existing();
      if (result instanceof Promise) {
        result.catch((e) => console.warn(`[HMR Cleanup] Async cleanup error for ${serviceName}:`, e));
      }
    } catch (e) {
      console.warn(`[HMR Cleanup] Cleanup error for ${serviceName}:`, e);
    }
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
  if (initialized) return;
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
