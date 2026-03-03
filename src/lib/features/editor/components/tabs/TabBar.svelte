<script lang="ts">
  import { tick } from 'svelte';
  import Tab from './Tab.svelte';
  import { editorStore, type OpenFile } from '$features/editor/stores/editor.svelte';
  import { projectStore } from '$shared/stores/project.svelte';
  import { uiStore } from '$shared/stores/ui.svelte';
  import { triggerImmediateAutoSave } from '$features/editor/services/auto-save';
  import { showToast } from '$shared/stores/toast.svelte';
  import { UIIcon } from '$shared/components/ui';

  let tabsContainer: HTMLDivElement | undefined = $state();

  // Context menu state
  let contextOpen = $state(false);
  let contextX = $state(0);
  let contextY = $state(0);
  let contextFile = $state<OpenFile | null>(null);

  function handleSelect(path: string) {
    // Trigger auto-save before switching tabs
    triggerImmediateAutoSave();
    editorStore.setActiveFile(path);
  }

  function handleClose(path: string) {
    editorStore.closeFile(path);
  }

  function handleWheel(e: WheelEvent) {
    // Enable horizontal scrolling with mouse wheel
    if (tabsContainer && e.deltaY !== 0) {
      e.preventDefault();
      tabsContainer.scrollLeft += e.deltaY;
    }
  }

  function handleContextMenu(file: OpenFile, e: MouseEvent) {
    contextFile = file;
    contextX = e.clientX;
    contextY = e.clientY;
    contextOpen = true;
  }

  function closeContextMenu() {
    contextOpen = false;
    contextFile = null;
  }

  function handleWindowClick() {
    if (contextOpen) closeContextMenu();
  }

  // Context menu actions
  function closeTab() {
    if (contextFile) {
      editorStore.closeFile(contextFile.path);
    }
    closeContextMenu();
  }

  function closeOthers() {
    if (contextFile) {
      const pathToKeep = contextFile.path;
      const pathsToClose = editorStore.openFiles
        .filter(f => f.path !== pathToKeep)
        .map(f => f.path);
      for (const path of pathsToClose) {
        editorStore.closeFile(path);
      }
    }
    closeContextMenu();
  }

  function closeToTheRight() {
    if (contextFile) {
      const idx = editorStore.openFiles.findIndex(f => f.path === contextFile!.path);
      if (idx >= 0) {
        const pathsToClose = editorStore.openFiles
          .slice(idx + 1)
          .map(f => f.path);
        for (const path of pathsToClose) {
          editorStore.closeFile(path);
        }
      }
    }
    closeContextMenu();
  }

  function closeAll() {
    editorStore.closeAllFiles(true);
    closeContextMenu();
  }

  function closeSaved() {
    const pathsToClose = editorStore.openFiles
      .filter(f => !editorStore.isDirty(f.path))
      .map(f => f.path);
    for (const path of pathsToClose) {
      editorStore.closeFile(path);
    }
    closeContextMenu();
  }

  async function copyPath() {
    if (contextFile) {
      await navigator.clipboard.writeText(contextFile.path);
      showToast({ message: 'Path copied to clipboard', type: 'success' });
    }
    closeContextMenu();
  }

  async function copyRelativePath() {
    if (contextFile) {
      // Get relative path from project root
      let relativePath = contextFile.path;
      if (projectStore.rootPath) {
        const root = projectStore.rootPath.replace(/\\/g, '/');
        const full = contextFile.path.replace(/\\/g, '/');
        if (full.startsWith(root)) {
          relativePath = full.slice(root.length);
          if (relativePath.startsWith('/')) relativePath = relativePath.slice(1);
        }
      }
      await navigator.clipboard.writeText(relativePath);
      showToast({ message: 'Relative path copied', type: 'success' });
    }
    closeContextMenu();
  }

  function togglePin() {
    if (contextFile) {
      editorStore.togglePin(contextFile.path);
    }
    closeContextMenu();
  }

  async function revealInFileExplorer() {
    const filePath = contextFile?.path;
    closeContextMenu();
    if (filePath) {
      try {
        const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
        await revealItemInDir(filePath);
      } catch {
        showToast({ message: 'Failed to reveal in file explorer', type: 'error' });
      }
    }
  }

  async function revealInExplorerView() {
    const filePath = contextFile?.path;
    closeContextMenu();
    if (filePath) {
      // Force open sidebar with explorer panel
      uiStore.sidebarOpen = true;
      uiStore.activeSidebarPanel = 'explorer';
      // Emit a custom event that FileTree can listen to
      window.dispatchEvent(new CustomEvent('reveal-file', { detail: { path: filePath } }));
    }
  }

  // Drag and drop state
  let draggedIndex = $state<number | null>(null);
  let dropTargetIndex = $state<number | null>(null);

  function handleDragStart(index: number, e: DragEvent) {
    draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
  }

  function handleDragOver(index: number, e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    dropTargetIndex = index;
  }

  function handleDragLeave() {
    dropTargetIndex = null;
  }

  function handleDrop(index: number, e: DragEvent) {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== index) {
      editorStore.reorderTabs(draggedIndex, index);
    }
    draggedIndex = null;
    dropTargetIndex = null;
  }

  function handleDragEnd() {
    draggedIndex = null;
    dropTargetIndex = null;
  }

  $effect(() => {
    // Keep active tab visible when switching/opening.
    void (async () => {
      await tick();
      const el = tabsContainer?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    })();
  });
