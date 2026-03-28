<script lang="ts">
  import "../app.css";
  import ToastContainer from "$shared/components/ui/ToastContainer.svelte";
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { initializeFileService } from '$core/services/file-service';
  import { cleanupStaleBackendWatchers } from '$core/services/hmr-cleanup';
  
  let { children } = $props();

  function emitStartupDebug(message: string): void {
    console.info('[VoltStartup]', message);
    void invoke('debug_log_frontend', {
      topic: 'frontend',
      message,
    }).catch(() => {});
  }

  if (typeof window !== 'undefined') {
    const startupWindow = window as Window & {
      __voltStartupDebugInstalled?: boolean;
    };

    if (!startupWindow.__voltStartupDebugInstalled) {
      startupWindow.__voltStartupDebugInstalled = true;
      emitStartupDebug('layout module evaluated');

      window.addEventListener('error', (event) => {
        emitStartupDebug(
          `window.error message=${event.message} filename=${event.filename} line=${event.lineno}:${event.colno}`,
        );
        if (event.error?.stack) {
          emitStartupDebug(`window.error.stack ${event.error.stack}`);
        }
      });

      window.addEventListener('unhandledrejection', (event) => {
        const reason =
          event.reason instanceof Error
            ? `${event.reason.name}: ${event.reason.message}`
            : String(event.reason);
        emitStartupDebug(`window.unhandledrejection reason=${reason}`);
        if (event.reason instanceof Error && event.reason.stack) {
          emitStartupDebug(`window.unhandledrejection.stack ${event.reason.stack}`);
        }
      });
    }
  }

  // Initialize unified file service with LSP integration
  onMount(() => {
    emitStartupDebug('layout mounted');

    void (async () => {
      try {
        emitStartupDebug('cleanupStaleBackendWatchers start');
        await cleanupStaleBackendWatchers();
        emitStartupDebug('cleanupStaleBackendWatchers done');
      } catch (error) {
        emitStartupDebug(`cleanupStaleBackendWatchers failed: ${String(error)}`);
      }

      try {
        emitStartupDebug('initializeFileService start');
        await initializeFileService();
        emitStartupDebug('initializeFileService done');
      } catch (error) {
        const message =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        emitStartupDebug(`initializeFileService failed: ${message}`);
        if (error instanceof Error && error.stack) {
          emitStartupDebug(`initializeFileService.stack ${error.stack}`);
        }
      }
    })();
  });

  // Global handler for external links - always opens in the system browser.
  onMount(() => {
    function handleGlobalClick(event: MouseEvent): void {
      const target = event.target as HTMLElement;
      const link = target.closest('a') as HTMLAnchorElement | null;
      
      if (link) {
        const href = link.getAttribute('href');
        // Check if it's an external URL (http/https)
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          event.preventDefault();
          event.stopPropagation();
          void openUrl(href);
        }
      }
    }

    document.addEventListener('click', handleGlobalClick, true);
    return () => {
      document.removeEventListener('click', handleGlobalClick, true);
    };
  });
</script>

{@render children()}
<ToastContainer />
