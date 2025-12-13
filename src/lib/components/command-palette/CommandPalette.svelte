<script lang="ts">
  import { uiStore } from '$lib/stores/ui.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { openFileDialog, openFolderDialog, writeFile } from '$lib/services/file-system';
  import { formatBeforeSave, formatCurrentDocument, isPrettierFile } from '$lib/services/prettier';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import {
    type Command,
    type CommandWithMeta,
    registerCommands,
    searchCommands,
    addToRecent,
    getRecentCommandIds
  } from './commands';

  let isOpen = $state(false);
  let searchQuery = $state('');
  let selectedIndex = $state(0);
  let inputElement: HTMLInputElement | undefined = $state();

  const allCommands: Command[] = [
    {
      id: 'file.newFile',
      label: 'New File',
      category: 'File',
      shortcut: 'Ctrl+N',
      action: () => { showToast({ message: 'New File - Coming soon', type: 'info' }); }
    },
    {
      id: 'file.openFile',
      label: 'Open File...',
      category: 'File',
      shortcut: 'Ctrl+O',
      action: async () => {
        const path = await openFileDialog();
        if (path) await editorStore.openFile(path);
      }
    },
    {
      id: 'file.openFolder',
      label: 'Open Folder...',
      category: 'File',
      shortcut: 'Ctrl+K Ctrl+O',
      action: async () => {
        const path = await openFolderDialog();
        if (path) {
          const success = await projectStore.openProject(path);
          if (success) uiStore.setActiveSidebarPanel('explorer');
        }
      }
    },
    {
      id: 'file.save',
      label: 'Save',
      category: 'File',
      shortcut: 'Ctrl+S',
      action: async () => {
        const activeFile = editorStore.activeFile;
        if (!activeFile) {
          showToast({ message: 'No file to save', type: 'warning' });
          return;
        }
        let contentToSave = activeFile.content;
        try {
          const { getModelValue, setModelValue } = await import('$lib/services/monaco-models');
          const modelValue = getModelValue(activeFile.path);
          if (typeof modelValue === 'string') {
            contentToSave = modelValue;
          }

          if (settingsStore.formatOnSaveEnabled && isPrettierFile(activeFile.path)) {
            const formatted = await formatBeforeSave(contentToSave, activeFile.path);
            if (formatted !== contentToSave) {
              contentToSave = formatted;
              setModelValue(activeFile.path, formatted);
            }
          }

          editorStore.updateContent(activeFile.path, contentToSave);
        } catch { /* ignore */ }
        const success = await writeFile(activeFile.path, contentToSave);
        if (success) editorStore.markSaved(activeFile.path);
      },
      enabled: () => editorStore.activeFile !== null
    },
    {
      id: 'file.closeEditor',
      label: 'Close Editor',
      category: 'File',
      shortcut: 'Ctrl+W',
      action: () => {
        if (editorStore.activeFilePath) editorStore.closeFile(editorStore.activeFilePath);
      },
      enabled: () => editorStore.activeFilePath !== null
    },
    {
      id: 'file.closeFolder',
      label: 'Close Folder',
      category: 'File',
      action: () => {
        projectStore.closeProject();
        editorStore.closeAllFiles(true);
      },
      enabled: () => projectStore.rootPath !== null
    },
    {
      id: 'file.toggleAutoSave',
      label: 'Toggle Auto Save',
      category: 'File',
      action: () => {
        settingsStore.toggleAutoSave();
        showToast({
          message: `Auto-save ${settingsStore.autoSaveEnabled ? 'enabled' : 'disabled'}`,
          type: 'info'
        });
      }
    },
    {
      id: 'edit.formatDocument',
      label: 'Format Document',
      category: 'Edit',
      shortcut: 'Ctrl+Shift+I',
      action: async () => {
        await formatCurrentDocument();
      },
      enabled: () => {
        const activeFile = editorStore.activeFile;
        return activeFile !== null && isPrettierFile(activeFile.path);
      }
    },
    {
      id: 'edit.toggleFormatOnSave',
      label: 'Toggle Format on Save',
      category: 'Edit',
      action: () => {
        settingsStore.toggleFormatOnSave();
        showToast({
          message: `Format on save ${settingsStore.formatOnSaveEnabled ? 'enabled' : 'disabled'}`,
          type: 'info'
        });
      }
    },
    {
      id: 'file.exit',
      label: 'Exit',
      category: 'File',
      shortcut: 'Alt+F4',
      action: async () => {
        const appWindow = getCurrentWindow();
        await appWindow.close();
      }
    },

    {
      id: 'view.toggleSidebar',
      label: 'Toggle Sidebar',
      category: 'View',
      shortcut: 'Ctrl+B',
      action: () => uiStore.toggleSidebar()
    },
    {
      id: 'view.explorer',
      label: 'Show Explorer',
      category: 'View',
      shortcut: 'Ctrl+Shift+E',
      action: () => uiStore.setActiveSidebarPanel('explorer')
    },
    {
      id: 'view.toggleTerminal',
      label: 'Toggle Terminal',
      category: 'View',
      shortcut: 'Ctrl+`',
      action: () => uiStore.toggleBottomPanel()
    },
    {
      id: 'view.zoomIn',
      label: 'Zoom In',
      category: 'View',
      shortcut: 'Ctrl+Plus',
      action: () => uiStore.zoomIn()
    },
    {
      id: 'view.zoomOut',
      label: 'Zoom Out',
      category: 'View',
      shortcut: 'Ctrl+Minus',
      action: () => uiStore.zoomOut()
    },
    {
      id: 'view.resetZoom',
      label: 'Reset Zoom',
      category: 'View',
      shortcut: 'Ctrl+0',
      action: () => uiStore.resetZoom()
    },
    {
      id: 'terminal.new',
      label: 'New Terminal',
      category: 'Terminal',
      shortcut: 'Ctrl+`',
      action: () => {
        uiStore.bottomPanelOpen = true;
        showToast({ message: 'Terminal opened', type: 'info' });
      }
    },
    {
      id: 'help.about',
      label: 'About Volt',
      category: 'Help',
      action: () => uiStore.openAboutModal()
    },
    {
      id: 'developer.reloadWindow',
      label: 'Developer: Reload Window',
      category: 'View',
      action: () => {
        if (typeof window !== 'undefined') window.location.reload();
      }
    }
  ];

  registerCommands(allCommands);

  let prevSearchQuery = $state('');
  let filteredCommands = $derived(searchCommands(searchQuery));
  let hasRecentCommands = $derived(!searchQuery.trim() && getRecentCommandIds().length > 0);

  function getOtherCommandsStartIndex(): number {
    if (!hasRecentCommands) return -1;
    return filteredCommands.filter((c) => c.isRecent).length;
  }

  $effect.pre(() => {
    if (searchQuery !== prevSearchQuery) {
      prevSearchQuery = searchQuery;
      selectedIndex = 0;
    }
  });

  export function open(): void {
    isOpen = true;
    searchQuery = '';
    selectedIndex = 0;
    setTimeout(() => inputElement?.focus(), 0);
  }

  export function close(): void {
    isOpen = false;
    searchQuery = '';
    selectedIndex = 0;
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
      console.error('Command execution failed:', err);
      showToast({ message: 'Command failed', type: 'error' });
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (!isOpen) return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (filteredCommands.length > 0) {
          selectedIndex = (selectedIndex + 1) % filteredCommands.length;
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (filteredCommands.length > 0) {
          selectedIndex = selectedIndex <= 0 ? filteredCommands.length - 1 : selectedIndex - 1;
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          executeCommand(filteredCommands[selectedIndex]);
        }
        break;
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) close();
  }

  function scrollIntoView(node: HTMLElement, isSelected: boolean): { update: (s: boolean) => void } {
    function update(s: boolean) {
      if (s) node.scrollIntoView({ block: 'nearest' });
    }
    update(isSelected);
    return { update };
  }

  function formatShortcut(shortcut: string): string[] {
    return shortcut.split('+').map((k) => k.trim());
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="command-palette-backdrop" role="presentation" onclick={handleBackdropClick}>
    <div class="command-palette" role="dialog" aria-label="Command Palette">
      <div class="search-container">
        <span class="search-prefix">&gt;</span>
        <input
          bind:this={inputElement}
          bind:value={searchQuery}
          type="text"
          class="search-input"
          placeholder=""
          aria-label="Search commands"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div class="commands-list" role="listbox">
        {#if filteredCommands.length === 0}
          <div class="no-results">No commands found</div>
        {:else}
          {#each filteredCommands as command, index (command.id)}
            {#if hasRecentCommands && index === getOtherCommandsStartIndex() && !command.isRecent}
              <div class="section-divider">
                <span class="section-label">other commands</span>
              </div>
            {/if}
            <button
              class="command-item"
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
                  <span class="command-tag">recently used</span>
                {/if}
              </div>
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
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .command-palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    padding-top: 8vh;
    z-index: 9999;
  }

  .command-palette {
    width: 100%;
    max-width: 680px;
    max-height: 480px;
    background: var(--color-bg-sidebar);
    border: 1px solid var(--color-accent);
    border-radius: 8px;
    box-shadow: 0 0 0 1px var(--color-accent), 0 8px 32px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .search-container {
    display: flex;
    align-items: center;
    padding: 0 16px;
    border-bottom: 1px solid var(--color-border);
    gap: 8px;
  }

  .search-prefix {
    font-size: 14px;
    color: var(--color-text-secondary);
    font-family: monospace;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    color: var(--color-text);
    padding: 12px 0;
    font-family: inherit;
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .commands-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }

  .no-results {
    padding: 16px;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: 13px;
  }

  .section-divider {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px 4px;
  }

  .section-divider::before {
    content: '';
    flex: 0 0 auto;
    width: 0;
  }

  .section-label {
    font-size: 11px;
    color: var(--color-text-secondary);
    text-transform: lowercase;
  }

  .command-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 6px 16px;
    cursor: pointer;
    transition: background-color 0.1s ease;
    text-align: left;
    gap: 16px;
  }

  .command-item:hover,
  .command-item.selected {
    background: var(--color-hover);
  }

  .command-item.selected {
    background: rgba(137, 180, 250, 0.15);
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

  .command-tag {
    font-size: 11px;
    color: var(--color-accent);
    flex-shrink: 0;
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
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }

  .key-sep {
    font-size: 11px;
    color: var(--color-text-disabled);
  }
</style>