</script>

<svelte:window onclick={handleWindowClick} />

<div class="tab-bar no-select" role="tablist" aria-label="Open editors">
  {#if editorStore.openFiles.length === 0}
    <span class="tab-placeholder">No files open</span>
  {:else}
    <div
      class="tabs-container"
      bind:this={tabsContainer}
      onwheel={handleWheel}
    >
      {#each editorStore.openFiles as file, index (file.path)}
        <Tab
          {file}
          isActive={editorStore.activeFilePath === file.path}
          isDirty={editorStore.isDirty(file.path)}
          isPinned={file.pinned ?? false}
          isDropTarget={dropTargetIndex === index && draggedIndex !== index}
          onSelect={() => handleSelect(file.path)}
          onClose={() => handleClose(file.path)}
          onContextMenu={handleContextMenu}
          onDragStart={(e) => handleDragStart(index, e)}
          onDragOver={(e) => handleDragOver(index, e)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(index, e)}
          onDragEnd={handleDragEnd}
        />
      {/each}
    </div>
  {/if}
</div>

{#if contextOpen && contextFile}
  <div
    class="context-menu"
    style="left: {contextX}px; top: {contextY}px"
    role="menu"
  >
    <button class="context-item" role="menuitem" onclick={closeTab}>
      <UIIcon name="close" size={16} />
      <span>Close</span>
    </button>
    <button class="context-item" role="menuitem" onclick={closeOthers}>
      <UIIcon name="close" size={16} />
      <span>Close Others</span>
    </button>
    <button class="context-item" role="menuitem" onclick={closeToTheRight}>
      <UIIcon name="close" size={16} />
      <span>Close to the Right</span>
    </button>
    <button class="context-item" role="menuitem" onclick={closeSaved}>
      <UIIcon name="close" size={16} />
      <span>Close Saved</span>
      <span class="shortcut">Ctrl+K U</span>
    </button>
    <button class="context-item" role="menuitem" onclick={closeAll}>
      <UIIcon name="close" size={16} />
      <span>Close All</span>
      <span class="shortcut">Ctrl+K W</span>
    </button>
    <div class="context-divider"></div>
    <button class="context-item" role="menuitem" onclick={copyPath}>
      <UIIcon name="copy" size={16} />
      <span>Copy Path</span>
      <span class="shortcut">Shift+Alt+C</span>
    </button>
    <button class="context-item" role="menuitem" onclick={copyRelativePath}>
      <UIIcon name="copy" size={16} />
      <span>Copy Relative Path</span>
    </button>
    <div class="context-divider"></div>
    <button class="context-item" role="menuitem" onclick={revealInFileExplorer}>
      <UIIcon name="folder-open" size={16} />
      <span>Reveal in File Explorer</span>
      <span class="shortcut">Shift+Alt+R</span>
    </button>
    <button class="context-item" role="menuitem" onclick={revealInExplorerView}>
      <UIIcon name="files" size={16} />
      <span>Reveal in Explorer View</span>
    </button>
    <div class="context-divider"></div>
    <button class="context-item" role="menuitem" onclick={togglePin}>
      <UIIcon name="pin" size={16} />
      <span>{contextFile?.pinned ? 'Unpin' : 'Pin'}</span>
    </button>
  </div>
{/if}

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    height: 34px;
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
    overflow: hidden;
  }

  .tab-placeholder {
    color: var(--color-text-secondary);
    font-size: 13px;
    font-style: italic;
    padding: 0 12px;
  }

  .tabs-container {
    display: flex;
    height: 100%;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--color-border) transparent;
  }

  .tabs-container::-webkit-scrollbar {
    height: 4px;
  }

  .tabs-container::-webkit-scrollbar-track {
    background: transparent;
  }

  .tabs-container::-webkit-scrollbar-thumb {
    background: var(--color-border);
    border-radius: 2px;
  }

  .tabs-container::-webkit-scrollbar-thumb:hover {
    background: var(--color-text-disabled);
  }

  /* Context menu */
  .context-menu {
    position: fixed;
    z-index: 1000;
    min-width: 180px;
    background: var(--color-bg-elevated, var(--color-bg-panel));
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
    padding: 4px 0;
  }

  .context-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    font-size: 13px;
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .context-item:hover {
    background: var(--color-hover);
  }

  .context-item .shortcut {
    margin-left: auto;
    font-size: 11px;
    color: var(--color-text-secondary);
    opacity: 0.7;
  }

  .context-divider {
    height: 1px;
    background: var(--color-border);
    margin: 4px 0;
  }
</style>
