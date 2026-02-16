<script lang="ts">
  /**
   * BrowserPanel - Native webview browser with element selection for AI
   * The actual browser is a child webview positioned to match this container
   */
  import { onMount } from 'svelte';
  import { UIIcon } from '$lib/components/ui';
  import { browserStore } from '$lib/stores/browser.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { browserDevToolsStore } from '$lib/stores/browser-devtools.svelte';
  import BrowserToolbar from './BrowserToolbar.svelte';
  import ResizablePanel from '$lib/components/layout/ResizablePanel.svelte';
  import ElementInspector from './ElementInspector.svelte';
  import ElementInspectorPanel from './ElementInspectorPanel.svelte';
  import ConsolePanel from './ConsolePanel.svelte';
  import NetworkPanel from './NetworkPanel.svelte';
  import PerformancePanel from './PerformancePanel.svelte';
  import ApplicationPanel from './ApplicationPanel.svelte';
  import SecurityPanel from './SecurityPanel.svelte';

  interface Props {
    onAskAI?: (context: string) => void;
  }

  let { onAskAI }: Props = $props();

  let containerRef: HTMLDivElement | null = $state(null);
  let browserMainRef: HTMLDivElement | null = $state(null);
  let resizeObserver: ResizeObserver | null = null;
  let updateScheduled = false;
  let mounted = false;
  let lastBoundsStr = '';
  let boundsUpdateCounts = $state<Record<string, number>>({});
  let boundsProfileTimer: ReturnType<typeof setTimeout> | null = null;
  
  // DevTools panel state
  let showDevTools = $state(false);
  let devToolsHeight = $state(200);
  let activeDevToolsTab = $state<'console' | 'network' | 'performance' | 'element' | 'application' | 'security'>('console');
  const DEVTOOLS_HEIGHT_KEY = 'volt.browser.devtoolsHeight';
  const DEVTOOLS_MIN_HEIGHT = 140;
  const DEVTOOLS_DEFAULT_HEIGHT = 200;

  function getDevToolsMaxHeight(): number {
    const hostHeight = browserMainRef?.clientHeight ?? window.innerHeight;
    return Math.max(220, hostHeight - 120);
  }

  function clampDevToolsHeight(height: number): number {
    return Math.max(DEVTOOLS_MIN_HEIGHT, Math.min(getDevToolsMaxHeight(), Math.round(height)));
  }

  function persistDevToolsHeight(height: number): void {
    try {
      localStorage.setItem(DEVTOOLS_HEIGHT_KEY, String(height));
    } catch {
      // ignore storage errors
    }
  }

  function handleDevToolsResize(height: number): void {
    const next = clampDevToolsHeight(height);
    if (next === devToolsHeight) return;
    devToolsHeight = next;
    persistDevToolsHeight(next);
  }
  
  // Auto-show devtools element tab when element is selected
  $effect(() => {
    if (browserStore.selectedElement) {
      showDevTools = true;
      activeDevToolsTab = 'element';
    }
  });

  // Get accurate bounds - use CSS pixels directly (Tauri handles DPI scaling)
  async function getAccurateBounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (!containerRef) return null;
    
    // Force a layout recalculation
    containerRef.offsetHeight;
    
    const rect = containerRef.getBoundingClientRect();
    
    // Ensure we have valid dimensions
    if (rect.width < 10 || rect.height < 10) return null;
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
      return null;
    }
    
    // The Y position should account for toolbar height (~45px) plus any other UI.
    // Only block creation when the browser is not open yet; allow updates when open.
    if (!browserStore.isOpen && rect.top < 60) {
      return null; // Don't create webview yet
    }
    
    // Round to avoid subpixel issues and clamp to viewport
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const MIN_TOP_SAFE = 28; // keep native title/menu region unobstructed
    let x = Math.max(0, Math.round(rect.left));
    let y = Math.max(MIN_TOP_SAFE, Math.round(rect.top));
    let width = Math.round(rect.width);
    let height = Math.round(rect.height);
    if (x + width > viewportWidth) width = Math.max(0, viewportWidth - x);
    if (y + height > viewportHeight) height = Math.max(0, viewportHeight - y);
    
    const bounds = { x, y, width, height };
    if (bounds.width < 20 || bounds.height < 20) return null;
    
    return bounds;
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
      browserStore.setBounds(bounds);
    }
  }

  // Throttled bounds update using RAF
  function scheduleUpdateBounds(): void {
    if (!browserStore.isOpen || !browserStore.isVisible) return;
    if (updateScheduled) return;
    updateScheduled = true;
    requestAnimationFrame(() => {
      updateBounds();
      updateScheduled = false;
    });
  }

  function trackBoundsSource(source: string): void {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem('voltBrowserDebug') !== 'true') return;
    boundsUpdateCounts[source] = (boundsUpdateCounts[source] || 0) + 1;
    if (boundsProfileTimer) return;
    boundsProfileTimer = setTimeout(() => {
      const entries = Object.entries(boundsUpdateCounts).sort((a, b) => b[1] - a[1]);
      if (entries.length > 0) {
        console.log('[Browser] Bounds update sources (last 5s):', Object.fromEntries(entries));
      }
      boundsUpdateCounts = {};
      boundsProfileTimer = null;
    }, 5000);
  }

  // Force immediate bounds update
  function forceUpdateBounds(): void {
    lastBoundsStr = '';
    updateBounds();
  }

  onMount(() => {
    mounted = true;

    try {
      const stored = localStorage.getItem(DEVTOOLS_HEIGHT_KEY);
      if (stored) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) {
          devToolsHeight = clampDevToolsHeight(parsed);
        }
      } else {
        devToolsHeight = clampDevToolsHeight(DEVTOOLS_DEFAULT_HEIGHT);
      }
    } catch {
      devToolsHeight = clampDevToolsHeight(DEVTOOLS_DEFAULT_HEIGHT);
    }
    
    // Initialize devtools store
    browserDevToolsStore.initialize();
    
    // Setup resize observer for container size changes
    if (containerRef) {
      resizeObserver = new ResizeObserver(() => {
        trackBoundsSource('resizeObserver');
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

    // Update bounds on window events
    window.addEventListener('resize', forceUpdateBounds);
    window.addEventListener('scroll', scheduleUpdateBounds, true);
    
    // Periodic bounds check (catches edge cases)
    const intervalId = setInterval(() => {
      if (browserStore.isOpen && browserStore.isVisible && mounted) {
        trackBoundsSource('interval');
        scheduleUpdateBounds();
      }
    }, 1200);
    
    // Initial bounds update with multiple attempts
    setTimeout(forceUpdateBounds, 50);
    setTimeout(forceUpdateBounds, 150);
    setTimeout(forceUpdateBounds, 300);
    setTimeout(forceUpdateBounds, 500);

    return () => {
      mounted = false;
      clearInterval(intervalId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', forceUpdateBounds);
      window.removeEventListener('scroll', scheduleUpdateBounds, true);
      if (boundsProfileTimer) {
        clearTimeout(boundsProfileTimer);
        boundsProfileTimer = null;
      }
    };
  });

  // Update bounds when browser state changes
  $effect(() => {
    if (browserStore.isOpen && browserStore.isVisible && containerRef && mounted) {
      // Reset and force update when browser opens/shows
      // Use longer delays to ensure toolbar is fully rendered
      lastBoundsStr = '';
      // Wait for next frame to ensure layout is complete
      requestAnimationFrame(() => {
        trackBoundsSource('visibility');
        forceUpdateBounds();
        setTimeout(forceUpdateBounds, 100);
        setTimeout(forceUpdateBounds, 300);
        setTimeout(forceUpdateBounds, 500);
      });
    }
  });

  // Recalculate bounds when inspector panel appears/disappears
  $effect(() => {
    // Track inspector visibility to trigger bounds recalc
    void browserStore.selectedElement;
    if (containerRef && mounted) {
      // Force recalculate when inspector toggles
      trackBoundsSource('inspector');
      setTimeout(forceUpdateBounds, 50);
      setTimeout(forceUpdateBounds, 150);
    }
  });

  // Recalculate bounds when devtools panel toggles or resizes
  $effect(() => {
    void showDevTools;
    void devToolsHeight;
    if (containerRef && mounted) {
      trackBoundsSource('devtools');
      setTimeout(forceUpdateBounds, 50);
      setTimeout(forceUpdateBounds, 150);
    }
  });

  // Keep height valid when container is resized.
  $effect(() => {
    const max = getDevToolsMaxHeight();
    if (devToolsHeight > max) {
      devToolsHeight = clampDevToolsHeight(devToolsHeight);
      persistDevToolsHeight(devToolsHeight);
    }
  });

  // Recalculate bounds when UI zoom changes
  $effect(() => {
    void uiStore.zoomPercent;
    if (containerRef && mounted) {
      trackBoundsSource('uiZoom');
      setTimeout(forceUpdateBounds, 50);
      setTimeout(forceUpdateBounds, 150);
    }
  });
</script>

<div class="browser-panel">
  <BrowserToolbar onToggleDevTools={() => showDevTools = !showDevTools} {showDevTools} />
  
  <div class="browser-main" bind:this={browserMainRef}>
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
    </div>

    <!-- DevTools Panel -->
    {#if showDevTools}
      <ResizablePanel
        direction="vertical"
        size={devToolsHeight}
        minSize={DEVTOOLS_MIN_HEIGHT}
        maxSize={getDevToolsMaxHeight()}
        onResize={handleDevToolsResize}
      />
      <div class="devtools-panel" style="height: {devToolsHeight}px">
        <div class="devtools-header">
          <div class="devtools-tabs">
            <button 
              class="devtools-tab" 
              class:active={activeDevToolsTab === 'console'}
              onclick={() => activeDevToolsTab = 'console'}
            >
              <UIIcon name="console" size={12} />
              <span>Console</span>
              {#if browserDevToolsStore.errorCount > 0}
                <span class="badge error">{browserDevToolsStore.errorCount}</span>
              {/if}
            </button>
            <button 
              class="devtools-tab" 
              class:active={activeDevToolsTab === 'element'}
              onclick={() => activeDevToolsTab = 'element'}
            >
              <UIIcon name="target" size={12} />
              <span>Element</span>
              {#if browserStore.selectedElement}
                <span class="badge active">1</span>
              {/if}
            </button>
            <button 
              class="devtools-tab" 
              class:active={activeDevToolsTab === 'network'}
              onclick={() => activeDevToolsTab = 'network'}
            >
              <UIIcon name="globe" size={12} />
              <span>Network</span>
              {#if browserDevToolsStore.failedRequestCount > 0}
                <span class="badge error">{browserDevToolsStore.failedRequestCount}</span>
              {/if}
            </button>
            <button 
              class="devtools-tab" 
              class:active={activeDevToolsTab === 'performance'}
              onclick={() => activeDevToolsTab = 'performance'}
            >
              <UIIcon name="bolt" size={12} />
              <span>Performance</span>
            </button>
            <button
              class="devtools-tab"
              class:active={activeDevToolsTab === 'application'}
              onclick={() => activeDevToolsTab = 'application'}
            >
              <UIIcon name="files" size={12} />
              <span>Application</span>
              {#if browserDevToolsStore.applicationSnapshot}
                <span class="badge active">{browserDevToolsStore.applicationSnapshot.storage_entries.length + browserDevToolsStore.applicationSnapshot.cookies.length}</span>
              {/if}
            </button>
            <button
              class="devtools-tab"
              class:active={activeDevToolsTab === 'security'}
              onclick={() => activeDevToolsTab = 'security'}
            >
              <UIIcon name="warning" size={12} />
              <span>Security</span>
              {#if browserDevToolsStore.securityHighCount > 0}
                <span class="badge error">{browserDevToolsStore.securityHighCount}</span>
              {/if}
            </button>
          </div>
          <div class="devtools-actions">
            <button class="devtools-btn" title="Clear" onclick={() => browserDevToolsStore.clearAll()}>
              <UIIcon name="trash" size={12} />
            </button>
            <button class="devtools-btn" title="Close DevTools" onclick={() => showDevTools = false}>
              <UIIcon name="close" size={12} />
            </button>
          </div>
        </div>
        <div class="devtools-content">
          {#if activeDevToolsTab === 'console'}
            <ConsolePanel {onAskAI} />
          {:else if activeDevToolsTab === 'element'}
            {#if browserStore.selectedElement}
              <div class="element-actions">
                <button class="btn subtle" onclick={() => browserStore.clearSelection()}>
                  <UIIcon name="close" size={12} />
                  <span>Clear selection</span>
                </button>
              </div>
              <ElementInspectorPanel element={browserStore.selectedElement} />
            {:else}
              <div class="placeholder">
                <UIIcon name="target" size={24} />
                <span>No element selected</span>
                <span class="hint">Click the target icon and select an element</span>
              </div>
            {/if}
          {:else if activeDevToolsTab === 'network'}
            <NetworkPanel {onAskAI} />
          {:else if activeDevToolsTab === 'performance'}
            <PerformancePanel {onAskAI} />
          {:else if activeDevToolsTab === 'application'}
            <ApplicationPanel {onAskAI} />
          {:else if activeDevToolsTab === 'security'}
            <SecurityPanel {onAskAI} />
          {/if}
        </div>
      </div>
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
    flex: 1 1 100%;
    min-width: 0;
    min-height: 0;
  }

  .browser-main {
    flex: 1 1 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
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

  /* DevTools Panel */
  .devtools-panel {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-bg-panel);
    border-top: 1px solid var(--color-border);
  }

  .devtools-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px;
    background: var(--color-surface0);
    border-bottom: 1px solid var(--color-border);
    height: 32px;
  }

  .devtools-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .devtools-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 11px;
    color: var(--color-text-secondary);
    border-radius: 4px 4px 0 0;
    transition: all 0.15s ease;
  }

  .devtools-tab:hover {
    color: var(--color-text);
    background: var(--color-hover);
  }

  .devtools-tab.active {
    color: var(--color-text);
    background: var(--color-bg-panel);
    border-bottom: 2px solid var(--color-accent);
  }

  .devtools-tab .badge {
    padding: 1px 5px;
    border-radius: 8px;
    font-size: 9px;
    font-weight: 600;
  }

  .devtools-tab .badge.error {
    background: var(--color-error);
    color: white;
  }

  .devtools-tab .badge.active {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .devtools-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .devtools-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .devtools-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .devtools-content {
    flex: 1;
    overflow: hidden;
  }

  .element-actions {
    display: flex;
    justify-content: flex-end;
    padding: 8px 8px 0 8px;
  }

  .btn.subtle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 11px;
    color: var(--color-text-secondary);
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .btn.subtle:hover {
    color: var(--color-text);
    border-color: var(--color-accent);
  }

  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 100%;
    color: var(--color-text-secondary);
    font-size: 12px;
  }

  .placeholder .hint {
    font-size: 11px;
    opacity: 0.6;
  }
</style>
