<script lang="ts">
  import { projectStore, type TreeNode } from '$lib/stores/project.svelte';
  import { UIIcon } from '$lib/components/ui';
  import FileIcon from './FileIcon.svelte';

  interface Props {
    node: TreeNode;
    depth: number;
    onFileSelect?: (path: string) => void;
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
    dropPosition?: 'inside' | 'before' | 'after' | null;
    onDragStart?: (node: TreeNode, e: DragEvent) => void;
    onDragOver?: (node: TreeNode, e: DragEvent) => void;
    onDragLeave?: (node: TreeNode, e: DragEvent) => void;
    onDrop?: (node: TreeNode, e: DragEvent) => void;
    onDragEnd?: () => void;
  }

  let {
    node,
    depth,
    onFileSelect,
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
    onDragEnd
  }: Props = $props();

  const isSelected = $derived(projectStore.selectedPath === node.path);
  const indentPx = $derived(depth * 16);
  const isDraftNode = $derived(node.path.startsWith('__draft__:'));

  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (!isEditing || !inputEl) return;
    void editFocusNonce;
    inputEl.focus();
    inputEl.select();
  });

  async function handleActivate(): Promise<void> {
    projectStore.selectItem(node.path);
    if (node.isDir) {
      await projectStore.toggleFolder(node);
    } else {
      onFileSelect?.(node.path);
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (isEditing) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void handleActivate();
    }
  }

  function handleInputKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      onEditCommit?.();
    } else if (e.key === 'Escape') {
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
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.path);
    }
    onDragStart?.(node, e);
  }

  function handleDragOver(e: DragEvent): void {
    if (isDraftNode) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
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
  class:drop-inside={dropPosition === 'inside'}
  class:drop-before={dropPosition === 'before'}
  class:drop-after={dropPosition === 'after'}
  style="padding-left: {indentPx + 8}px"
  role="treeitem"
  tabindex="0"
  aria-selected={isSelected}
  aria-expanded={node.isDir ? node.expanded : undefined}
  draggable={!isEditing && !isDraftNode}
  onclick={() => {
    if (isEditing) return;
    void handleActivate();
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
        <UIIcon name={node.expanded ? 'chevron-down' : 'chevron-right'} size={14} />
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
      value={editValue ?? ''}
      placeholder={editPlaceholder}
      oninput={(e) => onEditValueChange?.((e.target as HTMLInputElement).value)}
      onkeydown={handleInputKeydown}
      onblur={() => onEditCommit?.()}
    />
  {:else}
    <span class="name" title={node.path}>{node.name}</span>
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
    border: 1px solid color-mix(in srgb, var(--color-accent) 70%, var(--color-border));
    border-radius: 4px;
    outline: none;
  }

  .inline-input:focus {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 25%, transparent);
  }
</style>
