<script lang="ts">
  import { uiStore } from '$lib/stores/ui.svelte';
  import { bottomPanelStore, type BottomPanelTab } from '$lib/stores/bottom-panel.svelte';
  import { TerminalTabs } from '$lib/components/terminal';
  import OutputView from './OutputView.svelte';
  import ProblemsView from './ProblemsView.svelte';

  interface Tab {
    id: BottomPanelTab;
    label: string;
  }

  const tabs: Tab[] = [
    { id: 'problems', label: 'PROBLEMS' },
    { id: 'output', label: 'OUTPUT' },
    { id: 'terminal', label: 'TERMINAL' }
  ];

  function handleTabClick(tabId: BottomPanelTab): void {
    bottomPanelStore.setActiveTab(tabId);
  }

  function handleClose(): void {
    uiStore.toggleBottomPanel();
  }
</script>

<div class="bottom-panel">
  <div class="panel-header">
    <div class="panel-tabs">
      {#each tabs as tab (tab.id)}
        <button
          class="panel-tab"
          class:active={bottomPanelStore.activeTab === tab.id}
          onclick={() => handleTabClick(tab.id)}
          role="tab"
          aria-selected={bottomPanelStore.activeTab === tab.id}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    <div class="panel-actions">
      <button
        class="panel-close"
        onclick={handleClose}
        aria-label="Close panel"
        title="Close panel"
      >
        ✕
      </button>
    </div>
  </div>

  <div class="panel-content">
    <div class="panel-view" class:active={bottomPanelStore.activeTab === 'problems'}>
      <ProblemsView />
    </div>

    <div class="panel-view" class:active={bottomPanelStore.activeTab === 'output'}>
      <OutputView />
    </div>

    <div class="panel-view" class:active={bottomPanelStore.activeTab === 'terminal'}>
      <div class="terminal-wrapper">
        <TerminalTabs />
      </div>
    </div>
  </div>
</div>

<style>
  .bottom-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg-panel);
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
    min-height: 28px;
  }

  .panel-tabs {
    display: flex;
    align-items: center;
  }

  .panel-tab {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    letter-spacing: 0.3px;
    transition: all 0.1s ease;
  }

  .panel-tab:hover {
    color: var(--color-text);
    background: var(--color-hover);
  }

  .panel-tab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
  }

  .panel-actions {
    display: flex;
    align-items: center;
    padding-right: 8px;
  }

  .panel-close {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.1s ease;
  }

  .panel-close:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .panel-content {
    flex: 1;
    overflow: hidden;
    position: relative;
  }

  .panel-view {
    position: absolute;
    inset: 0;
    visibility: hidden;
    pointer-events: none;
  }

  .panel-view.active {
    visibility: visible;
    pointer-events: auto;
  }

  .terminal-wrapper {
    height: 100%;
  }
</style>
