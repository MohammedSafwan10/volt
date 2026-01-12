<script lang="ts">
  import "../app.css";
  import ToastContainer from "$lib/components/ui/ToastContainer.svelte";
  import { onMount } from 'svelte';
  import { open } from '@tauri-apps/plugin-shell';
  
  let { children } = $props();

  // Global handler for external links - opens in system browser instead of Tauri webview
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
          void open(href);
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
