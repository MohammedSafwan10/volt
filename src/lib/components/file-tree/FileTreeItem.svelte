<script lang="ts">
  import { projectStore, type TreeNode } from '$lib/stores/project.svelte';
  import { getNodeIcon } from './file-icons';

  interface Props {
    node: TreeNode;
    depth: number;
    onFileSelect?: (path: string) => void;
    onContextMenu?: (node: TreeNode, e: MouseEvent) => void;
  }

  let { node, depth, onFileSelect, onContextMenu }: Props = $props();

  const isSelected = $derived(projectStore.selectedPath === node.path);
  const icon = $derived(getNodeIcon(node.name, node.isDir, node.expanded));
  const indentPx = $derived(depth * 16);

  async function handleActivate(): Promise<void> {
    projectStore.selectItem(node.path);
    if (node.isDir) {
      await projectStore.toggleFolder(node);
    } else {
      onFileSelect?.(node.path);
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void handleActivate();
    }
  }
</script>

<div
  class="tree-item"
  data-tree-row
  class:selected={isSelected}
  style="padding-left: {indentPx + 8}px"
  role="treeitem"
  tabindex="0"
  aria-selected={isSelected}
  aria-expanded={node.isDir ? node.expanded : undefined}
  onclick={() => void handleActivate()}
  onkeydown={handleKeydown}
  oncontextmenu={(e) => onContextMenu?.(node, e)}
>
  {#if node.isDir}
    <span class="chevron" class:expanded={node.expanded} aria-hidden="true">
      {node.loading ? '⏳' : '›'}
    </span>
  {:else}
    <span class="chevron-spacer"></span>
  {/if}

  <span class="icon" aria-hidden="true">{icon}</span>
  <span class="name" title={node.path}>{node.name}</span>
</div>

<style>
  .tree-item {
    user-select: none;
    display: flex;
    align-items: center;
    height: 24px;
    padding-right: 8px;
    cursor: pointer;
    border-radius: 4px;
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

  .chevron {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--color-text-secondary);
    transition: transform 0.15s ease;
    flex-shrink: 0;
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .chevron-spacer {
    width: 16px;
    flex-shrink: 0;
  }

  .icon {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    margin-right: 6px;
    flex-shrink: 0;
  }

  .name {
    font-size: 13px;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
