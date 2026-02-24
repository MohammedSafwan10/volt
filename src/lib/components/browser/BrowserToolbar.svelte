<script lang="ts">
  /**
   * BrowserToolbar - Clean navigation with organized menus
   */
  import { UIIcon } from '$lib/components/ui';
  import { browserStore, RESPONSIVE_PRESETS } from '$lib/stores/browser.svelte';

  interface Props {
    onToggleDevTools?: () => void;
    showDevTools?: boolean;
    onOverlayMenuReserveChange?: (reserve: { top: number; right: number }) => void;
  }

  let { onToggleDevTools, showDevTools = false, onOverlayMenuReserveChange }: Props = $props();

  let urlInput = $state(browserStore.url);
  let inputFocused = $state(false);
  let showBookmarks = $state(false);
  let showMoreMenu = $state(false);
  let showResponsiveSubmenu = $state(false);
  const MORE_MENU_RIGHT_RESERVE = 300;
  const BOOKMARKS_MENU_RIGHT_RESERVE = 380;

  $effect(() => {
    if (!inputFocused) urlInput = browserStore.url;
  });

  $effect(() => {
    const right = showMoreMenu
      ? MORE_MENU_RIGHT_RESERVE
      : showBookmarks
        ? BOOKMARKS_MENU_RIGHT_RESERVE
        : 0;
    onOverlayMenuReserveChange?.({ top: 0, right });
  });

  // Close dropdowns when clicking outside
  $effect(() => {
    if (!showBookmarks && !showMoreMenu) return;
    
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('.dropdown-wrapper')) {
        showBookmarks = false;
        showMoreMenu = false;
      }
    }
    
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  });

  function handleNavigate(): void {
    if (urlInput.trim()) browserStore.navigate(urlInput.trim());
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

  function getFaviconUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`;
    } catch {
      return '';
    }
  }

  function formatZoom(level: number): string {
    return `${Math.round(level * 100)}%`;
  }

  function navigateToBookmark(url: string): void {
    browserStore.navigate(url);
    showBookmarks = false;
  }

  function handleRemoveBookmark(e: MouseEvent, id: string): void {
    e.stopPropagation();
    browserStore.removeBookmark(id);
  }

  function handleMenuAction(action: () => void): void {
    action();
    showMoreMenu = false;
    showResponsiveSubmenu = false;
  }

  function handleResponsiveAction(action: () => void): void {
    action();
    showMoreMenu = false;
    showResponsiveSubmenu = false;
  }
</script>

<div class="browser-toolbar">
  <!-- Left: Navigation -->
  <div class="nav-group">
    <button class="btn" title="Back (Alt+←)" disabled={!browserStore.canGoBack} onclick={() => browserStore.goBack()}>
      <UIIcon name="arrow-left" size={14} />
    </button>
    <button class="btn" title="Forward (Alt+→)" disabled={!browserStore.canGoForward} onclick={() => browserStore.goForward()}>
      <UIIcon name="arrow-right" size={14} />
    </button>
    <button class="btn" title={browserStore.status === 'loading' ? 'Stop' : 'Reload (Ctrl+R)'} onclick={() => browserStore.status === 'loading' ? browserStore.stop() : browserStore.reload()}>
      {#if browserStore.status === 'loading'}
        <UIIcon name="close" size={14} />
      {:else}
        <UIIcon name="refresh" size={14} />
      {/if}
    </button>
    <button class="btn" title="Home" onclick={() => browserStore.navigate('https://www.google.com')}>
      <UIIcon name="home" size={14} />
    </button>
  </div>

  <!-- Center: URL Bar -->
  <div class="url-bar" class:focused={inputFocused} class:loading={browserStore.status === 'loading'}>
    {#if browserStore.status === 'loading'}
      <div class="spinner"></div>
    {:else if browserStore.url && !inputFocused}
      <img src={getFaviconUrl(browserStore.url)} alt="" class="favicon" onerror={(e) => (e.target as HTMLImageElement).style.display = 'none'} />
    {:else}
      <UIIcon name="globe" size={14} />
    {/if}
    <input type="text" placeholder="Search or enter URL" bind:value={urlInput} onkeydown={handleKeydown} onfocus={() => inputFocused = true} onblur={() => { inputFocused = false; urlInput = browserStore.url; }} />
    
    <!-- Bookmark star inside URL bar -->
    <button class="url-action" class:active={browserStore.isBookmarked(browserStore.url)} title="Bookmark this page" onclick={() => browserStore.isBookmarked(browserStore.url) ? browserStore.removeBookmark(browserStore.bookmarks.find(b => b.url === browserStore.url)?.id || '') : browserStore.addBookmark()}>
      <UIIcon name={browserStore.isBookmarked(browserStore.url) ? 'star-filled' : 'star'} size={14} />
    </button>
  </div>

  <!-- Right: Actions -->
  <div class="action-group">
    <!-- Bookmarks dropdown -->
    <div class="dropdown-wrapper">
      <button class="btn" class:active={showBookmarks} title="Bookmarks" onclick={() => { showBookmarks = !showBookmarks; showMoreMenu = false; }}>
        <UIIcon name="bookmark" size={14} />
      </button>
      
      {#if showBookmarks}
        <div class="dropdown bookmarks-dropdown">
          <div class="dropdown-header">
            <span>Bookmarks</span>
            <span class="count">{browserStore.bookmarks.length}</span>
          </div>
          {#if browserStore.bookmarks.length === 0}
            <div class="empty-state">
              <UIIcon name="star" size={20} />
              <span>No bookmarks yet</span>
              <span class="hint">Click the star in the URL bar</span>
            </div>
          {:else}
            <div class="dropdown-list">
              {#each browserStore.bookmarks as bookmark (bookmark.id)}
                <div class="dropdown-item" role="button" tabindex="0" onclick={() => navigateToBookmark(bookmark.url)} onkeydown={(e) => e.key === 'Enter' && navigateToBookmark(bookmark.url)}>
                  <img src={getFaviconUrl(bookmark.url)} alt="" class="item-icon favicon" onerror={(e) => (e.target as HTMLImageElement).style.display = 'none'} />
                  <div class="item-content">
                    <span class="item-title">{bookmark.title || bookmark.url}</span>
                    <span class="item-subtitle">{bookmark.url}</span>
                  </div>
                  <button class="item-action" title="Remove" onclick={(e) => handleRemoveBookmark(e, bookmark.id)}>
                    <UIIcon name="close" size={12} />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Select Element -->
    <button class="btn" class:active={browserStore.mode === 'select'} title="Select Element" onclick={() => browserStore.toggleSelectMode()}>
      <UIIcon name="target" size={14} />
    </button>

    <!-- DevTools toggle -->
    <button class="btn" class:active={showDevTools} title="Toggle DevTools" onclick={() => onToggleDevTools?.()}>
      <UIIcon name="console" size={14} />
    </button>

    <!-- More menu (three dots) -->
    <div class="dropdown-wrapper">
      <button class="btn" class:active={showMoreMenu} title="More options" onclick={() => { showMoreMenu = !showMoreMenu; showBookmarks = false; }}>
        <UIIcon name="more" size={14} />
      </button>
      
      {#if showMoreMenu}
        <div class="dropdown more-dropdown">
          <!-- Zoom section -->
          <div class="menu-section">
            <div class="menu-section-title">Zoom</div>
            <div class="zoom-controls">
              <button class="zoom-btn" onclick={() => browserStore.zoomOut()}>
                <UIIcon name="minus" size={12} />
              </button>
              <span class="zoom-value" role="button" tabindex="0" onclick={() => handleMenuAction(() => browserStore.zoomReset())} onkeydown={(e) => e.key === 'Enter' && handleMenuAction(() => browserStore.zoomReset())}>{formatZoom(browserStore.zoomLevel)}</span>
              <button class="zoom-btn" onclick={() => browserStore.zoomIn()}>
                <UIIcon name="plus" size={12} />
              </button>
            </div>
          </div>

          <div class="menu-divider"></div>

          <!-- Actions -->
          <button class="menu-item" onclick={() => handleMenuAction(() => browserStore.hardReload())}>
            <UIIcon name="refresh" size={14} />
            <span>Hard Reload</span>
            <span class="shortcut">Ctrl+Shift+R</span>
          </button>
          
          <button class="menu-item" class:active={browserStore.liveReloadEnabled} onclick={() => handleMenuAction(() => browserStore.setLiveReload(!browserStore.liveReloadEnabled))}>
            <UIIcon name="bolt" size={14} />
            <span>Live Reload</span>
            <span class="badge" class:on={browserStore.liveReloadEnabled}>{browserStore.liveReloadEnabled ? 'ON' : 'OFF'}</span>
          </button>
          
          <button class="menu-item" onclick={() => handleMenuAction(() => browserStore.openDevTools())}>
            <UIIcon name="code" size={14} />
            <span>Developer Tools</span>
            <span class="shortcut">F12</span>
          </button>

          <div class="menu-divider"></div>

          <!-- Responsive submenu -->
          <button class="menu-item has-submenu" onclick={() => showResponsiveSubmenu = !showResponsiveSubmenu}>
            <UIIcon name="device-mobile" size={14} />
            <span>Responsive</span>
            {#if browserStore.responsiveMode}
              <span class="badge">{browserStore.responsiveMode.width}×{browserStore.responsiveMode.height}</span>
            {/if}
            <UIIcon name={showResponsiveSubmenu ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
          
          {#if showResponsiveSubmenu}
            <div class="submenu">
              {#if browserStore.responsiveMode}
                <button class="menu-item submenu-item" onclick={() => handleResponsiveAction(() => browserStore.clearResponsiveMode())}>
                  <UIIcon name="device-desktop" size={14} />
                  <span>Exit Responsive Mode</span>
                </button>
              {/if}
              {#each RESPONSIVE_PRESETS as preset}
                <button class="menu-item submenu-item" onclick={() => handleResponsiveAction(() => browserStore.setResponsiveMode(preset.width, preset.height))}>
                  <UIIcon name={preset.width < 500 ? 'device-mobile' : 'device-desktop'} size={14} />
                  <span>{preset.name}</span>
                  <span class="shortcut dim">{preset.width}×{preset.height}</span>
                </button>
              {/each}
            </div>
          {/if}

          <div class="menu-divider"></div>

          <!-- History -->
          <button class="menu-item" onclick={() => handleMenuAction(() => browserStore.loadHistory())}>
            <UIIcon name="clock" size={14} />
            <span>History</span>
          </button>

          <button class="menu-item" onclick={() => handleMenuAction(() => browserStore.clearHistory())}>
            <UIIcon name="trash" size={14} />
            <span>Clear History</span>
          </button>
        </div>
      {/if}
    </div>

    <div class="separator"></div>

    <!-- Close -->
    <button class="btn close" title="Close Browser" onclick={() => browserStore.close()}>
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
    position: relative;
    z-index: 20;
    overflow: visible;
  }

  .nav-group, .action-group {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .nav-group {
    flex-shrink: 0;
  }

  .action-group {
    flex-shrink: 0;
    margin-left: 2px;
  }

  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 6px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .btn:hover:not(:disabled) {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .btn.active {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .btn.close:hover {
    background: var(--color-error);
    color: white;
  }

  /* URL Bar */
  .url-bar {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 12px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 20px;
    min-width: 0;
    transition: all 0.2s ease;
  }

  @media (max-width: 920px) {
    .nav-group .btn:nth-child(4) {
      display: none;
    }
  }

  @media (max-width: 760px) {
    .nav-group .btn:nth-child(2) {
      display: none;
    }
  }

  .url-bar:hover {
    border-color: var(--color-text-secondary);
  }

  .url-bar.focused {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 15%, transparent);
  }

  .url-bar :global(.ui-icon) {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .url-bar input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 13px;
    color: var(--color-text);
    min-width: 0;
  }

  .url-bar input::placeholder {
    color: var(--color-text-secondary);
  }

  .url-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .url-action:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .url-action.active {
    color: var(--color-warning);
  }

  .favicon {
    width: 14px;
    height: 14px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--color-surface1);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .separator {
    width: 1px;
    height: 20px;
    background: var(--color-border);
    margin: 0 4px;
  }

  /* Dropdown wrapper */
  .dropdown-wrapper {
    position: relative;
  }

  .dropdown {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 99999;
    overflow: hidden;
  }

  .bookmarks-dropdown {
    width: 320px;
    max-height: 400px;
    display: flex;
    flex-direction: column;
  }

  .more-dropdown {
    width: 240px;
    max-height: 500px;
    overflow-y: auto;
  }

  .dropdown-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-border);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text);
  }

  .dropdown-header .count {
    background: var(--color-surface1);
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 32px 16px;
    color: var(--color-text-secondary);
  }

  .empty-state span {
    font-size: 13px;
  }

  .empty-state .hint {
    font-size: 11px;
    opacity: 0.7;
  }

  .dropdown-list {
    overflow-y: auto;
    max-height: 340px;
    padding: 6px;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px;
    border-radius: 8px;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .dropdown-item:hover {
    background: var(--color-hover);
  }

  .item-icon {
    flex-shrink: 0;
  }

  .item-icon.favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }

  .item-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .item-title {
    font-size: 12px;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-subtitle {
    font-size: 10px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    opacity: 0;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .dropdown-item:hover .item-action {
    opacity: 1;
  }

  .item-action:hover {
    background: var(--color-error);
    color: white;
  }

  /* More menu styles */
  .menu-section {
    padding: 8px;
  }

  .menu-section-title {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 4px 8px 8px;
  }

  .menu-divider {
    height: 1px;
    background: var(--color-border);
    margin: 4px 0;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--color-text);
    text-align: left;
    transition: background 0.15s ease;
  }

  .menu-item:hover {
    background: var(--color-hover);
  }

  .menu-item :global(.ui-icon) {
    color: var(--color-text-secondary);
  }

  .menu-item span:first-of-type {
    flex: 1;
  }

  .shortcut {
    font-size: 10px;
    color: var(--color-text-secondary);
    opacity: 0.7;
  }

  .shortcut.dim {
    opacity: 0.5;
  }

  /* Zoom controls in menu */
  .zoom-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 4px 8px;
  }

  .zoom-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .zoom-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .zoom-value {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text);
    min-width: 48px;
    text-align: center;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  .zoom-value:hover {
    background: var(--color-hover);
  }

  /* Submenu styles */
  .menu-item.has-submenu {
    cursor: pointer;
  }

  .menu-item.has-submenu :global(.ui-icon:last-child) {
    margin-left: auto;
    opacity: 0.5;
  }

  .badge {
    font-size: 9px;
    padding: 2px 6px;
    background: var(--color-surface1);
    color: var(--color-text-secondary);
    border-radius: 8px;
    font-weight: 500;
  }

  .badge.on {
    background: var(--color-success, #22c55e);
    color: white;
  }

  .menu-item.active {
    background: var(--color-surface0);
  }

  .submenu {
    background: var(--color-surface0);
    border-top: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
    margin: 4px 0;
  }

  .submenu-item {
    padding-left: 20px;
  }

  .submenu-item:first-child {
    border-radius: 0;
  }
</style>
