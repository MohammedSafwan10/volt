<script lang="ts">
  import type { OpenFile } from '$lib/stores/editor.svelte';
  import { FileIcon } from '$lib/components/file-tree';
  import { UIIcon } from '$lib/components/ui';

  interface Props {
    file: OpenFile;
    isActive: boolean;
    isDirty: boolean;
    isPinned?: boolean;
    isDropTarget?: boolean;
    onSelect: () => void;
    onClose: () => void;
    onContextMenu?: (file: OpenFile, e: MouseEvent) => void;
    onDragStart?: (e: DragEvent) => void;
    onDragOver?: (e: DragEvent) => void;
    onDragLeave?: (e: DragEvent) => void;
    onDrop?: (e: DragEvent) => void;
    onDragEnd?: (e: DragEvent) => void;
  }

  let { 
    file, 
    isActive, 
    isDirty, 
    isPinned = false,
    isDropTarget = false,
    onSelect, 
    onClose, 
    onContextMenu,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd
  }: Props = $props();

  function handleMouseDown(e: MouseEvent) {
    // Middle-click to close
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  }

  function handleCloseClick(e: MouseEvent) {
    e.stopPropagation();
    onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.currentTarget !== e.target) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    onContextMenu?.(file, e);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    onDragOver?.(e);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    onDrop?.(e);
  }

  function handleDragStart(e: DragEvent) {
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Set drag image
      const target = e.currentTarget as HTMLElement;
      e.dataTransfer.setDragImage(target, 0, 0);
    }
    onDragStart?.(e);
  }
</script>

<div
  class="tab no-select"
  class:active={isActive}
  class:pinned={isPinned}
  class:drop-target={isDropTarget}
  draggable="true"
  onclick={onSelect}
  onmousedown={handleMouseDown}
  onkeydown={handleKeydown}
  oncontextmenu={handleContextMenu}
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondragleave={onDragLeave}
  ondrop={handleDrop}
  ondragend={onDragEnd}
  title={file.path}
  role="tab"
  aria-selected={isActive}
  tabindex="0"
>
  {#if isPinned}
    <span class="pin-icon" title="Pinned">
      <UIIcon name="pin" size={12} />
    </span>
  {/if}
  <span class="tab-icon">
    <FileIcon name={file.name} />
  </span>
  <span class="tab-name">{file.name}</span>
  {#if isDirty}
    <span class="dirty-indicator" title="Unsaved changes">●</span>
  {/if}
  {#if !isPinned}
    <button
      class="close-btn"
      onclick={handleCloseClick}
      aria-label="Close {file.name}"
      title="Close"
    >
      <UIIcon name="close" size={14} />
    </button>
  {/if}
</div>

<style>
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 100%;
    padding: 0 10px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--color-border);
    border-bottom: 2px solid transparent;
    color: var(--color-text-secondary);
    font-size: 13px;
    cursor: grab;
    transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    white-space: nowrap;
    min-width: 0;
    max-width: 200px;
    flex-shrink: 0;
  }

  .tab:active {
    cursor: grabbing;
  }

  .tab:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .tab.active {
    background: color-mix(in srgb, var(--color-bg) 92%, var(--color-bg-elevated, var(--color-bg)));
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
  }

  .tab-icon {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dirty-indicator {
    color: var(--color-accent);
    font-size: 10px;
    flex-shrink: 0;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--color-text-secondary);
    font-size: 10px;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.1s ease, background 0.1s ease, visibility 0.1s ease;
    flex-shrink: 0;
  }

  .tab:hover .close-btn {
    opacity: 1;
    visibility: visible;
  }

  .tab:focus-within .close-btn {
    opacity: 1;
    visibility: visible;
  }

  .close-btn:hover {
    background: color-mix(in srgb, var(--color-hover) 85%, transparent);
    color: var(--color-text);
  }

  /* Always show close button on active tab */
  .tab.active .close-btn {
    opacity: 0.7;
    visibility: visible;
  }

  .tab.active .close-btn:hover {
    opacity: 1;
  }

  /* Pinned tab styles */
  .tab.pinned {
    padding-left: 6px;
    padding-right: 8px;
    max-width: 140px;
  }

  .pin-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .tab.pinned:hover .pin-icon,
  .tab.pinned.active .pin-icon {
    color: var(--color-accent);
  }

  /* Drag and drop styles */
  .tab.drop-target {
    border-left: 2px solid var(--color-accent);
  }

  .tab:global(.dragging) {
    opacity: 0.5;
  }
</style>
