<script lang="ts">
  import { uiStore } from '$shared/stores/ui.svelte';
  import ResizablePanel from '$shared/components/layout/ResizablePanel.svelte';
  import { FileTree } from '$features/editor/components/file-tree';
  import { UIIcon } from '$shared/components/ui';
  import ExtensionsPanel from './ExtensionsPanel.svelte';
  import { SearchPanel } from '$features/search/components';
  import { GitPanel } from '$features/git/components';
  import SettingsPanel from './SettingsPanel.svelte';
  import McpPanel from '$features/mcp/components/McpPanel.svelte';
  import PromptLibraryPanel from './PromptLibraryPanel.svelte';

  interface Props {
    onFileSelect?: (path: string) => void;
  }

  let { onFileSelect }: Props = $props();

  const PROMPTS_DEFAULT_WIDTH = 520;
  const PROMPTS_MIN_WIDTH = 360;
  const PROMPTS_MAX_WIDTH = 760;
  const DEFAULT_MIN_WIDTH = 150;
  const DEFAULT_MAX_WIDTH = 500;

  const resizeMin = $derived(
    uiStore.activeSidebarPanel === 'prompts' ? PROMPTS_MIN_WIDTH : DEFAULT_MIN_WIDTH
  );
  const resizeMax = $derived(
    uiStore.activeSidebarPanel === 'prompts' ? PROMPTS_MAX_WIDTH : DEFAULT_MAX_WIDTH
  );

  $effect(() => {
    if (uiStore.activeSidebarPanel === 'prompts' && uiStore.sidebarWidth < PROMPTS_DEFAULT_WIDTH) {
      uiStore.setSidebarWidth(PROMPTS_DEFAULT_WIDTH);
    }
  });

  function getPanelTitle(): string {
    switch (uiStore.activeSidebarPanel) {
      case 'explorer':
        return 'EXPLORER';
      case 'search':
        return 'SEARCH';
      case 'git':
        return 'SOURCE CONTROL';
      case 'extensions':
        return 'EXTENSIONS';
      case 'settings':
        return 'SETTINGS';
      case 'mcp':
        return 'MCP SERVERS';
      case 'prompts':
        return 'PROMPT LIBRARY';
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
        <UIIcon name="close" size={14} />
      </button>
    </div>
    <div class="panel-content">
      {#if uiStore.activeSidebarPanel === 'explorer'}
        <FileTree {onFileSelect} />
      {:else if uiStore.activeSidebarPanel === 'search'}
        <SearchPanel />
      {:else if uiStore.activeSidebarPanel === 'git'}
        <GitPanel />
      {:else if uiStore.activeSidebarPanel === 'extensions'}
        <ExtensionsPanel />
      {:else if uiStore.activeSidebarPanel === 'settings'}
        <SettingsPanel />
      {:else if uiStore.activeSidebarPanel === 'mcp'}
        <McpPanel />
      {:else if uiStore.activeSidebarPanel === 'prompts'}
        <PromptLibraryPanel />
      {/if}
    </div>
  </div>

  <ResizablePanel
    direction="horizontal"
    size={uiStore.sidebarWidth}
    minSize={resizeMin}
    maxSize={resizeMax}
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
    padding: 0;
  }

</style>
