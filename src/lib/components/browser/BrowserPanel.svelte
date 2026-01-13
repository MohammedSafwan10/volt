<script lang="ts">
  /**
   * BrowserPanel - Native webview browser with element selection for AI
   * The actual browser is a child webview positioned to match this container
   */
  import { onMount } from 'svelte';
  import { UIIcon } from '$lib/components/ui';
  import { browserStore } from '$lib/stores/browser.svelte';
  import BrowserToolbar from './BrowserToolbar.svelte';
  import ElementInspector from './ElementInspector.svelte';

  let containerRef: HTMLDivElement | null = $state(null);
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let updateScheduled = false;
  let mounted = false;
  let lastBoundsStr = '';

  // Get accurate bounds - use CSS pixels directly (Tauri handles DPI scaling)
  async function getAccurateBounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (!containerRef) return null;
    
    // Force a layout recalculation
    containerRef.offsetHeight;
    
    const rect = containerRef.getBoundingClientRect();
    
    // getBoundingClientRect returns CSS (logical) pixels
    // Tauri's LogicalPosition/LogicalSize expect CSS pixels and handle DPI scaling internally
    // So we pass the values directly without any scaling
    
    const x = rect.left;
    const y = rect.top;
    const width = rect.width;
    const height = rect.height;
    
    // Ensure we have valid dimensions
    if (width < 10 || height < 10) return null;
    
    console.log('[Browser] Bounds:', { 
      x: Math.round(x), y: Math.round(y), 
      width: Math.round(width), height: Math.round(height),
      scaleFactor: window.devicePixelRatio
    });
    
    return { 
      x: Math.round(x), 
      y: Math.round(y), 
      width: Math.round(width), 
      height: Math.round(height) 
    };
  }

  // Update webview bounds when container changes
  async function updateBounds(): Promise<void> {
    if (!containerRef || !browserStore.isOpen || !browserStore.isVisible || !mounted) return;
    
    const bounds = await getAccurateBounds();
    if (!bounds) return;
    
    // Skip if bounds haven't changed (avoid unnecessary IPC)
    const boundsStr = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (boundsStr === lastBoundsStr) return;
    lastBoundsStr = boundsStr;
    
    // Only update if we have valid dimensions
    if (bounds.width > 10 && bounds.height > 10) {
      console.log('[Browser] Updating bounds:', bounds);
      browserStore.setBounds(bounds);
    }
  }

  // Throttled bounds update using RAF
  function scheduleUpdateBounds(): void {
    if (updateScheduled) return;
    updateScheduled = true;
    requestAnimationFrame(() => {
      updateBounds();
      updateScheduled = false;
    });
  }

  // Force immediate bounds update
  function forceUpdateBounds(): void {
    lastBoundsStr = '';
    updateBounds();
  }

  onMount(() => {
    mounted = true;
    
    // Setup resize observer for container size changes
    if (containerRef) {
      resizeObserver = new ResizeObserver(() => {
        scheduleUpdateBounds();
      });
      resizeObserver.observe(containerRef);
      
      // Also observe parent elements for layout changes
      let parent = containerRef.parentElement;
      while (parent && parent !== document.body) {
        resizeObserver.observe(parent);
        parent = parent.parentElement;
      }
    }

    // Setup mutation observer for DOM changes that might affect layout
    mutationObserver = new MutationObserver(() => {
      scheduleUpdateBounds();
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

    // Update bounds on window events
    window.addEventListener('resize', forceUpdateBounds);
    window.addEventListener('scroll', scheduleUpdateBounds, true);
    
    // Periodic bounds check (catches edge cases)
    const intervalId = setInterval(() => {
      if (browserStore.isOpen && browserStore.isVisible && mounted) {
        scheduleUpdateBounds();
      }
    }, 500);
    
    // Initial bounds update with multiple attempts
    setTimeout(forceUpdateBounds, 50);
    setTimeout(forceUpdateBounds, 150);
    setTimeout(forceUpdateBounds, 300);
    setTimeout(forceUpdateBounds, 500);

    return () => {
      mounted = false;
      clearInterval(intervalId);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', forceUpdateBounds);
      window.removeEventListener('scroll', scheduleUpdateBounds, true);
    };
  });

  // Update bounds when browser state changes
  $effect(() => {
    if (browserStore.isOpen && browserStore.isVisible && containerRef && mounted) {
      // Reset and force update when browser opens/shows
      lastBoundsStr = '';
      setTimeout(forceUpdateBounds, 0);
      setTimeout(forceUpdateBounds, 100);
      setTimeout(forceUpdateBounds, 250);
    }
  });

  // Recalculate bounds when inspector panel appears/disappears
  $effect(() => {
    // Track inspector visibility to trigger bounds recalc
    void browserStore.selectedElement;
    if (containerRef && mounted) {
      // Force recalculate when inspector toggles
      setTimeout(forceUpdateBounds, 50);
      setTimeout(forceUpdateBounds, 150);
    }
  });
</script>

<div class="browser-panel">
  <BrowserToolbar />
  
  <div class="browser-content">
    <!-- Container for native webview positioning -->
    <div class="browser-view" bind:this={containerRef}>
      {#if browserStore.status === 'error'}
        <div class="state-container error">
          <UIIcon name="error" size={48} />
          <h3>Failed to load page</h3>
          <p>{browserStore.error || 'Something went wrong'}</p>
          <div class="actions">
            <button class="btn primary" onclick={() => browserStore.reload()}>
              <UIIcon name="refresh" size={14} />
              <span>Retry</span>
            </button>
          </div>
        </div>
      {:else if browserStore.status === 'idle'}
        <div class="state-container">
          <UIIcon name="globe" size={48} />
          <h3>Enter a URL to browse</h3>
          <p>Type a URL or search term in the address bar</p>
          <div class="quick-links">
            <button onclick={() => browserStore.navigate('https://www.google.com')}>
              <UIIcon name="search" size={12} />
              Google
            </button>
            <button onclick={() => browserStore.navigate('http://localhost:3000')}>
              localhost:3000
            </button>
            <button onclick={() => browserStore.navigate('http://localhost:5173')}>
              localhost:5173
            </button>
            <button onclick={() => browserStore.navigate('http://localhost:8080')}>
              localhost:8080
            </button>
          </div>
        </div>
      {:else}
        <!-- Native webview renders over this area -->
        <div class="webview-area">
          {#if browserStore.status === 'loading'}
            <div class="loading-indicator">
              <div class="spinner"></div>
              <span>Loading...</span>
            </div>
          {/if}
        </div>
        
        {#if browserStore.mode === 'select'}
          <div class="select-badge">
            <UIIcon name="target" size={12} />
            <span>Select Mode</span>
          </div>
        {/if}
      {/if}
    </div>
    
    {#if browserStore.selectedElement}
      <ElementInspector element={browserStore.selectedElement} />
    {/if}
  </div>
</div>

<style>
  .browser-panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--color-bg);
    overflow: hidden;
    /* Ensure it fills the parent */
    flex: 1 1 100%;
    min-width: 0;
    min-height: 0;
  }

  .browser-content {
    flex: 1 1 100%;
    display: flex;
    overflow: hidden;
    min-height: 0;
    min-width: 0;
  }

  .browser-view {
    flex: 1 1 100%;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #181825;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
  }

  .webview-area {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .state-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 32px;
    text-align: center;
    color: var(--color-text-secondary);
  }

  .state-container h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 500;
    color: var(--color-text);
  }

  .state-container p {
    margin: 0;
    font-size: 13px;
    max-width: 300px;
    opacity: 0.8;
  }

  .state-container.error {
    color: var(--color-error);
  }

  .state-container.error :global(.ui-icon) {
    color: var(--color-error);
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .btn.primary {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .btn.primary:hover {
    filter: brightness(1.1);
  }

  .quick-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
    justify-content: center;
  }

  .quick-links button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: 12px;
    color: var(--color-text);
    transition: all 0.15s ease;
  }

  .quick-links button:hover {
    background: var(--color-hover);
    border-color: var(--color-accent);
    transform: translateY(-1px);
  }

  .loading-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    color: var(--color-text-secondary);
  }

  .loading-indicator span {
    font-size: 12px;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--color-surface1);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .select-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--color-accent);
    color: var(--color-bg);
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    z-index: 10;
    pointer-events: none;
  }
</style>
