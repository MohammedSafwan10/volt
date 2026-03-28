<script lang="ts">
  import { projectStore, type TreeNode } from "$shared/stores/project.svelte";
  import { gitStore } from "$features/git/stores/git.svelte";
  import { UIIcon } from "$shared/components/ui";
  import FileIcon from "./FileIcon.svelte";

  interface Props {
    node: TreeNode;
    depth: number;
    stagedIndicator?: {
      state: string;
      title: string;
      className: string;
    } | null;
    onSelect?: (node: TreeNode, e: MouseEvent | KeyboardEvent) => void;
    onContextMenu?: (node: TreeNode, e: MouseEvent) => void;
    isEditing?: boolean;
    editValue?: string;
    editPlaceholder?: string;
    editFocusNonce?: number;
    onEditValueChange?: (value: string) => void;
    onEditCommit?: () => void;
    onEditCancel?: () => void;
    // Drag and drop
    isDragging?: boolean;
    dropPosition?: "inside" | "before" | "after" | null;
    onDragStart?: (node: TreeNode, e: DragEvent) => void;
    onDragOver?: (node: TreeNode, e: DragEvent) => void;
    onDragLeave?: (node: TreeNode, e: DragEvent) => void;
    onDrop?: (node: TreeNode, e: DragEvent) => void;
    onDragEnd?: () => void;
  }

  let {
    node,
    depth,
    stagedIndicator = null,
    onSelect,
    onContextMenu,
    isEditing,
    editValue,
    editPlaceholder,
    editFocusNonce,
    onEditValueChange,
    onEditCommit,
    onEditCancel,
    isDragging = false,
    dropPosition = null,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
  }: Props = $props();

  const isSelected = $derived(projectStore.selectedPaths.has(node.path));
  const indentPx = $derived(depth * 16);
  const isDraftNode = $derived(node.path.startsWith("__draft__:"));

  // Git status for this file/folder (like VSCode M, U, A indicators)
  type GitIndicator = { letter: string; color: string; title: string } | null;

  const gitIndicator = $derived.by((): GitIndicator => {
    if (!gitStore.isRepo || !gitStore.status) return null;

    // Get relative path from workspace root
    const rootPath = projectStore.rootPath;
    if (!rootPath) return null;

    // Normalize paths for comparison
    const nodePath = node.path.replace(/\\/g, "/");
    const normalizedRoot = rootPath.replace(/\\/g, "/");
    const relativePath = nodePath.startsWith(normalizedRoot)
      ? nodePath.slice(normalizedRoot.length + 1)
      : nodePath;

    // Check all git status categories
    const { staged, unstaged, untracked, conflicted } = gitStore.status;

    // For folders, check if any child has changes
    if (node.isDir) {
      const folderPath = relativePath + "/";
      const hasConflict = conflicted.some(
        (f) => f.path.startsWith(folderPath) || f.path === relativePath,
      );
      const hasStaged = staged.some(
        (f) => f.path.startsWith(folderPath) || f.path === relativePath,
      );
      const hasUnstaged = unstaged.some(
        (f) => f.path.startsWith(folderPath) || f.path === relativePath,
      );
      const hasUntracked = untracked.some(
        (f) => f.path.startsWith(folderPath) || f.path === relativePath,
      );

      if (hasConflict)
        return { letter: "!", color: "var(--color-error)", title: "Conflict" };
      if (hasStaged)
        return {
          letter: "●",
          color: "var(--color-success)",
          title: "Staged changes",
        };
      if (hasUnstaged)
        return {
          letter: "M",
          color: "var(--color-warning)",
          title: "Modified",
        };
      if (hasUntracked)
        return {
          letter: "U",
          color: "var(--color-success)",
          title: "Untracked",
        };
      return null;
    }

    // For files, check exact match
    const conflict = conflicted.find((f) => f.path === relativePath);
    if (conflict)
      return { letter: "!", color: "var(--color-error)", title: "Conflict" };

    const stagedFile = staged.find((f) => f.path === relativePath);
    if (stagedFile) {
      if (stagedFile.status === "Added")
        return {
          letter: "A",
          color: "var(--color-success)",
          title: "Added (staged)",
        };
      if (stagedFile.status === "Deleted")
        return {
          letter: "D",
          color: "var(--color-error)",
          title: "Deleted (staged)",
        };
      if (stagedFile.status === "Renamed")
        return {
          letter: "R",
          color: "var(--color-accent)",
          title: "Renamed (staged)",
        };
      return {
        letter: "M",
        color: "var(--color-success)",
        title: "Modified (staged)",
      };
    }

    const unstagedFile = unstaged.find((f) => f.path === relativePath);
    if (unstagedFile) {
      if (unstagedFile.status === "Deleted")
        return { letter: "D", color: "var(--color-error)", title: "Deleted" };
      return { letter: "M", color: "var(--color-warning)", title: "Modified" };
    }

    const untrackedFile = untracked.find((f) => f.path === relativePath);
    if (untrackedFile)
      return { letter: "U", color: "var(--color-success)", title: "Untracked" };

    return null;
  });

  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (!isEditing || !inputEl) return;
    void editFocusNonce;
    inputEl.focus();
    inputEl.select();
  });

  async function handleActivate(e: MouseEvent | KeyboardEvent): Promise<void> {
    onSelect?.(node, e);
    if (node.isDir && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
      await projectStore.toggleFolder(node);
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (isEditing) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void handleActivate(e);
    }
  }

  function handleInputKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      onEditCommit?.();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onEditCancel?.();
    }
  }

  function handleDragStart(e: DragEvent): void {
    if (isEditing || isDraftNode) {
      e.preventDefault();
      return;
    }
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", node.path);
      e.dataTransfer.setData(
        "application/x-volt-tree-node",
        JSON.stringify({
          path: node.path,
          name: node.name,
          isDir: node.isDir,
        }),
      );
    }
    onDragStart?.(node, e);
  }

  function handleDragOver(e: DragEvent): void {
    if (isDraftNode) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    onDragOver?.(node, e);
  }

  function handleDragLeave(e: DragEvent): void {
    e.stopPropagation();
    onDragLeave?.(node, e);
  }

  function handleDrop(e: DragEvent): void {
    if (isDraftNode) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop?.(node, e);
  }

  function handleDragEnd(): void {
    onDragEnd?.();
  }
