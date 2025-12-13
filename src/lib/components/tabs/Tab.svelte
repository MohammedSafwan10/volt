<script lang="ts">
  import type { OpenFile } from '$lib/stores/editor.svelte';

  interface Props {
    file: OpenFile;
    isActive: boolean;
    isDirty: boolean;
    onSelect: () => void;
    onClose: () => void;
  }

  let { file, isActive, isDirty, onSelect, onClose }: Props = $props();

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

  function getFileIcon(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const iconMap: Record<string, string> = {
      'js': '📜',
      'mjs': '📜',
      'cjs': '📜',
      'jsx': '⚛️',
      'ts': '📘',
      'tsx': '⚛️',
      'svelte': '🔶',
      'vue': '💚',
      'html': '🌐',
      'css': '🎨',
      'scss': '🎨',
      'sass': '🎨',
      'less': '🎨',
      'json': '📋',
      'md': '📝',
      'mdx': '📝',
      'yaml': '⚙️',
      'yml': '⚙️',
      'toml': '⚙️',
      'xml': '📄',
      'svg': '🖼️',
      'png': '🖼️',
      'jpg': '🖼️',
      'gif': '🖼️',
      'rs': '🦀',
      'py': '🐍',
      'go': '🐹',
      'rb': '💎',
      'sh': '🐚',
      'bash': '🐚',
      'ps1': '🐚',
      'bat': '🐚',
      'cmd': '🐚',
    };
    return iconMap[ext] || '📄';
  }
</script>

<div
  class="tab no-select"
  class:active={isActive}
  onclick={onSelect}
  onmousedown={handleMouseDown}
  onkeydown={handleKeydown}
  title={file.path}
  role="tab"
  aria-selected={isActive}
  tabindex="0"
>
  <span class="tab-icon">{getFileIcon(file.name)}</span>
  <span class="tab-name">{file.name}</span>
  {#if isDirty}
    <span class="dirty-indicator" title="Unsaved changes">●</span>
  {/if}
  <button
    class="close-btn"
    onclick={handleCloseClick}
    aria-label="Close {file.name}"
    title="Close"
  >
    ✕
  </button>
</div>

<style>
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 100%;
    padding: 0 12px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: 13px;
    cursor: pointer;
    transition: background 0.1s ease, color 0.1s ease;
    white-space: nowrap;
    min-width: 0;
    max-width: 200px;
    flex-shrink: 0;
  }

  .tab:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .tab.active {
    background: var(--color-bg);
    color: var(--color-text);
    border-bottom: 2px solid var(--color-accent);
  }

  .tab-icon {
    font-size: 14px;
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
    background: var(--color-hover);
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
</style>
