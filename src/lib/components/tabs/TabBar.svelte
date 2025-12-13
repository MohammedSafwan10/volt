<script lang="ts">
  import { tick } from 'svelte';
  import Tab from './Tab.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';
  import { triggerImmediateAutoSave } from '$lib/services/auto-save';

  let tabsContainer: HTMLDivElement | undefined = $state();

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

  $effect(() => {
    // Keep active tab visible when switching/opening.
    void (async () => {
      await tick();
      const el = tabsContainer?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    })();
  });
</script>

<div class="tab-bar no-select" role="tablist" aria-label="Open editors">
  {#if editorStore.openFiles.length === 0}
    <span class="tab-placeholder">No files open</span>
  {:else}
    <div
      class="tabs-container"
      bind:this={tabsContainer}
      onwheel={handleWheel}
    >
      {#each editorStore.openFiles as file (file.path)}
        <Tab
          {file}
          isActive={editorStore.activeFilePath === file.path}
          isDirty={editorStore.isDirty(file.path)}
          onSelect={() => handleSelect(file.path)}
          onClose={() => handleClose(file.path)}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    height: 35px;
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
</style>
