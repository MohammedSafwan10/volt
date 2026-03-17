<script lang="ts">
  /**
   * SearchPanel - Workspace search and replace panel
   * VS Code-style search with file grouping and match previews
   * 
   * Uses virtualization for large result sets to maintain smooth scrolling.
   */
  import { searchStore, type SearchMatch, type FileMatches } from '$features/search/stores/search.svelte';
  import { projectStore } from '$shared/stores/project.svelte';
  import { editorStore } from '$features/editor/stores/editor.svelte';
  import { UIIcon, VirtualList } from '$shared/components/ui';

  // Local state
  let showReplace = $state(false);
  let showFilters = $state(false);
  let searchInputRef: HTMLInputElement | null = $state(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = $state(null);
  let virtualListRef: ReturnType<typeof VirtualList> | undefined = $state();
  let focusedResultIndex = $state(-1);

  // Virtualization constants - VS Code uses ~22px for rows
  const ROW_HEIGHT = 22;
  const OVERSCAN = 10;

  // Derived
  const hasResults = $derived(searchStore.results !== null);
  const resultCount = $derived(searchStore.results?.totalMatches ?? 0);
  const fileCount = $derived(searchStore.results?.totalFiles ?? 0);
  const wasCancelled = $derived(searchStore.lastSearchCancelled);
  const searchStatusLabel = $derived.by(() => {
    switch (searchStore.searchEngineStatus) {
      case 'rg-bundled':
        return 'Search: rg (bundled)';
      case 'rg-system':
        return 'Search: rg (system)';
      case 'legacy-fallback':
        return 'Search: backend legacy';
      default:
        return 'Search: unavailable';
    }
  });
  const semanticStatusLabel = $derived.by(() => {
    switch (searchStore.semanticBackendStatus) {
      case 'local-onnx':
        return 'Semantic: local-onnx';
      case 'local-onnx-fallback':
        return 'Semantic: fallback';
      case 'disabled':
        return 'Semantic: disabled';
      case 'error':
        return 'Semantic: error';
      default:
        return 'Semantic: unknown';
    }
  });

  // Flatten results for virtualization - each file header and match is a row
  type FlatItem = 
    | { type: 'file'; file: FileMatches }
    | { type: 'match'; file: FileMatches; match: SearchMatch; matchIndex: number };

  const flatItems = $derived.by(() => {
    const items: FlatItem[] = [];
    if (!searchStore.results) return items;

    for (const file of searchStore.results.files) {
      items.push({ type: 'file', file });
      if (searchStore.expandedFiles.has(file.path)) {
        for (let i = 0; i < file.matches.length; i++) {
          items.push({ type: 'match', file, match: file.matches[i], matchIndex: i });
        }
      }
    }
    return items;
  });

  // Generate unique key for each item
  function getItemKey(item: FlatItem): string {
    if (item.type === 'file') {
      return `file:${item.file.path}`;
    }
    return `match:${item.file.path}:${item.matchIndex}`;
  }

  function handleSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    searchStore.query = target.value;

    // Debounce search
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (projectStore.rootPath && searchStore.query.trim()) {
        void searchStore.search(projectStore.rootPath);
      } else {
        searchStore.results = null;
      }
    }, 300);
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    handlePanelKeydown(event);
    if (event.defaultPrevented) return;

    if (event.key === 'Enter') {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (projectStore.rootPath) {
        void searchStore.search(projectStore.rootPath);
      }
    } else if (event.key === 'Escape') {
      searchStore.clear();
      focusedResultIndex = -1;
    } else if (event.key === 'ArrowDown' && hasResults) {
      // Move focus to results list
      event.preventDefault();
      focusedResultIndex = 0;
      virtualListRef?.focus();
    }
  }

  function handlePanelKeydown(event: KeyboardEvent): void {
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      if (event.code === 'KeyC') {
        event.preventDefault();
        searchStore.toggleCaseSensitive();
        if (projectStore.rootPath && searchStore.query.trim()) void searchStore.search(projectStore.rootPath);
      } else if (event.code === 'KeyW') {
        event.preventDefault();
        searchStore.toggleWholeWord();
        if (projectStore.rootPath && searchStore.query.trim()) void searchStore.search(projectStore.rootPath);
      } else if (event.code === 'KeyR') {
        event.preventDefault();
        searchStore.toggleRegex();
        if (projectStore.rootPath && searchStore.query.trim()) void searchStore.search(projectStore.rootPath);
      }
    }

    if (event.ctrlKey && event.altKey && event.key === 'Enter') {
      if (!showReplace) return;
      event.preventDefault();
      void handleReplaceAll();
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      searchStore.clear();
    }
  }

  function handleReplaceInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    searchStore.replaceText = target.value;
  }

  function handleIncludeInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    searchStore.includePatterns = target.value;
  }

  function handleExcludeInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    searchStore.excludePatterns = target.value;
  }

  async function handleReplaceAll(): Promise<void> {
    if (!projectStore.rootPath || !searchStore.results) return;
    const count = searchStore.results.totalMatches;
    const files = searchStore.results.totalFiles;
    const confirmed = window.confirm(
      `Replace ${count} occurrence${count === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}?`
    );
    if (confirmed) {
      await searchStore.replaceAll(projectStore.rootPath);
    }
  }

  async function handleReplaceNext(): Promise<void> {
    if (!projectStore.rootPath) return;
    await searchStore.replaceNext(projectStore.rootPath);
  }

  async function handleReplaceInFile(path: string, e: MouseEvent): Promise<void> {
    e.stopPropagation();
    const success = await searchStore.replaceInSingleFile(path);
    if (success && projectStore.rootPath) {
      await searchStore.search(projectStore.rootPath);
    }
  }

  function handleMatchClick(filePath: string, match: SearchMatch): void {
    searchStore.selectMatch(filePath, match);
    void openMatchInEditor(filePath, match);
  }

  async function openMatchInEditor(filePath: string, match: SearchMatch): Promise<void> {
    const opened = await editorStore.openFile(filePath);
    if (!opened) return;
    const normalizedPath = filePath.replace(/\\/g, '/');
    window.dispatchEvent(
      new CustomEvent('volt:navigate-to-position', {
        detail: { file: normalizedPath, line: match.line, column: match.columnStart + 1 }
      })
    );
  }

  /**
   * Handle keyboard selection of a result item
   */
  function handleResultSelect(index: number, item: FlatItem): void {
    if (item.type === 'file') {
      // Toggle file expansion
      searchStore.toggleFileExpanded(item.file.path);
    } else {
      // Open match in editor
      handleMatchClick(item.file.path, item.match);
    }
  }

  /**
   * Handle focus change in results list
   */
  function handleResultFocusChange(index: number): void {
    focusedResultIndex = index;
  }

  function getFileName(path: string): string {
    return path.split(/[/\\]/).pop() || path;
  }

  function getRelativePath(path: string): string {
    if (!projectStore.rootPath) return path;
    const root = projectStore.rootPath.replace(/\\/g, '/');
    const filePath = path.replace(/\\/g, '/');
    if (filePath.startsWith(root)) {
      return filePath.slice(root.length + 1);
    }
    return path;
  }

  function highlightMatch(lineContent: string, match: SearchMatch): string {
    const before = escapeHtml(lineContent.slice(0, match.columnStart));
    const matched = escapeHtml(lineContent.slice(match.columnStart, match.columnEnd));
    const after = escapeHtml(lineContent.slice(match.columnEnd));
    return `${before}<mark class="search-highlight">${matched}</mark>${after}`;
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  $effect(() => {
    if (searchInputRef) {
      searchInputRef.focus();
    }
  });
</script>

<div class="search-panel">
  <div class="search-inputs">
    <div class="search-row">
      <button
        class="expand-toggle"
        class:active={showReplace}
        onclick={() => (showReplace = !showReplace)}
        title={showReplace ? 'Hide Replace' : 'Show Replace'}
        aria-label={showReplace ? 'Hide Replace' : 'Show Replace'}
        aria-expanded={showReplace}
      >
        <UIIcon name={showReplace ? 'chevron-down' : 'chevron-right'} size={16} />
      </button>
      <div class="input-fields">
        <div class="input-wrapper">
          <input
            type="text"
            class="search-input"
            placeholder="Search"
            value={searchStore.query}
            oninput={handleSearchInput}
            onkeydown={handleSearchKeydown}
            bind:this={searchInputRef}
            aria-label="Search query"
          />
        </div>
        <div class="search-options">
          <button
            class="option-btn"
            class:active={searchStore.caseSensitive}
            onclick={() => {
              searchStore.toggleCaseSensitive();
              if (projectStore.rootPath && searchStore.query.trim()) void searchStore.search(projectStore.rootPath);
            }}
            title="Match Case (Alt+C)"
            aria-label="Match Case"
            aria-pressed={searchStore.caseSensitive}
          >
            <span class="option-icon">Aa</span>
          </button>
          <button
            class="option-btn"
            class:active={searchStore.wholeWord}
            onclick={() => {
              searchStore.toggleWholeWord();
              if (projectStore.rootPath && searchStore.query.trim()) void searchStore.search(projectStore.rootPath);
            }}
            title="Match Whole Word (Alt+W)"
            aria-label="Match Whole Word"
            aria-pressed={searchStore.wholeWord}
          >
            <span class="option-icon whole-word">ab</span>
          </button>
          <button
            class="option-btn"
            class:active={searchStore.useRegex}
            onclick={() => {
              searchStore.toggleRegex();
              if (projectStore.rootPath && searchStore.query.trim()) void searchStore.search(projectStore.rootPath);
            }}
            title="Use Regular Expression (Alt+R)"
            aria-label="Use Regular Expression"
            aria-pressed={searchStore.useRegex}
          >
            <span class="option-icon">.*</span>
          </button>
        </div>

        {#if showReplace}
          <div class="input-wrapper replace-wrapper">
            <input
              type="text"
              class="search-input"
              placeholder="Replace"
              value={searchStore.replaceText}
              oninput={handleReplaceInput}
              onkeydown={handlePanelKeydown}
              aria-label="Replace text"
            />
          </div>
          <div class="replace-actions">
            <button
              class="replace-btn"
              onclick={handleReplaceNext}
              disabled={!hasResults || searchStore.searching}
              title="Replace (selected/next)"
              aria-label="Replace"
            >
              <UIIcon name="replace" size={16} />
            </button>
            <button
              class="replace-btn"
              onclick={handleReplaceAll}
              disabled={!hasResults || searchStore.searching}
              title="Replace All (Ctrl+Alt+Enter)"
              aria-label="Replace All"
            >
              <UIIcon name="replace-all" size={16} />
            </button>
          </div>
        {/if}
      </div>
    </div>

    <button
      class="filter-toggle"
      onclick={() => (showFilters = !showFilters)}
      aria-expanded={showFilters}
    >
      <UIIcon name={showFilters ? 'chevron-down' : 'chevron-right'} size={12} />
      <span>files to include/exclude</span>
    </button>

    {#if showFilters}
      <div class="filter-inputs">
        <input
          type="text"
          class="filter-input"
          placeholder="files to include (e.g., src/**/*.ts, **/*.svelte)"
          value={searchStore.includePatterns}
          oninput={handleIncludeInput}
          onkeydown={handlePanelKeydown}
          aria-label="Files to include"
        />
        <input
          type="text"
          class="filter-input"
          placeholder="files to exclude (e.g., node_modules/**, **/*.min.js)"
          value={searchStore.excludePatterns}
          oninput={handleExcludeInput}
          onkeydown={handlePanelKeydown}
          aria-label="Files to exclude"
        />
      </div>
    {/if}
  </div>

  <!-- Results Section with Virtualization -->
  <div class="search-results">
    {#if searchStore.searching && !hasResults}
      <div class="search-status">
        <span class="spinner"></span>
        <span>Searching...</span>
      </div>
    {:else if hasResults}
      <div class="results-header">
        <span class="results-count">
          {resultCount} result{resultCount === 1 ? '' : 's'} in {fileCount} file{fileCount === 1 ? '' : 's'}
        </span>
        <span
          class="engine-badge"
          class:warning={searchStore.searchEngineStatus === 'legacy-fallback'}
          title={searchStore.searchEngineHint ?? searchStatusLabel}
        >
          {searchStatusLabel}
        </span>
        <span
          class="engine-badge"
          class:warning={searchStore.semanticBackendStatus === 'local-onnx-fallback' || searchStore.semanticBackendStatus === 'error'}
          title={semanticStatusLabel}
        >
          {semanticStatusLabel}
        </span>
        {#if searchStore.searching}
          <span class="truncated-warning" title="Searching...">
            <span class="spinner"></span>
          </span>
        {/if}
        {#if searchStore.results?.truncated}
          <span class="truncated-warning" title="Results were truncated">(truncated)</span>
        {/if}
        <div class="results-actions">
          <button class="icon-btn" onclick={() => searchStore.expandAll()} title="Expand All" aria-label="Expand All">
            <UIIcon name="expand-all" size={14} />
          </button>
          <button class="icon-btn" onclick={() => searchStore.collapseAll()} title="Collapse All" aria-label="Collapse All">
            <UIIcon name="collapse-all" size={14} />
          </button>
        </div>
      </div>

      <!-- Virtualized results list with keyboard navigation -->
      <VirtualList
        bind:this={virtualListRef}
        role="tree"
        aria-label="Search results"
        items={flatItems}
        rowHeight={ROW_HEIGHT}
        overscan={OVERSCAN}
        getKey={(item: FlatItem) => getItemKey(item)}
        focusedIndex={focusedResultIndex}
        onFocusChange={handleResultFocusChange}
        onSelect={handleResultSelect}
      >
        {#snippet children({ item, style, focused, index: _index })}
          {#if item.type === 'file'}
            <div
              class="file-header-row"
              class:focused
              style={style}
              role="treeitem"
              aria-selected={searchStore.selectedFile === item.file.path}
              aria-expanded={searchStore.expandedFiles.has(item.file.path)}
            >
              <button
                class="file-header"
                onclick={() => searchStore.toggleFileExpanded(item.file.path)}
                aria-label={`${getFileName(item.file.path)}, ${item.file.matches.length} matches`}
                tabindex="-1"
              >
                <UIIcon
                  name={searchStore.expandedFiles.has(item.file.path) ? 'chevron-down' : 'chevron-right'}
                  size={12}
                />
                <span class="file-name">{getFileName(item.file.path)}</span>
                <span class="file-path">{getRelativePath(item.file.path)}</span>
                <span class="match-count">{item.file.matches.length}</span>
              </button>
              {#if showReplace}
                <button
                  class="replace-file-btn"
                  onclick={(e) => handleReplaceInFile(item.file.path, e)}
                  title="Replace in this file"
                  aria-label="Replace in this file"
                  tabindex="-1"
                >
                  <UIIcon name="replace" size={12} />
                </button>
              {/if}
            </div>
          {:else}
            <button
              class="match-item"
              class:focused
              style={style}
              class:selected={searchStore.selectedFile === item.file.path && 
                             searchStore.selectedMatch?.line === item.match.line &&
                             searchStore.selectedMatch?.columnStart === item.match.columnStart}
              onclick={() => handleMatchClick(item.file.path, item.match)}
              aria-label={`Line ${item.match.line}: ${item.match.lineContent.trim()}`}
              tabindex="-1"
            >
              <span class="line-number">{item.match.line}</span>
              <span class="line-content">
                {@html highlightMatch(item.match.lineContent, item.match)}
              </span>
            </button>
          {/if}
        {/snippet}
      </VirtualList>
    {:else if searchStore.query.trim() && !searchStore.searching && wasCancelled}
      <div class="no-results">
        <p>Search cancelled — try again or narrow with include/exclude.</p>
      </div>
    {:else if searchStore.query.trim() && !searchStore.searching}
      <div class="no-results">
        <p>No results found for "{searchStore.query}"</p>
      </div>
    {:else}
      <div class="search-placeholder">
        <p>Enter a search term to find in workspace</p>
      </div>
    {/if}
  </div>
</div>


<style>
  .search-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .search-inputs {
    padding: 8px 8px 4px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .search-row {
    display: flex;
    gap: 4px;
    align-items: flex-start;
  }

  .expand-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 26px;
    margin-top: 1px;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .expand-toggle:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .expand-toggle.active {
    color: var(--color-accent);
  }

  .input-fields {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .input-wrapper {
    display: flex;
    align-items: center;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    overflow: hidden;
  }

  .input-wrapper:focus-within {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent);
  }

  .search-input {
    flex: 1;
    padding: 5px 8px;
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: 13px;
    outline: none;
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--color-text-disabled);
  }

  .search-options {
    display: flex;
    gap: 4px;
    padding: 2px 0;
  }

  .option-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 22px;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .option-btn:hover {
    background: var(--color-hover);
    border-color: var(--color-text-secondary);
  }

  .option-btn.active {
    background: var(--color-accent);
    color: var(--color-bg);
    border-color: var(--color-accent);
  }

  .option-icon {
    font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
    font-size: 11px;
    line-height: 1;
  }

  .option-icon.whole-word {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .replace-wrapper {
    margin-top: 0;
  }

  .replace-actions {
    display: flex;
    gap: 4px;
    padding: 2px 0;
  }

  .replace-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 22px;
    color: var(--color-text-secondary);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .replace-btn:hover:not(:disabled) {
    background: var(--color-hover);
    border-color: var(--color-text-secondary);
  }

  .replace-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .filter-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 0 4px 26px;
    font-size: 11px;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .filter-toggle:hover {
    color: var(--color-text);
  }

  .filter-inputs {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
    padding-left: 26px;
  }

  .filter-input {
    padding: 4px 8px;
    font-size: 12px;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    outline: none;
  }

  .filter-input:focus {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent);
  }

  .filter-input::placeholder {
    color: var(--color-text-disabled);
  }

  .search-results {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .search-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    color: var(--color-text-secondary);
    font-size: 13px;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .results-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-header);
    flex-shrink: 0;
  }

  .results-count {
    flex: 1;
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .truncated-warning {
    font-size: 11px;
    color: var(--color-warning);
  }

  .results-actions {
    display: flex;
    gap: 2px;
  }

  .engine-badge {
    font-size: 10px;
    line-height: 1;
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 3px 8px;
    white-space: nowrap;
  }

  .engine-badge.warning {
    color: var(--color-warning);
    border-color: var(--color-warning);
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .file-header-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .file-header-row:hover {
    background: var(--color-hover);
  }

  .file-header-row:hover .replace-file-btn {
    opacity: 1;
  }

  .file-header {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    height: 100%;
    padding: 0 8px;
    font-size: 13px;
    color: var(--color-text);
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }

  .file-name {
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .file-path {
    flex: 1;
    color: var(--color-text-secondary);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .match-count {
    padding: 1px 6px;
    font-size: 10px;
    color: var(--color-text-secondary);
    background: var(--color-bg);
    border-radius: 10px;
    flex-shrink: 0;
  }

  .replace-file-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    margin-right: 4px;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease;
    flex-shrink: 0;
  }

  .replace-file-btn:hover {
    background: var(--color-active);
    color: var(--color-text);
  }

  .match-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 0 8px 0 24px;
    font-size: 12px;
    font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
    color: var(--color-text);
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }

  .match-item:hover {
    background: var(--color-hover);
  }

  .match-item.selected {
    background: var(--color-active);
  }

  .match-item.focused,
  .file-header-row.focused {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .line-number {
    flex-shrink: 0;
    width: 40px;
    color: var(--color-text-secondary);
    text-align: right;
  }

  .line-content {
    flex: 1;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.search-highlight) {
    background: var(--color-warning);
    color: var(--color-bg);
    border-radius: 2px;
    padding: 0 2px;
  }

  .no-results,
  .search-placeholder {
    padding: 20px;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 13px;
  }
</style>
