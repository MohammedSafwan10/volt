<script lang="ts">
  import { uiStore } from '$lib/stores/ui.svelte';
  import ResizablePanel from '$lib/components/layout/ResizablePanel.svelte';
  import { FileTree } from '$lib/components/file-tree';

  interface Props {
    onFileSelect?: (path: string) => void;
  }

  let { onFileSelect }: Props = $props();

  function getPanelTitle(): string {
    switch (uiStore.activeSidebarPanel) {
      case 'explorer':
        return 'EXPLORER';
      case 'search':
        return 'SEARCH';
      case 'git':
        return 'SOURCE CONTROL';
      case 'settings':
        return 'SETTINGS';
      default:
        return '';
    }
  }

  function handleClose(): void {
    uiStore.sidebarOpen = false;
  }
</script>

{#if uiStore.sidebarOpen && uiStore.activeSidebarPanel}
  <div
    class="side-panel"
    style="width: {uiStore.sidebarWidth}px"
    role="region"
    aria-label={getPanelTitle()}
  >
    <div class="panel-header">
      <span class="panel-title">{getPanelTitle()}</span>
      <button
        class="panel-close"
        onclick={handleClose}
        aria-label="Close panel"
        title="Close panel"
        type="button"
      >
        ✕
      </button>
    </div>
    <div class="panel-content">
      {#if uiStore.activeSidebarPanel === 'explorer'}
        <FileTree {onFileSelect} />
      {:else if uiStore.activeSidebarPanel === 'search'}
        <p class="placeholder-text">Search panel coming soon</p>
      {:else if uiStore.activeSidebarPanel === 'git'}
        <p class="placeholder-text">Git panel coming soon</p>
      {:else if uiStore.activeSidebarPanel === 'settings'}
        <p class="placeholder-text">Settings panel coming soon</p>
      {/if}
    </div>
  </div>

  <ResizablePanel
    direction="horizontal"
    size={uiStore.sidebarWidth}
    minSize={150}
    maxSize={500}
    onResize={(width) => uiStore.setSidebarWidth(width)}
  />
{/if}

<style>
  .side-panel {
    display: flex;
    flex-direction: column;
    background: var(--color-bg-sidebar);
    border-right: 1px solid var(--color-border);
    overflow: hidden;
    flex-shrink: 0;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-header);
    flex-shrink: 0;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    letter-spacing: 0.5px;
  }

  .panel-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    color: var(--color-text-secondary);
    border-radius: 4px;
    font-size: 12px;
    transition: all 0.1s ease;
    cursor: pointer;
  }

  .panel-close:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .panel-close:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .panel-content {
    flex: 1;
    overflow: auto;
    padding: 12px;
  }

  .placeholder-text {
    color: var(--color-text-disabled);
    font-size: 13px;
    font-style: italic;
    margin: 0;
  }
</style>
