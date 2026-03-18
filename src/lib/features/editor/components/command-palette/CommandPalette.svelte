<script lang="ts">
  import { uiStore } from "$shared/stores/ui.svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { projectStore } from "$shared/stores/project.svelte";
  import { settingsStore } from "$shared/stores/settings.svelte";
  import { themeStore } from "$shared/stores/theme.svelte";
  import { showToast } from "$shared/stores/toast.svelte";
  import { UIIcon, VirtualList } from "$shared/components/ui";
  import { FileIcon } from "$features/editor/components/file-tree";
  import {
    openFileDialog,
    openFolderDialog,
    writeFile,
  } from "$core/services/file-system";
  import {
    formatBeforeSave,
    formatCurrentDocument,
    isPrettierFile,
  } from "$core/services/prettier";
  import { getModelValue, setModelValue } from "$core/services/monaco-models";
  import {
    indexProject,
    indexUpdateTick,
    searchFiles,
    searchFilesAsync,
    cancelAsyncSearch,
    isIndexing,
    getIndexStatus,
    type IndexedFile,
  } from "$core/services/file-index";
  import { exit } from "@tauri-apps/plugin-process";
  import {
    type Command,
    type CommandWithMeta,
    registerCommands,
    searchCommands,
    addToRecent,
    getRecentCommandIds,
  } from "./commands";

  interface Props {
    onClose?: () => void;
  }

  let { onClose }: Props = $props();

  type PaletteMode = "file" | "command";

  // Debounce delay for file search (ms)
  const FILE_SEARCH_DEBOUNCE_MS = 50;

  let isOpen = $state(false);
  let mode = $state<PaletteMode>("file");
  let searchQuery = $state("");
  let selectedIndex = $state(0);
  let inputElement: HTMLInputElement | undefined = $state();

  // Debounce timer for file search
  let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;

  // File search results
  let fileResults = $state<IndexedFile[]>([]);

  // Virtualized file results list
  let fileList: { ensureVisible: (index: number) => void } | null =
    $state(null);
  const FILE_ROW_HEIGHT = 32;
  const FILE_OVERSCAN = 5;

  // Get recently opened file paths
  const recentFilePaths = $derived(editorStore.openFiles.map((f) => f.path));

  // Derive if we're in command mode (query starts with >)
  const effectiveMode = $derived.by(() => {
    if (mode === "command") return "command";
    if (searchQuery.startsWith(">")) return "command";
    return "file";
  });

  // Get the actual search query (strip > prefix for commands)
  const effectiveQuery = $derived.by(() => {
    if (effectiveMode === "command" && searchQuery.startsWith(">")) {
      return searchQuery.slice(1).trim();
    }
    return searchQuery;
  });

  const allCommands: Command[] = [
    {
      id: "file.newFile",
      label: "New File",
      category: "File",
      shortcut: "Ctrl+N",
      action: () => {
        showToast({ message: "New File - Coming soon", type: "info" });
      },
    },
    {
      id: "file.openFile",
      label: "Open File...",
      category: "File",
      shortcut: "Ctrl+O",
      action: async () => {
        const path = await openFileDialog();
        if (path) await editorStore.openFile(path);
      },
    },
    {
      id: "file.openFolder",
      label: "Open Folder...",
      category: "File",
      shortcut: "Ctrl+K Ctrl+O",
      action: async () => {
        const path = await openFolderDialog();
        if (path) {
          const success = await projectStore.openProject(path);
          if (success) uiStore.setActiveSidebarPanel("explorer");
        }
      },
    },
    {
      id: "file.save",
      label: "Save",
      category: "File",
      shortcut: "Ctrl+S",
      action: async () => {
        const activeFile = editorStore.activeFile;
        if (!activeFile) {
          showToast({ message: "No file to save", type: "warning" });
          return;
        }
        let contentToSave = activeFile.content;
        const modelValue = getModelValue(activeFile.path);
        if (typeof modelValue === "string") {
          contentToSave = modelValue;
        }

        if (
          settingsStore.formatOnSaveEnabled &&
          isPrettierFile(activeFile.path)
        ) {
          const formatted = await formatBeforeSave(
            contentToSave,
            activeFile.path,
          );
          if (formatted !== contentToSave) {
            contentToSave = formatted;
            setModelValue(activeFile.path, formatted);
          }
        }
        editorStore.updateContent(activeFile.path, contentToSave);
        const success = await writeFile(activeFile.path, contentToSave);
        if (success) editorStore.markSaved(activeFile.path);
      },
      enabled: () => editorStore.activeFile !== null,
    },
    {
      id: "file.closeEditor",
      label: "Close Editor",
      category: "File",
      shortcut: "Ctrl+W",
      action: () => {
        if (editorStore.activeFilePath)
          editorStore.closeFile(editorStore.activeFilePath);
      },
      enabled: () => editorStore.activeFilePath !== null,
    },
    {
      id: "file.closeFolder",
      label: "Close Folder",
      category: "File",
      action: async () => {
        await projectStore.closeProject();
      },
      enabled: () => projectStore.rootPath !== null,
    },
    {
      id: "file.toggleAutoSave",
      label: "Toggle Auto Save",
      category: "File",
      action: () => {
        settingsStore.toggleAutoSave();
        showToast({
          message: `Auto-save ${settingsStore.autoSaveEnabled ? "enabled" : "disabled"}`,
          type: "info",
        });
      },
    },
    {
      id: "edit.formatDocument",
      label: "Format Document",
      category: "Edit",
      shortcut: "Ctrl+Shift+I",
      action: async () => {
        await formatCurrentDocument();
      },
      enabled: () => {
        const activeFile = editorStore.activeFile;
        return activeFile !== null && isPrettierFile(activeFile.path);
      },
    },
    {
      id: "edit.toggleFormatOnSave",
      label: "Toggle Format on Save",
      category: "Edit",
      action: () => {
        settingsStore.toggleFormatOnSave();
        showToast({
          message: `Format on save ${settingsStore.formatOnSaveEnabled ? "enabled" : "disabled"}`,
          type: "info",
        });
      },
    },
    {
      id: "file.exit",
      label: "Exit",
      category: "File",
      shortcut: "Alt+F4",
      action: async () => {
        await exit(0);
      },
    },
    {
      id: "view.toggleSidebar",
      label: "Toggle Sidebar",
      category: "View",
      shortcut: "Ctrl+B",
      action: () => uiStore.toggleSidebar(),
    },
    {
      id: "view.explorer",
      label: "Show Explorer",
      category: "View",
      shortcut: "Ctrl+Shift+E",
      action: () => uiStore.setActiveSidebarPanel("explorer"),
    },
    {
      id: "view.search",
      label: "Search: Find in Files",
      category: "View",
      shortcut: "Ctrl+Shift+F",
      action: () => uiStore.setActiveSidebarPanel("search"),
    },
    {
      id: "view.toggleTerminal",
      label: "Toggle Terminal",
      category: "View",
      shortcut: "Ctrl+`",
      action: () => uiStore.toggleBottomPanel(),
    },
    {
      id: "view.zoomIn",
      label: "Zoom In",
      category: "View",
      shortcut: "Ctrl+Plus",
      action: () => uiStore.zoomIn(),
    },
    {
      id: "view.zoomOut",
      label: "Zoom Out",
      category: "View",
      shortcut: "Ctrl+Minus",
      action: () => uiStore.zoomOut(),
    },
    {
      id: "view.resetZoom",
      label: "Reset Zoom",
      category: "View",
      shortcut: "Ctrl+0",
      action: () => uiStore.resetZoom(),
    },
    {
      id: "terminal.new",
      label: "New Terminal",
      category: "Terminal",
      action: () => {
        uiStore.openBottomPanelTab("terminal");
      },
    },
    {
      id: "help.about",
      label: "About Volt",
      category: "Help",
      action: () => uiStore.openAboutModal(),
    },
    {
      id: "developer.reloadWindow",
      label: "Developer: Reload Window",
      category: "View",
      action: () => {
        if (typeof window !== "undefined") window.location.reload();
      },
    },
    {
      id: "view.theme.darkmodern",
      label: "Preferences: Color Theme - Dark Modern",
      category: "View",
      action: () => {
        themeStore.setMode("dark-modern");
      },
    },
    {
      id: "view.theme.dark",
      label: "Preferences: Color Theme - Dark",
      category: "View",
      action: () => {
        themeStore.setMode("dark");
        showToast({ message: "Theme set to Dark", type: "info" });
      },
    },
    {
      id: "view.theme.midnight",
      label: "Preferences: Color Theme - Midnight",
      category: "View",
      action: () => {
        themeStore.setMode("midnight");
        showToast({ message: "Theme set to Midnight", type: "info" });
      },
    },
    {
      id: "view.theme.light",
      label: "Preferences: Color Theme - Light",
      category: "View",
      action: () => {
        themeStore.setMode("light");
        showToast({ message: "Theme set to Light", type: "info" });
      },
    },
    {
      id: "view.theme.solarized-dark",
      label: "Preferences: Color Theme - Solarized Dark",
      category: "View",
      action: () => {
        themeStore.setMode("solarized-dark");
        showToast({ message: "Theme set to Solarized Dark", type: "info" });
      },
    },
    {
      id: "view.theme.toggle",
      label: "Preferences: Toggle Color Theme",
      category: "View",
      action: () => {
        themeStore.toggle();
        showToast({
          message: `Theme: ${themeStore.displayName}`,
          type: "info",
        });
      },
    },
    {
      id: "preferences.openSettings",
      label: "Preferences: Open Settings",
      category: "View",
      action: () => {
        editorStore.openSettingsTab();
      },
    },
    {
      id: "go.goToSymbolInFile",
      label: "Go to Symbol in File...",
      category: "Go",
      shortcut: "Ctrl+Shift+O",
      action: () => {
        // Dispatch event to open symbol picker in file mode
        window.dispatchEvent(
          new CustomEvent("volt:open-symbol-picker", {
            detail: { mode: "file" },
          }),
        );
      },
      enabled: () => editorStore.activeFile !== null,
    },
    {
      id: "go.goToSymbolInWorkspace",
      label: "Go to Symbol in Workspace...",
      category: "Go",
      shortcut: "Ctrl+T",
      action: () => {
        // Dispatch event to open symbol picker in workspace mode
        window.dispatchEvent(
          new CustomEvent("volt:open-symbol-picker", {
            detail: { mode: "workspace" },
          }),
        );
      },
      enabled: () => projectStore.rootPath !== null,
    },
    {
      id: "go.goToLine",
      label: "Go to Line...",
      category: "Go",
      shortcut: "Ctrl+G",
      action: () => {
        // Dispatch event to open go to line dialog
        window.dispatchEvent(new CustomEvent("volt:open-go-to-line"));
      },
      enabled: () => editorStore.activeFile !== null,
    },
  ];

  registerCommands(allCommands);

  // Command search results
  const filteredCommands = $derived(searchCommands(effectiveQuery));
  const hasRecentCommands = $derived(
    !effectiveQuery.trim() && getRecentCommandIds().length > 0,
  );

  function getOtherCommandsStartIndex(): number {
    if (!hasRecentCommands) return -1;
    return filteredCommands.filter((c) => c.isRecent).length;
  }

  // Update file results when query changes (with debouncing for performance)
  $effect(() => {
    if (!isOpen) {
      return;
    }
    if (effectiveMode === "file" && projectStore.rootPath) {
      // Track index updates to refresh results as chunks stream in
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      void $indexUpdateTick;
      const query = effectiveQuery;
      const recent = recentFilePaths;

      // Clear any pending search
      if (fileSearchTimer) {
        clearTimeout(fileSearchTimer);
        fileSearchTimer = null;
      }

      // Cancel any in-flight async search
      cancelAsyncSearch();

      // For empty query or very short queries, search immediately (no debounce)
      // This makes the initial state feel snappy
      if (query.length <= 1) {
        void (async () => {
          const results = await searchFiles(query, recent);
          fileResults = results;
        })();
        return;
      }

      // Debounce longer queries to avoid work on every keystroke
      // Use async search to prevent UI jank on large indexes
      fileSearchTimer = setTimeout(() => {
        fileSearchTimer = null;
        void (async () => {
          const results = await searchFilesAsync(query, recent);
          // Only update if not cancelled (returns null if cancelled)
          if (results !== null) {
            fileResults = results;
          }
        })();
      }, FILE_SEARCH_DEBOUNCE_MS);
    }
  });

  // Cleanup debounce timer when component closes
  $effect(() => {
    if (!isOpen && fileSearchTimer) {
      clearTimeout(fileSearchTimer);
      fileSearchTimer = null;
    }
  });

  // Reset selected index when query changes
  let prevQuery = $state("");
  $effect.pre(() => {
    if (searchQuery !== prevQuery) {
      prevQuery = searchQuery;
      selectedIndex = 0;
    }
  });

  // Index project when it changes
  $effect(() => {
    if (projectStore.rootPath) {
      void indexProject(projectStore.rootPath);
    }
  });

  // Get total result count for current mode
  const resultCount = $derived(
    effectiveMode === "file" ? fileResults.length : filteredCommands.length,
  );

  export function open(initialMode: PaletteMode = "file"): void {
    isOpen = true;
    mode = initialMode;
    searchQuery = initialMode === "command" ? ">" : "";
    selectedIndex = 0;
    setTimeout(() => inputElement?.focus(), 0);
  }

  export function openFileMode(): void {
    open("file");
  }

  export function openCommandMode(): void {
    open("command");
  }

  export function close(): void {
    isOpen = false;
    searchQuery = "";
    selectedIndex = 0;
    mode = "file";
    onClose?.();
  }

  export function toggle(): void {
    if (isOpen) close();
    else open();
  }

  function executeCommand(command: CommandWithMeta): void {
    addToRecent(command.id);
    close();
    try {
      void command.action();
    } catch (err) {
      showToast({ message: "Command failed", type: "error" });
    }
  }

  async function openFile(file: IndexedFile): Promise<void> {
    close();
    await editorStore.openFile(file.path);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (!isOpen) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        if (resultCount > 0) {
          selectedIndex = (selectedIndex + 1) % resultCount;
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (resultCount > 0) {
          selectedIndex =
            selectedIndex <= 0 ? resultCount - 1 : selectedIndex - 1;
        }
        break;
      case "Enter":
        e.preventDefault();
        if (effectiveMode === "file") {
          if (fileResults[selectedIndex]) {
            void openFile(fileResults[selectedIndex]);
          }
        } else {
          if (filteredCommands[selectedIndex]) {
            executeCommand(filteredCommands[selectedIndex]);
          }
        }
        break;
      case "Backspace":
        // If query is just ">", switch back to file mode
        if (searchQuery === ">") {
          e.preventDefault();
          searchQuery = "";
          mode = "file";
        }
        break;
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) close();
  }

  function scrollIntoView(
    node: HTMLElement,
    isSelected: boolean,
  ): { update: (s: boolean) => void } {
    function update(s: boolean) {
      if (s) node.scrollIntoView({ block: "nearest" });
    }
    update(isSelected);
    return { update };
  }

  function formatShortcut(shortcut: string): string[] {
    return shortcut.split("+").map((k) => k.trim());
  }

  function getPlaceholder(): string {
    if (effectiveMode === "command") {
      return "Type a command";
    }
    return "Search files by name (type > for commands)";
  }

  function isRecentFile(file: IndexedFile): boolean {
    return recentFilePaths.includes(file.path);
  }

  // Ensure selected item is visible in virtualized list
  $effect(() => {
    if (!fileList || !isOpen || effectiveMode !== "file") return;
    if (selectedIndex < 0 || selectedIndex >= fileResults.length) return;
    fileList.ensureVisible(selectedIndex);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="command-palette-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
  >
    <div
      class="command-palette"
      role="dialog"
      aria-label={effectiveMode === "file" ? "Quick Open" : "Command Palette"}
    >
      <div class="search-container">
        <span class="search-icon" aria-hidden="true">
          <UIIcon name="search" size={16} />
        </span>
        <input
          bind:this={inputElement}
          bind:value={searchQuery}
          type="text"
          class="search-input"
          placeholder={getPlaceholder()}
          aria-label={effectiveMode === "file"
            ? "Search files"
            : "Search commands"}
          autocomplete="off"
          spellcheck="false"
        />
        <div class="search-hint" aria-hidden="true">
          <kbd class="key">Esc</kbd>
        </div>
      </div>

      <div class="results-list" role="listbox">
        {#if effectiveMode === "file"}
          <!-- File search results -->
          {#if !projectStore.rootPath}
            <div class="no-results">Open a folder to search files</div>
          {:else if isIndexing() && fileResults.length === 0}
            {@const status = getIndexStatus()}
            <div class="no-results">
              <span class="spinner"></span>
              {#if status.progress.total > 0}
                Indexing files... ({status.progress.current.toLocaleString()} / {status.progress.total.toLocaleString()})
              {:else}
                Indexing files...
              {/if}
            </div>
          {:else if fileResults.length === 0}
            <div class="no-results">No files found</div>
          {:else}
            <!-- Virtualized file results -->
            <div class="virtual-results-wrapper">
              <VirtualList
                bind:this={fileList}
                items={fileResults}
                rowHeight={FILE_ROW_HEIGHT}
                overscan={FILE_OVERSCAN}
                getKey={(file: IndexedFile) => file.path}
              >
                {#snippet children({ item: file, index, style })}
                  <button
                    class="result-item"
                    class:selected={index === selectedIndex}
                    {style}
                    onclick={() => void openFile(file)}
                    onmouseenter={() => (selectedIndex = index)}
                    role="option"
                    aria-selected={index === selectedIndex}
                  >
                    <span class="file-icon">
                      <FileIcon name={file.name} />
                    </span>
                    <div class="file-info">
                      <span class="file-name">{file.name}</span>
                      <span class="file-path">{file.parentDir}</span>
                    </div>
                    {#if isRecentFile(file)}
                      <span class="result-tag">open</span>
                    {/if}
                  </button>
                {/snippet}
              </VirtualList>

              {#if isIndexing()}
                {@const status = getIndexStatus()}
                <div class="indexing-indicator">
                  <span class="spinner"></span>
                  {#if status.progress.total > 0}
                    Indexing... {Math.round(
                      (status.progress.current / status.progress.total) * 100,
                    )}%
                  {:else}
                    Indexing...
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {:else}
          <!-- Command search results -->
          {#if filteredCommands.length === 0}
            <div class="no-results">No commands found</div>
          {:else}
            <div class="command-results-container">
              {#each filteredCommands as command, index (command.id)}
                {#if hasRecentCommands && index === getOtherCommandsStartIndex() && !command.isRecent}
                  <div class="section-divider">
                    <span class="section-label">other commands</span>
                  </div>
                {/if}
                <button
                  class="result-item command-item"
                  class:selected={index === selectedIndex}
                  onclick={() => executeCommand(command)}
                  onmouseenter={() => (selectedIndex = index)}
                  role="option"
                  aria-selected={index === selectedIndex}
                  use:scrollIntoView={index === selectedIndex}
                >
                  <div class="command-info">
                    <span class="command-label">{command.label}</span>
                    {#if hasRecentCommands && command.isRecent && index === 0}
                      <span class="result-tag">recently used</span>
                    {/if}
                  </div>
                  <div class="command-meta">
                    <span class="command-category">{command.category}</span>
                    {#if command.shortcut}
                      <div class="command-shortcut">
                        {#each formatShortcut(command.shortcut) as key, i}
                          <kbd class="key">{key}</kbd>
                          {#if i < formatShortcut(command.shortcut).length - 1}
                            <span class="key-sep">+</span>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .command-palette-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--color-bg) 40%, transparent);
    backdrop-filter: blur(6px);
    display: flex;
    justify-content: center;
    padding-top: 8vh;
    z-index: 9999;
  }

  .command-palette {
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
    border-bottom: 1px solid
      color-mix(in srgb, var(--color-border) 85%, transparent);
    gap: 10px;
    background: color-mix(
      in srgb,
      var(--color-bg-elevated, var(--color-bg-sidebar)) 85%,
      var(--color-surface0)
    );
  }

  .search-container:focus-within {
    box-shadow: inset 0 0 0 1px
      color-mix(in srgb, var(--color-accent) 55%, transparent);
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
    overflow: hidden;
    padding: 6px 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .command-results-container {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
  }

  /* Virtualized file results container */
  .virtual-results-wrapper {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .no-results {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 13px;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .indexing-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--color-text-secondary);
    background: color-mix(in srgb, var(--color-surface0) 50%, transparent);
    border-top: 1px solid
      color-mix(in srgb, var(--color-border) 50%, transparent);
  }

  .indexing-indicator .spinner {
    width: 12px;
    height: 12px;
    border-width: 1.5px;
  }

  .section-divider {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px 4px;
  }

  .section-divider::before {
    content: "";
    height: 1px;
    flex: 1;
    background: color-mix(in srgb, var(--color-border) 70%, transparent);
  }

  .section-label {
    font-size: 11px;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.4px;
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

  /* File result styles */
  .file-icon {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }

  .file-info {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .file-name {
    font-size: 13px;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-path {
    font-size: 12px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .result-tag {
    font-size: 11px;
    color: var(--color-text);
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
    padding: 2px 8px;
    border-radius: 999px;
    flex-shrink: 0;
  }

  /* Command result styles */
  .command-item {
    justify-content: space-between;
    gap: 16px;
  }

  .command-info {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    flex: 1;
  }

  .command-label {
    font-size: 13px;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .command-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .command-category {
    font-size: 11px;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.35px;
  }

  .command-shortcut {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
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

  .key-sep {
    font-size: 11px;
    color: var(--color-text-disabled);
  }
</style>
