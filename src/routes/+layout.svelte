<script lang="ts">
  import "../app.css";
  import ToastContainer from "$shared/components/ui/ToastContainer.svelte";
  import { onMount } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { initializeFileService } from '$core/services/file-service';
  import { cleanupStaleBackendWatchers } from '$core/services/hmr-cleanup';
  
  let { children } = $props();

  // Initialize unified file service with LSP integration
  onMount(() => {
    void cleanupStaleBackendWatchers();
    void initializeFileService();
  });

  // Global handler for external links - opens in system browser instead of Tauri webview
  // EXCEPT for links marked with data-external-link="true" which open in built-in browser
  onMount(() => {
    function handleGlobalClick(event: MouseEvent): void {
      const target = event.target as HTMLElement;
      const link = target.closest('a') as HTMLAnchorElement | null;
      
      if (link) {
        const href = link.getAttribute('href');
        // Check if it's an external URL (http/https)
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          // Skip links that should open in built-in browser (handled by Markdown component)
          if (link.hasAttribute('data-external-link')) {
            return; // Let the Markdown handler deal with it
          }
          
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
