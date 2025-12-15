<script lang="ts">
  /**
   * SymbolPicker - Symbol search UI for Go to Symbol in File / Workspace
   * 
   * Integrates with LSP textDocument/documentSymbol and workspace/symbol
   */
  import { UIIcon } from '$lib/components/ui';
  import { editorStore } from '$lib/stores/editor.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    type Symbol,
    getDocumentSymbols,
    getWorkspaceSymbols,
    filterSymbols,
    cancelSymbolRequests,
    symbolKindIcons
  } from '$lib/services/lsp/symbols';

  function isSupportedForSymbols(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    // Currently supported via our LSP tooling. (HTML/etc would need additional LSP wiring.)
    return ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs', 'svelte'].includes(ext);
  }

  type SymbolMode = 'file' | 'workspace';

  interface Props {
    /** Whether the picker is open */
    open: boolean;
    /** Symbol search mode */
    mode: SymbolMode;
    /** Called when picker should close */
    onClose: () => void;
  }

  let { open, mode, onClose }: Props = $props();

  let searchQuery = $state('');
  let selectedIndex = $state(0);
  let inputElement: HTMLInputElement | undefined = $state();
  let symbols = $state<Symbol[]>([]);
  let filteredSymbols = $state<Symbol[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  // Debounce timer for workspace symbol search
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 150;

  // Track current request to ignore stale results
  let requestId = 0;

  // Focus input when dialog opens
  $effect(() => {
    if (open) {
      searchQuery = '';
      selectedIndex = 0;
      symbols = [];
      filteredSymbols = [];
      error = null;
      requestId++;
      
      setTimeout(() => inputElement?.focus(), 0);
      
      if (mode === 'file') {
        void loadFileSymbols();
      }
    } else {
      // Cancel pending requests when closing
      cancelSymbolRequests();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }
  });

  // Filter symbols when query changes (for file mode)
  // For workspace mode, we need to re-query the LSP
  $effect(() => {
    if (!open) return;
    
    if (mode === 'file') {
      // Local filtering for file symbols
      filteredSymbols = filterSymbols(symbols, searchQuery);
      selectedIndex = 0;
    } else {
      // Debounced LSP query for workspace symbols
      debouncedWorkspaceSearch(searchQuery);
    }
  });

  async function loadFileSymbols(): Promise<void> {
    const activeFile = editorStore.activeFile;
    if (!activeFile) {
      error = 'No file open';
      return;
    }

    if (!isSupportedForSymbols(activeFile.path)) {
      loading = false;
      error = 'Symbol search unavailable for this file type';
      symbols = [];
      filteredSymbols = [];
      return;
    }

    loading = true;
    error = 'Starting language services…';
    const currentRequest = ++requestId;

    try {
      const result = await getDocumentSymbols(activeFile.path);
      
      // Ignore stale results
      if (currentRequest !== requestId || !open) return;
      
      if (result === null) {
        error = 'Failed to load symbols';
        symbols = [];
      } else {
        error = null;
        symbols = result;
        filteredSymbols = filterSymbols(result, searchQuery);
      }
    } catch (err) {
      if (currentRequest !== requestId || !open) return;
      error = 'Error loading symbols';
      symbols = [];
    } finally {
      if (currentRequest === requestId) {
        loading = false;
      }
    }
  }

  function debouncedWorkspaceSearch(query: string): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    // For empty query, show nothing (workspace search requires a query)
    if (!query.trim()) {
      filteredSymbols = [];
      loading = false;
      return;
    }

    loading = true;
    
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      await searchWorkspaceSymbols(query);
    }, DEBOUNCE_MS);
  }

  async function searchWorkspaceSymbols(query: string): Promise<void> {
    const currentRequest = ++requestId;
    loading = true;
    error = 'Starting language services…';

    try {
      const result = await getWorkspaceSymbols(query);
      
      // Ignore stale results
      if (currentRequest !== requestId || !open) return;
      
      if (result === null) {
        // Request was cancelled or failed
        filteredSymbols = [];
      } else {
        error = null;
        filteredSymbols = result;
        selectedIndex = 0;
      }
    } catch (err) {
      if (currentRequest !== requestId || !open) return;
      error = 'Error searching symbols';
      filteredSymbols = [];
    } finally {
      if (currentRequest === requestId) {
        loading = false;
      }
    }
  }

  async function navigateToSymbol(symbol: Symbol): Promise<void> {
    onClose();
    
    // Open the file if not already open
    const success = await editorStore.openFile(symbol.filePath);
    if (!success) {
      showToast({ message: `Failed to open ${symbol.fileName}`, type: 'error' });
      return;
    }

    // Navigate to the symbol position
    // Use a small delay to ensure the editor has loaded the file
    setTimeout(() => {
      const event = new CustomEvent('volt:navigate-to-position', {
        detail: {
          file: symbol.filePath,
          line: symbol.line,
          column: symbol.column
        }
      });
      window.dispatchEvent(event);
    }, 50);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (!open) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (filteredSymbols.length > 0) {
          selectedIndex = (selectedIndex + 1) % filteredSymbols.length;
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (filteredSymbols.length > 0) {
          selectedIndex = selectedIndex <= 0 ? filteredSymbols.length - 1 : selectedIndex - 1;
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredSymbols[selectedIndex]) {
          void navigateToSymbol(filteredSymbols[selectedIndex]);
        }
        break;
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose();
  }

  function scrollIntoView(node: HTMLElement, isSelected: boolean): { update: (s: boolean) => void } {
    function update(s: boolean) {
      if (s) node.scrollIntoView({ block: 'nearest' });
    }
    update(isSelected);
    return { update };
  }

  function getPlaceholder(): string {
    if (mode === 'file') {
      return 'Go to symbol in file...';
    }
    return 'Search symbols in workspace...';
  }

  function getTitle(): string {
    if (mode === 'file') {
      return 'Go to Symbol in File';
    }
    return 'Go to Symbol in Workspace';
  }

  function getSymbolIcon(kind: number): string {
    return symbolKindIcons[kind] || '❓';
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="symbol-picker-backdrop" role="presentation" onclick={handleBackdropClick}>
    <div class="symbol-picker" role="dialog" aria-label={getTitle()}>
      <div class="search-container">
        <span class="search-icon" aria-hidden="true">
          <UIIcon name="symbol-method" size={16} />
        </span>
        <input
          bind:this={inputElement}
          bind:value={searchQuery}
          type="text"
          class="search-input"
          placeholder={getPlaceholder()}
          aria-label={getTitle()}
          autocomplete="off"
          spellcheck="false"
        />
        <div class="search-hint" aria-hidden="true">
          <kbd class="key">Esc</kbd>
        </div>
      </div>

      <div class="results-list" role="listbox">
        {#if loading && filteredSymbols.length === 0}
          <div class="status-message">
            <span class="spinner"></span>
            {error || 'Loading symbols...'}
          </div>
        {:else if error && filteredSymbols.length === 0}
          <div class="status-message error">{error}</div>
        {:else if mode === 'workspace' && !searchQuery.trim()}
          <div class="status-message">Type to search symbols in workspace</div>
        {:else if filteredSymbols.length === 0}
          <div class="status-message">No symbols found</div>
        {:else}
          {#each filteredSymbols as symbol, index (symbol.filePath + ':' + symbol.line + ':' + symbol.column + ':' + symbol.name)}
            <button
              class="result-item"
              class:selected={index === selectedIndex}
              onclick={() => void navigateToSymbol(symbol)}
              onmouseenter={() => (selectedIndex = index)}
              role="option"
              aria-selected={index === selectedIndex}
              use:scrollIntoView={index === selectedIndex}
            >
              <span class="symbol-icon" title={symbol.kindName}>
                {getSymbolIcon(symbol.kind)}
              </span>
              <div class="symbol-info">
                <span class="symbol-name" class:deprecated={symbol.deprecated}>
                  {symbol.name}
                </span>
                {#if symbol.containerPath}
                  <span class="symbol-container">{symbol.containerPath}</span>
                {/if}
              </div>
              <div class="symbol-meta">
                <span class="symbol-kind">{symbol.kindName}</span>
                {#if mode === 'workspace'}
                  <span class="symbol-file">{symbol.fileName}</span>
                {/if}
                <span class="symbol-location">:{symbol.line}</span>
              </div>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .symbol-picker-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--color-bg) 40%, transparent);
    backdrop-filter: blur(6px);
    display: flex;
    justify-content: center;
    padding-top: 8vh;
    z-index: 9999;
  }

  .symbol-picker {
    width: 100%;
    max-width: 680px;
    max-height: 480px;
    background: var(--color-bg-elevated, var(--color-bg-sidebar));
    border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
    border-radius: 12px;
    box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .search-container {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 85%, transparent);
    gap: 10px;
    background: color-mix(in srgb, var(--color-bg-elevated, var(--color-bg-sidebar)) 85%, var(--color-surface0));
  }

  .search-container:focus-within {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent);
  }

  .search-icon {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    color: var(--color-text);
    padding: 0;
    font-family: inherit;
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .search-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0.8;
    flex-shrink: 0;
  }

  .results-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }

  .status-message {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 13px;
  }

  .status-message.error {
    color: var(--color-error);
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .result-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 6px 16px;
    cursor: pointer;
    transition: background-color 0.1s ease;
    text-align: left;
    gap: 10px;
  }

  .result-item:hover,
  .result-item.selected {
    background: var(--color-hover);
  }

  .result-item.selected {
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  }

  .symbol-icon {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    font-size: 14px;
  }

  .symbol-info {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }

  .symbol-name {
    font-size: 13px;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }

  .symbol-name.deprecated {
    text-decoration: line-through;
    opacity: 0.7;
  }

  .symbol-container {
    font-size: 12px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .symbol-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .symbol-kind {
    font-size: 11px;
    color: var(--color-text-secondary);
    text-transform: lowercase;
    background: color-mix(in srgb, var(--color-surface0) 60%, transparent);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .symbol-file {
    font-size: 11px;
    color: var(--color-text-secondary);
    max-width: 120px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .symbol-location {
    font-size: 11px;
    color: var(--color-text-disabled);
    font-family: monospace;
  }

  .key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    font-size: 11px;
    font-family: inherit;
    color: var(--color-text-secondary);
    background: color-mix(in srgb, var(--color-surface0) 78%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
    border-radius: 6px;
  }
</style>