</script>

<div
  class="tree-item"
  data-tree-row
  class:selected={isSelected}
  class:dragging={isDragging}
  class:drop-inside={dropPosition === "inside"}
  class:drop-before={dropPosition === "before"}
  class:drop-after={dropPosition === "after"}
  style="padding-left: {indentPx + 8}px"
  role="treeitem"
  tabindex="0"
  aria-selected={isSelected}
  aria-expanded={node.isDir ? node.expanded : undefined}
  draggable={!isEditing && !isDraftNode}
  onclick={(e) => {
    if (isEditing) return;
    void handleActivate(e);
  }}
  onkeydown={handleKeydown}
  oncontextmenu={(e) => {
    if (isEditing) return;
    onContextMenu?.(node, e);
  }}
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  ondragend={handleDragEnd}
>
  {#if node.isDir}
    <span class="chevron" aria-hidden="true">
      {#if node.loading}
        <span class="spinner">
          <UIIcon name="spinner" size={14} />
        </span>
      {:else}
        <UIIcon
          name={node.expanded ? "chevron-down" : "chevron-right"}
          size={14}
        />
      {/if}
    </span>
  {:else}
    <span class="chevron-spacer"></span>
  {/if}

  <FileIcon name={node.name} isDir={node.isDir} expanded={node.expanded} />

  {#if isEditing}
    <input
      class="inline-input"
      bind:this={inputEl}
      value={editValue ?? ""}
      placeholder={editPlaceholder}
      oninput={(e) => onEditValueChange?.((e.target as HTMLInputElement).value)}
      onkeydown={handleInputKeydown}
      onblur={() => onEditCommit?.()}
    />
  {:else}
    <span class="name" class:git-modified={gitIndicator} title={node.path}
      >{node.name}</span
    >
    {#if stagedIndicator}
      <span
        class={stagedIndicator.className}
        title={stagedIndicator.title}
      >
        {stagedIndicator.state}
      </span>
    {/if}
    {#if gitIndicator}
      <span
        class="git-indicator"
        style="color: {gitIndicator.color}"
        title={gitIndicator.title}
      >
        {gitIndicator.letter}
      </span>
    {/if}
  {/if}
</div>

<style>
  .tree-item {
    user-select: none;
    display: flex;
    align-items: center;
    height: 24px;
    padding-right: 8px;
    cursor: pointer;
    border-radius: 6px;
    transition: background-color 0.1s ease;
  }

  .tree-item:hover {
    background: var(--color-hover);
  }

  .tree-item:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .tree-item.selected {
    background: var(--color-active);
  }

  .tree-item.dragging {
    opacity: 0.5;
  }

  .tree-item.drop-inside {
    background: color-mix(in srgb, var(--color-accent) 20%, transparent);
    outline: 1px dashed var(--color-accent);
    outline-offset: -1px;
  }

  .tree-item.drop-before {
    box-shadow: inset 0 2px 0 0 var(--color-accent);
  }

  .tree-item.drop-after {
    box-shadow: inset 0 -2px 0 0 var(--color-accent);
  }

  .chevron {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .spinner {
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

  .chevron-spacer {
    width: 16px;
    flex-shrink: 0;
  }

  .name {
    font-size: 13px;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  /* Git status coloring for file names (like VSCode) */
  .name.git-modified {
    opacity: 0.9;
  }

  /* Git status indicator (M, U, A, D, etc.) */
  .staged-indicator {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.4;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
    background: color-mix(in srgb, var(--color-hover) 85%, transparent);
    flex-shrink: 0;
  }

  .staged-indicator + .git-indicator {
    margin-left: 6px;
  }

  .staged-staged_modified,
  .staged-staged_new {
    color: var(--color-success);
    background: color-mix(in srgb, var(--color-success) 14%, transparent);
  }

  .staged-staged_delete,
  .staged-failed {
    color: var(--color-error);
    background: color-mix(in srgb, var(--color-error) 14%, transparent);
  }

  .staged-committed {
    color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  }

  .git-indicator {
    font-size: 11px;
    font-weight: 600;
    margin-left: auto;
    padding-left: 8px;
    flex-shrink: 0;
    font-family: var(--font-mono, monospace);
  }

  .inline-input {
    flex: 1;
    min-width: 0;
    height: 20px;
    margin-left: 0;
    padding: 0 6px;
    font-size: 13px;
    color: var(--color-text);
    background: color-mix(in srgb, var(--color-bg) 70%, transparent);
    border: 1px solid
      color-mix(in srgb, var(--color-accent) 70%, var(--color-border));
    border-radius: 4px;
    outline: none;
  }

  .inline-input:focus {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px
      color-mix(in srgb, var(--color-accent) 25%, transparent);
  }
</style>
