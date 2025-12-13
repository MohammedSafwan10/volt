<script lang="ts">
  import { dirname, join } from '@tauri-apps/api/path';
  import { projectStore, type TreeNode } from '$lib/stores/project.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    openFolderDialog,
    createFile,
    createDirectory,
    deletePath,
    renamePath,
    getFileInfo
  } from '$lib/services/file-system';
  import FileTreeItem from './FileTreeItem.svelte';

  interface Props {
    onFileSelect?: (path: string) => void;
  }

  let { onFileSelect }: Props = $props();

  type FlatNode = { node: TreeNode; depth: number };

  const ROW_HEIGHT = 24;
  const OVERSCAN = 10;
  const TOP_PADDING = 4;
  const BOTTOM_PADDING = 4;

  let scrollEl: HTMLDivElement | null = $state(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  // Context menu state
  let contextOpen = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);
  let contextNode = $state<TreeNode | null>(null); // null => empty area context menu

  function flatten(nodes: TreeNode[], depth = 0, out: FlatNode[] = []): FlatNode[] {
    for (const node of nodes) {
      out.push({ node, depth });
      if (node.isDir && node.expanded && Array.isArray(node.children) && node.children.length > 0) {
        flatten(node.children, depth + 1, out);
      }
    }
    return out;
  }

  const flatNodes = $derived.by(() => flatten(projectStore.tree));

  const totalHeight = $derived.by(
    () => TOP_PADDING + BOTTOM_PADDING + flatNodes.length * ROW_HEIGHT
  );

  const startIndex = $derived.by(() => Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const endIndex = $derived.by(() => {
    // When the panel is first shown, clientHeight can be 0 for a tick.
    const effectiveViewportHeight = Math.max(viewportHeight, 200);
    return Math.min(
      flatNodes.length,
      Math.ceil((scrollTop + effectiveViewportHeight) / ROW_HEIGHT) + OVERSCAN
    );
  });
  const visibleNodes = $derived.by(() => flatNodes.slice(startIndex, endIndex));

  function handleScroll(): void {
    if (!scrollEl) return;
    scrollTop = scrollEl.scrollTop;
  }

  $effect(() => {
    if (!scrollEl) return;

    viewportHeight = scrollEl.clientHeight;
    const ro = new ResizeObserver(() => {
      if (!scrollEl) return;
      viewportHeight = scrollEl.clientHeight;
    });
    ro.observe(scrollEl);

    return () => ro.disconnect();
  });

  async function handleOpenFolder(): Promise<void> {
    const path = await openFolderDialog();
    if (path) {
      await projectStore.openProject(path);
    }
  }

  async function handleRefresh(): Promise<void> {
    await projectStore.refreshTree();
    showToast({ message: 'Refreshed', type: 'success', duration: 2000 });
  }

  function closeContextMenu(): void {
    contextOpen = false;
    contextNode = null;
  }

  function handleWindowClick(): void {
    if (contextOpen) closeContextMenu();
  }

  function handleEmptyContextMenu(e: MouseEvent): void {
    if (!(e.target instanceof HTMLElement)) return;
    if (e.target.closest('[data-tree-row]')) return;
    if (!projectStore.rootPath) return;

    e.preventDefault();
    contextMenuX = e.clientX;
    contextMenuY = e.clientY;
    contextNode = null;
    contextOpen = true;
  }

  function handleNodeContextMenu(node: TreeNode, e: MouseEvent): void {
    if (!projectStore.rootPath) return;
    e.preventDefault();
    e.stopPropagation();
    projectStore.selectItem(node.path);
    contextMenuX = e.clientX;
    contextMenuY = e.clientY;
    contextNode = node;
    contextOpen = true;
  }

  function promptForName(label: string, initialValue = ''): string | null {
    const next = window.prompt(label, initialValue);
    const trimmed = next?.trim();
    return trimmed ? trimmed : null;
  }

  async function joinPath(parent: string, name: string): Promise<string> {
    try {
      return await join(parent, name);
    } catch {
      const sep = parent.includes('\\') ? '\\' : '/';
      return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
    }
  }

  async function handleNewFile(parentDir: TreeNode | null): Promise<void> {
    closeContextMenu();
    const base = parentDir?.path ?? projectStore.rootPath;
    if (!base) return;

    const name = promptForName('New file name');
    if (!name) return;

    const newPath = await joinPath(base, name);
    const ok = await createFile(newPath);
    if (!ok) return;

    const info = await getFileInfo(newPath);
    if (!info) return;

    const entry = {
      name: info.name,
      path: info.path,
      isDir: info.isDir,
      isFile: info.isFile,
      isSymlink: info.isSymlink,
      size: info.size,
      modified: info.modified
    };

    if (parentDir) {
      parentDir.expanded = true;
      if (Array.isArray(parentDir.children)) {
        projectStore.addNode(parentDir.path, entry);
      } else {
        await projectStore.refreshFolder(parentDir);
      }
    } else if (projectStore.rootPath) {
      projectStore.addNode(projectStore.rootPath, entry);
    }
  }

  async function handleNewFolder(parentDir: TreeNode | null): Promise<void> {
    closeContextMenu();
    const base = parentDir?.path ?? projectStore.rootPath;
    if (!base) return;

    const name = promptForName('New folder name');
    if (!name) return;

    const newPath = await joinPath(base, name);
    const ok = await createDirectory(newPath);
    if (!ok) return;

    const info = await getFileInfo(newPath);
    if (!info) return;

    const entry = {
      name: info.name,
      path: info.path,
      isDir: info.isDir,
      isFile: info.isFile,
      isSymlink: info.isSymlink,
      size: info.size,
      modified: info.modified
    };

    if (parentDir) {
      parentDir.expanded = true;
      if (Array.isArray(parentDir.children)) {
        projectStore.addNode(parentDir.path, entry);
      } else {
        await projectStore.refreshFolder(parentDir);
      }
    } else if (projectStore.rootPath) {
      projectStore.addNode(projectStore.rootPath, entry);
    }
  }

  async function handleRename(node: TreeNode): Promise<void> {
    closeContextMenu();

    const newName = promptForName('Rename to', node.name);
    if (!newName || newName === node.name) return;

    let parent: string;
    try {
      parent = await dirname(node.path);
    } catch {
      const normalized = node.path.replace(/\\/g, '/');
      parent = normalized.slice(0, normalized.lastIndexOf('/'));
    }

    const newPath = await joinPath(parent, newName);
    const ok = await renamePath(node.path, newPath);
    if (ok) {
      projectStore.updateNodePath(node.path, newPath, newName);
      showToast({ message: 'Renamed successfully', type: 'success' });
    }
  }

  async function handleDelete(node: TreeNode): Promise<void> {
    closeContextMenu();
    const confirmed = confirm(`Delete "${node.name}"?`);
    if (!confirmed) return;

    const ok = await deletePath(node.path);
    if (ok) {
      projectStore.removeNode(node.path);
    }
  }
</script>

<svelte:window onclick={handleWindowClick} />

<div class="file-tree" role="tree" aria-label="File explorer">
  {#if projectStore.loading}
    <div class="loading">
      <span class="loading-icon">⏳</span>
      <span>Loading...</span>
    </div>
  {:else if !projectStore.rootPath}
    <div class="empty-state">
      <p>No folder open</p>
      <button class="open-folder-btn" onclick={handleOpenFolder}>
        📁 Open Folder
      </button>
    </div>
  {:else}
    <div class="toolbar">
      <span class="project-name" title={projectStore.rootPath}>
        {projectStore.projectName}
      </span>
      <div class="toolbar-actions">
        <button
          class="toolbar-btn"
          title="New File"
          onclick={() => void handleNewFile(null)}
          aria-label="New File"
          type="button"
        >
          📄
        </button>
        <button
          class="toolbar-btn"
          title="New Folder"
          onclick={() => void handleNewFolder(null)}
          aria-label="New Folder"
          type="button"
        >
          📁
        </button>
        <button
          class="toolbar-btn"
          title="Refresh"
          onclick={() => void handleRefresh()}
          aria-label="Refresh"
          type="button"
        >
          🔄
        </button>
      </div>
    </div>

    <div
      class="tree-content"
      role="group"
      bind:this={scrollEl}
      onscroll={handleScroll}
      oncontextmenu={handleEmptyContextMenu}
    >
      <div class="spacer" style="height: {totalHeight}px">
        {#each visibleNodes as item, idx (item.node.path)}
          <div
            class="row"
            style="top: {TOP_PADDING + (startIndex + idx) * ROW_HEIGHT}px"
          >
            <FileTreeItem
              node={item.node}
              depth={item.depth}
              {onFileSelect}
              onContextMenu={handleNodeContextMenu}
            />
          </div>
        {/each}
      </div>

      {#if projectStore.tree.length === 0}
        <div class="empty-folder">
          <p>This folder is empty</p>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if contextOpen && projectStore.rootPath}
  <div
    class="context-menu"
    style="left: {contextMenuX}px; top: {contextMenuY}px"
    role="menu"
  >
    {#if contextNode?.isDir}
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void handleNewFile(contextNode)}
      >
        📄 New File
      </button>
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void handleNewFolder(contextNode)}
      >
        📁 New Folder
      </button>
      <div class="context-divider"></div>
    {:else if contextNode === null}
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void handleNewFile(null)}
      >
        📄 New File
      </button>
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void handleNewFolder(null)}
      >
        📁 New Folder
      </button>
      <div class="context-divider"></div>
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void handleRefresh()}
      >
        🔄 Refresh
      </button>
    {/if}

    {#if contextNode}
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => contextNode && void handleRename(contextNode)}
      >
        ✏️ Rename
      </button>
      <button
        class="context-item danger"
        role="menuitem"
        type="button"
        onclick={() => contextNode && void handleDelete(contextNode)}
      >
        🗑️ Delete
      </button>
    {/if}
  </div>
{/if}

