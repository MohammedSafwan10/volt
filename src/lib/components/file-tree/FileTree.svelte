<script lang="ts">
  import { onMount } from "svelte";
  import { dirname, join } from "@tauri-apps/api/path";
  import { projectStore, type TreeNode } from "$lib/stores/project.svelte";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { showToast } from "$lib/stores/toast.svelte";
  import { ConfirmModal, UIIcon } from "$lib/components/ui";
  import {
    openFolderDialog,
    createFile,
    createDirectory,
    deletePath,
    renamePath,
    getFileInfo,
  } from "$lib/services/file-system";
  import { pauseWatching, resumeWatching } from "$lib/services/file-watch";
  import FileTreeItem from "./FileTreeItem.svelte";

  interface Props {
    onFileSelect?: (path: string) => void;
  }

  let { onFileSelect }: Props = $props();

  // Listen for reveal-file events from tab context menu
  onMount(() => {
    function handleRevealFile(e: Event) {
      const customEvent = e as CustomEvent<{ path: string }>;
      const filePath = customEvent.detail?.path;
      if (filePath) {
        void revealFileInTree(filePath);
      }
    }

    window.addEventListener("reveal-file", handleRevealFile);
    return () => window.removeEventListener("reveal-file", handleRevealFile);
  });

  /**
   * Reveal a file in the tree by expanding all parent folders and selecting it
   */
  async function revealFileInTree(filePath: string): Promise<void> {
    if (!projectStore.rootPath) return;

    // Normalize paths for comparison
    const normalizedFilePath = filePath.replace(/\\/g, "/");
    const normalizedRoot = projectStore.rootPath.replace(/\\/g, "/");

    // Check if file is within project
    if (!normalizedFilePath.startsWith(normalizedRoot)) return;

    // Get the relative path parts
    const relativePath = normalizedFilePath.slice(normalizedRoot.length);
    const parts = relativePath.split("/").filter(Boolean);

    // Build up the path and expand each folder
    let currentPath = projectStore.rootPath;

    for (let i = 0; i < parts.length - 1; i++) {
      // Use proper path joining
      currentPath = await joinPath(currentPath, parts[i]);
      const node = projectStore.findNode(currentPath);

      if (node && node.isDir && !node.expanded) {
        await projectStore.toggleFolder(node);
      }
    }

    // Select the file
    projectStore.selectItem(filePath);

    // Scroll to the selected item after a tick
    setTimeout(() => {
      scrollToSelectedItem();
    }, 50);
  }

  function scrollToSelectedItem(): void {
    if (!scrollEl || !projectStore.selectedPath) return;

    // Find the index of the selected item in flatNodes
    const selectedIndex = flatNodes.findIndex(
      (item) => item.node.path === projectStore.selectedPath,
    );

    if (selectedIndex >= 0) {
      const targetTop = TOP_PADDING + selectedIndex * ROW_HEIGHT;
      const viewportTop = scrollEl.scrollTop;
      const viewportBottom = viewportTop + scrollEl.clientHeight;

      // Scroll if not in view
      if (targetTop < viewportTop || targetTop + ROW_HEIGHT > viewportBottom) {
        scrollEl.scrollTop =
          targetTop - scrollEl.clientHeight / 2 + ROW_HEIGHT / 2;
      }
    }
  }

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

  type InlineEditState =
    | {
        mode: "rename";
        targetPath: string;
        value: string;
      }
    | {
        mode: "newFile" | "newFolder";
        parentPath: string;
        draftPath: string;
        value: string;
      };

  let inlineEdit = $state<InlineEditState | null>(null);
  let inlineEditCommitting = $state(false);
  let inlineEditFocusNonce = $state(0);

  let confirmOpen = $state(false);
  let confirmTitle = $state("");
  let confirmMessage = $state("");
  let confirmConfirmLabel = $state("Confirm");
  let confirmDanger = $state(false);
  let confirmResolver = $state<((ok: boolean) => void) | null>(null);

  // Drag and drop state
  let draggedNode = $state<TreeNode | null>(null);
  let dropTarget = $state<{
    path: string;
    position: "inside" | "before" | "after";
  } | null>(null);
  let dragScrollInterval: ReturnType<typeof setInterval> | null = null;
  let lastDragY = 0;
  let lastSelectedIndex = $state(-1);

  function handleItemSelect(
    node: TreeNode,
    e: MouseEvent | KeyboardEvent,
  ): void {
    const currentIndex = flatNodes.findIndex((n) => n.node.path === node.path);

    if (e.shiftKey && lastSelectedIndex !== -1) {
      const start = Math.min(lastSelectedIndex, currentIndex);
      const end = Math.max(lastSelectedIndex, currentIndex);
      const range = flatNodes
        .slice(start, end + 1)
        .filter((n) => !n.node.path.startsWith("__draft__:"))
        .map((n) => n.node.path);
      projectStore.selectRange(range);
    } else if (e.ctrlKey || e.metaKey) {
      projectStore.toggleSelection(node.path);
      lastSelectedIndex = currentIndex;
    } else {
      projectStore.selectItem(node.path);
      lastSelectedIndex = currentIndex;

      if (!node.isDir) {
        onFileSelect?.(node.path);
      }
    }
  }

  function handleGlobalKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      // Only select all if not currently renaming/creating
      if (inlineEdit) return;

      e.preventDefault();
      const allPaths = flatNodes
        .filter((n) => !n.node.path.startsWith("__draft__:"))
        .map((n) => n.node.path);
      projectStore.selectAll(allPaths);
    }
  }

  // Auto-scroll configuration
  const SCROLL_EDGE_SIZE = 40; // pixels from edge to trigger scroll
  const SCROLL_SPEED = 8; // pixels per frame

  function makeDraftNode(
    state: Extract<InlineEditState, { mode: "newFile" | "newFolder" }>,
  ): TreeNode {
    return {
      name: state.value,
      path: state.draftPath,
      isDir: state.mode === "newFolder",
      isFile: state.mode === "newFile",
      isSymlink: false,
      size: 0,
      modified: null,
      children: state.mode === "newFolder" ? null : [],
      expanded: false,
      loading: false,
    };
  }

  function flatten(
    nodes: TreeNode[],
    depth = 0,
    out: FlatNode[] = [],
    edit: InlineEditState | null,
  ): FlatNode[] {
    for (const node of nodes) {
      out.push({ node, depth });

      if (node.isDir && node.expanded) {
        if (edit && edit.mode !== "rename" && edit.parentPath === node.path) {
          out.push({ node: makeDraftNode(edit), depth: depth + 1 });
        }
        if (Array.isArray(node.children) && node.children.length > 0) {
          flatten(node.children, depth + 1, out, edit);
        }
      }
    }
    return out;
  }

  const flatNodes = $derived.by(() => {
    const out: FlatNode[] = [];
    const edit = inlineEdit;

    if (
      edit &&
      edit.mode !== "rename" &&
      projectStore.rootPath &&
      edit.parentPath === projectStore.rootPath
    ) {
      out.push({ node: makeDraftNode(edit), depth: 0 });
    }

    return flatten(projectStore.tree, 0, out, edit);
  });

  const totalHeight = $derived.by(
    () => TOP_PADDING + BOTTOM_PADDING + flatNodes.length * ROW_HEIGHT,
  );

  const startIndex = $derived.by(() =>
    Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN),
  );
  const endIndex = $derived.by(() => {
    // When the panel is first shown, clientHeight can be 0 for a tick.
    const effectiveViewportHeight = Math.max(viewportHeight, 200);
    return Math.min(
      flatNodes.length,
      Math.ceil((scrollTop + effectiveViewportHeight) / ROW_HEIGHT) + OVERSCAN,
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
    if (e.target.closest("[data-tree-row]")) return;
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
    if (!projectStore.selectedPaths.has(node.path)) {
      projectStore.selectItem(node.path);
    }

    contextMenuX = e.clientX;
    contextMenuY = e.clientY;
    contextNode = node;
    contextOpen = true;
  }

  function cancelInlineEdit(): void {
    if (inlineEdit && inlineEdit.mode !== "rename") {
      // Keep selection sensible if the draft row was selected
      if (projectStore.selectedPath === inlineEdit.draftPath) {
        projectStore.selectItem(inlineEdit.parentPath);
      }
    }

    inlineEdit = null;
    inlineEditCommitting = false;
  }

  function requestConfirm(opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }): Promise<boolean> {
    confirmTitle = opts.title;
    confirmMessage = opts.message;
    confirmConfirmLabel = opts.confirmLabel ?? "Confirm";
    confirmDanger = Boolean(opts.danger);
    confirmOpen = true;

    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function handleConfirmCancel(): void {
    confirmOpen = false;
    confirmResolver?.(false);
    confirmResolver = null;
  }

  function handleConfirmConfirm(): void {
    confirmOpen = false;
    confirmResolver?.(true);
    confirmResolver = null;
  }

  async function joinPath(parent: string, name: string): Promise<string> {
    try {
      return await join(parent, name);
    } catch {
      const sep = parent.includes("\\") ? "\\" : "/";
      return parent.endsWith(sep)
        ? `${parent}${name}`
        : `${parent}${sep}${name}`;
    }
  }

  async function beginCreate(
    mode: "newFile" | "newFolder",
    parentDir: TreeNode | null,
  ): Promise<void> {
    closeContextMenu();
    const parentPath = parentDir?.path ?? projectStore.rootPath;
    if (!parentPath) return;

    if (parentDir) {
      projectStore.selectItem(parentDir.path);
      if (!parentDir.expanded) {
        await projectStore.toggleFolder(parentDir);
      }
      if (parentDir.children === null) {
        await projectStore.refreshFolder(parentDir);
        parentDir.expanded = true;
      }
    }

    const draftPath = `__draft__:${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    inlineEdit = {
      mode,
      parentPath,
      draftPath,
      value: "",
    };
    projectStore.selectItem(draftPath);
    inlineEditFocusNonce++;
  }

  function beginRename(node: TreeNode): void {
    closeContextMenu();
    inlineEdit = {
      mode: "rename",
      targetPath: node.path,
      value: node.name,
    };
    projectStore.selectItem(node.path);
    inlineEditFocusNonce++;
  }

  async function commitInlineEdit(): Promise<void> {
    if (inlineEditCommitting) return;
    const edit = inlineEdit;
    if (!edit) return;

    const name = edit.value.trim();
    if (!name) {
      cancelInlineEdit();
      return;
    }

    inlineEditCommitting = true;
    try {
      if (edit.mode === "rename") {
        const node = projectStore.findNode(edit.targetPath);
        if (!node) {
          cancelInlineEdit();
          return;
        }

        if (name === node.name) {
          cancelInlineEdit();
          return;
        }

        let parent: string;
        try {
          parent = await dirname(node.path);
        } catch {
          const normalized = node.path.replace(/\\/g, "/");
          parent = normalized.slice(0, normalized.lastIndexOf("/"));
        }

        const newPath = await joinPath(parent, name);
        const ok = await renamePath(node.path, newPath);
        if (!ok) {
          inlineEditFocusNonce++;
          return;
        }

        projectStore.updateNodePath(node.path, newPath, name);
        projectStore.selectItem(newPath);
        showToast({ message: "Renamed successfully", type: "success" });
        inlineEdit = null;
        return;
      }

      const newPath = await joinPath(edit.parentPath, name);
      const ok =
        edit.mode === "newFile"
          ? await createFile(newPath)
          : await createDirectory(newPath);
      if (!ok) {
        inlineEditFocusNonce++;
        return;
      }

      const info = await getFileInfo(newPath);
      if (!info) {
        inlineEditFocusNonce++;
        return;
      }

      const entry = {
        name: info.name,
        path: info.path,
        isDir: info.isDir,
        isFile: info.isFile,
        isSymlink: info.isSymlink,
        size: info.size,
        modified: info.modified,
      };

      const parentDir = projectStore.findNode(edit.parentPath);
      if (parentDir && parentDir.isDir) {
        parentDir.expanded = true;
        if (Array.isArray(parentDir.children)) {
          projectStore.addNode(parentDir.path, entry);
        } else {
          await projectStore.refreshFolder(parentDir);
        }
      } else if (projectStore.rootPath) {
        projectStore.addNode(projectStore.rootPath, entry);
      }

      projectStore.selectItem(newPath);
      inlineEdit = null;
    } finally {
      inlineEditCommitting = false;
    }
  }

  // Drag and drop handlers
  function handleDragStart(node: TreeNode): void {
    draggedNode = node;
    startDragScroll();
  }

  function handleDragEnd(): void {
    draggedNode = null;
    dropTarget = null;
    stopDragScroll();
  }

  function handleGlobalDrag(e: DragEvent): void {
    lastDragY = e.clientY;
  }

  function startDragScroll(): void {
    if (dragScrollInterval) return;

    // Listen globally for drag position - this works even outside the container
    window.addEventListener("dragover", handleGlobalDrag);

    dragScrollInterval = setInterval(() => {
      if (!scrollEl || !draggedNode) return;

      const rect = scrollEl.getBoundingClientRect();
      const relativeY = lastDragY - rect.top;

      // Scroll up when near top edge OR above the container
      if (relativeY < SCROLL_EDGE_SIZE) {
        const intensity = relativeY < 0 ? 1 : 1 - relativeY / SCROLL_EDGE_SIZE;
        scrollEl.scrollTop -= SCROLL_SPEED * Math.min(intensity, 1);
      }
      // Scroll down when near bottom edge OR below the container
      else if (relativeY > rect.height - SCROLL_EDGE_SIZE) {
        const intensity =
          relativeY > rect.height
            ? 1
            : 1 - (rect.height - relativeY) / SCROLL_EDGE_SIZE;
        scrollEl.scrollTop += SCROLL_SPEED * Math.min(intensity, 1);
      }
    }, 16); // ~60fps
  }

  function stopDragScroll(): void {
    window.removeEventListener("dragover", handleGlobalDrag);
    if (dragScrollInterval) {
      clearInterval(dragScrollInterval);
      dragScrollInterval = null;
    }
  }

  function handleContainerDragOver(e: DragEvent): void {
    // Track mouse Y position for auto-scroll (backup for when global doesn't fire)
    lastDragY = e.clientY;
  }

  function isDescendantOf(childPath: string, parentPath: string): boolean {
    const normalizedChild = childPath.replace(/\\/g, "/");
    const normalizedParent = parentPath.replace(/\\/g, "/");
    return normalizedChild.startsWith(normalizedParent + "/");
  }

  function handleDragOver(targetNode: TreeNode, e: DragEvent): void {
    if (!draggedNode) return;

    // Can't drop on self
    if (draggedNode.path === targetNode.path) {
      dropTarget = null;
      return;
    }

    // Can't drop folder into its own descendant
    if (
      draggedNode.isDir &&
      isDescendantOf(targetNode.path, draggedNode.path)
    ) {
      dropTarget = null;
      return;
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const height = rect.height;

    if (targetNode.isDir) {
      // For folders: top 25% = before, middle 50% = inside, bottom 25% = after
      if (y < height * 0.25) {
        dropTarget = { path: targetNode.path, position: "before" };
      } else if (y > height * 0.75) {
        dropTarget = { path: targetNode.path, position: "after" };
      } else {
        dropTarget = { path: targetNode.path, position: "inside" };
      }
    } else {
      // For files: top 50% = before, bottom 50% = after
      if (y < height * 0.5) {
        dropTarget = { path: targetNode.path, position: "before" };
      } else {
        dropTarget = { path: targetNode.path, position: "after" };
      }
    }
  }

  function handleDragLeave(targetNode: TreeNode, e: DragEvent): void {
    // Only clear if we're actually leaving this element (not entering a child)
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    const currentTarget = e.currentTarget as HTMLElement;
    if (!relatedTarget || !currentTarget.contains(relatedTarget)) {
      if (dropTarget?.path === targetNode.path) {
        dropTarget = null;
      }
    }
  }

  async function handleDrop(targetNode: TreeNode): Promise<void> {
    if (!draggedNode || !dropTarget) {
      handleDragEnd();
      return;
    }

    const sourceNode = draggedNode;
    const sourcePath = sourceNode.path;
    const target = dropTarget;

    // Clear drag state immediately for responsive UI
    handleDragEnd();

    // Determine destination folder
    let destFolder: string;
    if (target.position === "inside" && targetNode.isDir) {
      destFolder = targetNode.path;
    } else {
      // Move to same parent as target
      try {
        destFolder = await dirname(targetNode.path);
      } catch {
        const normalized = targetNode.path.replace(/\\/g, "/");
        destFolder = normalized.slice(0, normalized.lastIndexOf("/"));
      }
    }

    // Build new path
    const newPath = await joinPath(destFolder, sourceNode.name);

    // Check if destination is same as source (no-op)
    const normalizedNew = newPath.replace(/\\/g, "/");
    const normalizedSource = sourcePath.replace(/\\/g, "/");
    if (normalizedNew === normalizedSource) {
      return; // No-op, same location
    }

    // Check if destination already exists (and it's not the source itself)
    const existingNode = projectStore.findNode(newPath);
    if (existingNode && existingNode.path !== sourcePath) {
      showToast({
        message: `"${sourceNode.name}" already exists in destination`,
        type: "error",
      });
      return;
    }

    // Close any open files from the source path to release Windows file handles
    // This prevents PermissionDenied errors when moving folders/files
    const filesToClose: string[] = [];
    if (sourceNode.isDir) {
      // For folders, close all files inside the folder
      for (const f of editorStore.openFiles) {
        const normalizedFilePath = f.path.replace(/\\/g, "/");
        if (normalizedFilePath.startsWith(normalizedSource + "/")) {
          filesToClose.push(f.path);
        }
      }
    } else {
      // For single files, check if this exact file is open
      const openFile = editorStore.openFiles.find(
        (f) => f.path.replace(/\\/g, "/") === normalizedSource,
      );
      if (openFile) {
        filesToClose.push(openFile.path);
      }
    }

    // Close files (force close to avoid unsaved changes prompts during move)
    for (const filePath of filesToClose) {
      editorStore.closeFile(filePath, true);
    }

    // Pause file watcher to release handles on Windows
    await pauseWatching();

    // Small delay to let OS release handles
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Execute move
    const ok = await renamePath(sourcePath, newPath);

    // Resume file watcher
    await resumeWatching();

    if (!ok) {
      return; // Error already shown by renamePath
    }

    // Remove from old location first
    projectStore.removeNode(sourcePath);

    // Refresh destination folder to show the moved item
    // This is safer than manually adding to avoid duplicate key issues
    const destNode = projectStore.findNode(destFolder);
    if (destNode && destNode.isDir && destNode.expanded) {
      await projectStore.refreshFolder(destNode);
    } else if (destFolder === projectStore.rootPath) {
      // Moving to root - refresh tree
      await projectStore.refreshTree();
    }
    // If dest folder is collapsed, it will load when expanded

    projectStore.selectItem(newPath);
    showToast({ message: "Moved successfully", type: "success" });
  }

  async function handleDelete(node: TreeNode): Promise<void> {
    closeContextMenu();

    const confirmed = await requestConfirm({
      title: "Delete",
      message: `Delete "${node.name}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;

    const ok = await deletePath(node.path);
    if (ok) {
      projectStore.removeNode(node.path);
    }
  }
</script>

<svelte:window onclick={handleWindowClick} />

<div
  class="file-tree"
  role="tree"
  aria-label="File explorer"
  onkeydown={handleGlobalKeydown}
  tabindex="0"
>
  {#if projectStore.loading}
    <div class="loading">
      <span class="loading-icon"><UIIcon name="spinner" size={16} /></span>
      <span>Loading...</span>
    </div>
  {:else if !projectStore.rootPath}
    <div class="empty-state">
      <p>No folder open</p>
      <button class="open-folder-btn" onclick={handleOpenFolder}>
        <UIIcon name="folder-open" size={16} />
        <span>Open Folder</span>
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
          onclick={() => void beginCreate("newFile", null)}
          aria-label="New File"
          type="button"
        >
          <UIIcon name="file-plus" size={16} />
        </button>
        <button
          class="toolbar-btn"
          title="New Folder"
          onclick={() => void beginCreate("newFolder", null)}
          aria-label="New Folder"
          type="button"
        >
          <UIIcon name="folder-plus" size={16} />
        </button>
        <button
          class="toolbar-btn"
          title="Refresh"
          onclick={() => void handleRefresh()}
          aria-label="Refresh"
          type="button"
        >
          <UIIcon name="refresh" size={16} />
        </button>
      </div>
    </div>

    <div
      class="tree-content"
      role="group"
      bind:this={scrollEl}
      onscroll={handleScroll}
      oncontextmenu={handleEmptyContextMenu}
      ondragover={handleContainerDragOver}
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
              onSelect={handleItemSelect}
              onContextMenu={handleNodeContextMenu}
              isEditing={Boolean(
                inlineEdit &&
                  ((inlineEdit.mode === "rename" &&
                    inlineEdit.targetPath === item.node.path) ||
                    (inlineEdit.mode !== "rename" &&
                      inlineEdit.draftPath === item.node.path)),
              )}
              editValue={inlineEdit?.value ?? ""}
              editPlaceholder={inlineEdit?.mode === "newFolder"
                ? "Folder name"
                : inlineEdit?.mode === "newFile"
                  ? "File name"
                  : undefined}
              editFocusNonce={inlineEditFocusNonce}
              onEditValueChange={(value) => {
                if (inlineEdit) inlineEdit.value = value;
              }}
              onEditCommit={() => void commitInlineEdit()}
              onEditCancel={cancelInlineEdit}
              isDragging={draggedNode?.path === item.node.path}
              dropPosition={dropTarget?.path === item.node.path
                ? dropTarget.position
                : null}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={(node) => void handleDrop(node)}
              onDragEnd={handleDragEnd}
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
        onclick={() => void beginCreate("newFile", contextNode)}
      >
        <UIIcon name="file-plus" size={16} />
        <span>New File</span>
      </button>
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void beginCreate("newFolder", contextNode)}
      >
        <UIIcon name="folder-plus" size={16} />
        <span>New Folder</span>
      </button>
      <div class="context-divider"></div>
    {:else if contextNode === null}
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void beginCreate("newFile", null)}
      >
        <UIIcon name="file-plus" size={16} />
        <span>New File</span>
      </button>
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void beginCreate("newFolder", null)}
      >
        <UIIcon name="folder-plus" size={16} />
        <span>New Folder</span>
      </button>
      <div class="context-divider"></div>
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => void handleRefresh()}
      >
        <UIIcon name="refresh" size={16} />
        <span>Refresh</span>
      </button>
    {/if}

    {#if contextNode}
      <button
        class="context-item"
        role="menuitem"
        type="button"
        onclick={() => contextNode && beginRename(contextNode)}
      >
        <UIIcon name="pencil" size={16} />
        <span>Rename</span>
      </button>
      <button
        class="context-item danger"
        role="menuitem"
        type="button"
        onclick={() => contextNode && void handleDelete(contextNode)}
      >
        <UIIcon name="trash" size={16} />
        <span>Delete</span>
      </button>
    {/if}
  </div>
{/if}

<ConfirmModal
  open={confirmOpen}
  title={confirmTitle}
  message={confirmMessage}
  confirmLabel={confirmConfirmLabel}
  danger={confirmDanger}
  onCancel={handleConfirmCancel}
  onConfirm={handleConfirmConfirm}
/>

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
    display: grid;
    place-items: center;
    animation: spin 0.8s linear infinite;
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
    padding: 6px 8px;
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
