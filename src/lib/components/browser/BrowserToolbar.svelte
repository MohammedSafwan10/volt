<script lang="ts">
  /**
   * BrowserToolbar - Navigation controls for native webview browser
   */
  import { UIIcon } from '$lib/components/ui';
  import { browserStore } from '$lib/stores/browser.svelte';

  let urlInput = $state(browserStore.url);
  let inputFocused = $state(false);

  // Sync URL input with store when not focused
  $effect(() => {
    if (!inputFocused) {
      urlInput = browserStore.url;
    }
  });

  function handleNavigate(): void {
    if (urlInput.trim()) {
      browserStore.navigate(urlInput.trim());
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleNavigate();
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') {
      urlInput = browserStore.url;
      (e.target as HTMLInputElement).blur();
    }
  }

  function handleFocus(e: FocusEvent): void {
    inputFocused = true;
    // Select all text on focus
    (e.target as HTMLInputElement).select();
  }

  function handleBlur(): void {
    inputFocused = false;
    urlInput = browserStore.url;
  }

  function goHome(): void {
    browserStore.navigate('https://www.google.com');
  }

  // Format URL for display
  function formatUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Show just domain for cleaner look when not focused
      if (!inputFocused && parsed.pathname === '/' && !parsed.search) {
        return parsed.hostname;
      }
      return url;
    } catch {
      return url;
    }
  }

  // Get favicon URL
  function getFaviconUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`;
    } catch {
      return '';
    }
  }
</script>

<div class="browser-toolbar">
  <div class="nav-buttons">
    <button
      class="nav-btn"
      title="Back (Alt+Left)"
      disabled={!browserStore.canGoBack}
      onclick={() => browserStore.goBack()}
    >
      <UIIcon name="arrow-left" size={14} />
    </button>
    
    <button
      class="nav-btn"
      title="Forward (Alt+Right)"
      disabled={!browserStore.canGoForward}
      onclick={() => browserStore.goForward()}
    >
      <UIIcon name="arrow-right" size={14} />
    </button>
    
    <button
      class="nav-btn"
      title={browserStore.status === 'loading' ? 'Stop' : 'Reload (Ctrl+R)'}
      onclick={() => browserStore.reload()}
    >
      {#if browserStore.status === 'loading'}
        <UIIcon name="close" size={14} />
      {:else}
        <UIIcon name="refresh" size={14} />
      {/if}
    </button>

    <button
      class="nav-btn"
      title="Home"
      onclick={goHome}
    >
      <UIIcon name="home" size={14} />
    </button>
  </div>

  <div class="url-bar" class:focused={inputFocused} class:loading={browserStore.status === 'loading'}>
    {#if browserStore.status === 'loading'}
      <div class="loading-indicator"></div>
    {:else if browserStore.url && !inputFocused}
      <img 
        src={getFaviconUrl(browserStore.url)} 
        alt="" 
        class="favicon"
        onerror={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />
    {:else}
      <UIIcon name="globe" size={14} />
    {/if}
    
    <input
      type="text"
      class="url-input"
      placeholder="Search Google or enter URL"
      bind:value={urlInput}
      onkeydown={handleKeydown}
      onfocus={handleFocus}
      onblur={handleBlur}
    />
    
    {#if urlInput && inputFocused}
      <button class="clear-btn" onclick={() => { urlInput = ''; }}>
        <UIIcon name="close" size={12} />
      </button>
    {/if}
  </div>

  <div class="tool-buttons">
    <button
      class="tool-btn"
      class:active={browserStore.mode === 'select'}
      title="Select Element (Inspect)"
      onclick={() => browserStore.toggleSelectMode()}
    >
      <UIIcon name="target" size={14} />
    </button>
    
    <button
      class="tool-btn close"
      title="Close Browser (Ctrl+Shift+B)"
      onclick={() => browserStore.close()}
    >
      <UIIcon name="close" size={14} />
    </button>
  </div>
</div>

<style>
  .browser-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--color-bg-panel);
    border-bottom: 1px solid var(--color-border);
  }

  .nav-buttons {
    display: flex;
    gap: 2px;
  }

  .nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 6px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .nav-btn:hover:not(:disabled) {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .nav-btn:active:not(:disabled) {
    transform: scale(0.95);
  }

  .nav-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .url-bar {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 22px;
    transition: all 0.2s ease;
    min-width: 0;
  }

  .url-bar:hover {
    border-color: var(--color-text-secondary);
  }

  .url-bar.focused {
    border-color: var(--color-accent);
    background: var(--color-bg);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 15%, transparent);
  }

  .url-bar.loading {
    border-color: var(--color-accent);
  }

  .url-bar :global(.ui-icon) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .favicon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    border-radius: 2px;
  }

  .loading-indicator {
    width: 14px;
    height: 14px;
    border: 2px solid var(--color-surface1);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .url-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 13px;
    color: var(--color-text);
    min-width: 0;
  }

  .url-input::placeholder {
    color: var(--color-text-secondary);
  }

  .url-input::selection {
    background: color-mix(in srgb, var(--color-accent) 30%, transparent);
  }

  .clear-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .clear-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .tool-buttons {
    display: flex;
    gap: 2px;
  }

  .tool-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 6px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .tool-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .tool-btn.active {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .tool-btn.active:hover {
    filter: brightness(1.1);
  }

  .tool-btn.close:hover {
    background: var(--color-error);
    color: white;
  }
</style>