<style>
  .file-tree {
    display: flex;
    flex-direction: column;
    height: 100%;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--color-text-secondary);
    font-size: 13px;
  }

  .loading-icon {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 12px;
  }

  .empty-state p {
    color: var(--color-text-secondary);
    font-size: 13px;
    margin: 0;
  }

  .open-folder-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    background: var(--color-accent);
    color: var(--color-bg);
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }

  .open-folder-btn:hover {
    opacity: 0.9;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .project-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toolbar-actions {
    display: flex;
    gap: 2px;
  }

  .toolbar-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: var(--color-text-secondary);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.1s ease;
  }

  .toolbar-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .tree-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0;
    position: relative;
  }

  .spacer {
    position: relative;
    width: 100%;
  }

  .row {
    position: absolute;
    left: 0;
    right: 0;
    height: 24px;
  }

  .empty-folder {
    padding: 16px;
    text-align: center;
  }

  .empty-folder p {
    color: var(--color-text-disabled);
    font-size: 12px;
    font-style: italic;
    margin: 0;
  }

  /* Context menu */
  .context-menu {
    position: fixed;
    z-index: 1000;
    min-width: 160px;
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
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

  .context-item.danger:hover {
    background: var(--color-error);
    color: white;
  }

  .context-divider {
    height: 1px;
    background: var(--color-border);
    margin: 4px 0;
  }
</style>
