<script lang="ts">
  import { uiStore } from '$lib/stores/ui.svelte';
  import { bottomPanelStore, type BottomPanelTab } from '$lib/stores/bottom-panel.svelte';
  import { TerminalTabs } from '$lib/components/terminal';
  import { UIIcon } from '$lib/components/ui';
  import { terminalStore } from '$lib/stores/terminal.svelte';
  import type { TerminalSession } from '$lib/services/terminal-client';
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

  let terminalMenuOpen = $state(false);

  function toggleTerminalMenu(): void {
    terminalMenuOpen = !terminalMenuOpen;
  }

  function closeTerminalMenu(): void {
    terminalMenuOpen = false;
  }

  function handleWindowClick(e: MouseEvent): void {
    if (!terminalMenuOpen) return;
    if (!(e.target instanceof HTMLElement)) return;
    if (e.target.closest('[data-terminal-menu]')) return;
    closeTerminalMenu();
  }

  function getTerminalLabel(session: TerminalSession, index: number): string {
    const shell = session.info.shell;
    const shellName = shell.split(/[/\\]/).pop() || 'terminal';
    return `${shellName} ${index + 1}`;
  }

  function handleNewTerminal(): void {
    uiStore.bottomPanelOpen = true;
    bottomPanelStore.setActiveTab('terminal');
    void terminalStore.createTerminal();
  }

  function handleKillActiveTerminal(): void {
    const active = terminalStore.activeTerminalId;
    if (!active) return;
    void terminalStore.killTerminal(active);
  }

  function handleSelectTerminal(id: string): void {
    terminalStore.setActive(id);
    closeTerminalMenu();
  }
</script>

<svelte:window onclick={handleWindowClick} />

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
      {#if bottomPanelStore.activeTab === 'terminal'}
        <button
          class="panel-action"
          onclick={handleNewTerminal}
          aria-label="New terminal"
          title="New Terminal"
          type="button"
        >
          <UIIcon name="plus" size={14} />
        </button>

        <button
          class="panel-action"
          onclick={toggleTerminalMenu}
          aria-label="Select terminal"
          title="Select Terminal"
          aria-expanded={terminalMenuOpen}
          type="button"
        >
          <UIIcon name="chevron-down" size={14} />
        </button>

        <button
          class="panel-action"
          onclick={handleKillActiveTerminal}
          aria-label="Kill terminal"
          title="Kill Terminal"
          disabled={!terminalStore.activeTerminalId}
          type="button"
        >
          <UIIcon name="trash" size={14} />
        </button>
      {/if}

      <button
        class="panel-close"
        onclick={handleClose}
        aria-label="Close panel"
        title="Close panel"
      >
        <UIIcon name="close" size={14} />
      </button>
    </div>
  </div>

  {#if terminalMenuOpen && bottomPanelStore.activeTab === 'terminal'}
    <div class="terminal-menu" data-terminal-menu role="menu" aria-label="Terminal list">
      {#if terminalStore.sessions.length === 0}
        <div class="terminal-menu-empty">No terminals</div>
      {:else}
        {#each terminalStore.sessions as session, idx (session.id)}
          <div
            class="terminal-menu-item"
            class:active={session.id === terminalStore.activeTerminalId}
            onclick={() => handleSelectTerminal(session.id)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleSelectTerminal(session.id);
              }
            }}
            role="menuitem"
            tabindex="0"
          >
            <span class="terminal-menu-icon" aria-hidden="true">
              <UIIcon name="terminal" size={14} />
            </span>
            <span class="terminal-menu-label">{getTerminalLabel(session, idx)}</span>
            <span class="terminal-menu-actions">
              <button
                class="terminal-menu-kill"
                onclick={(e) => {
                  e.stopPropagation();
                  void terminalStore.killTerminal(session.id);
                }}
                aria-label="Kill terminal"
                title="Kill Terminal"
                type="button"
              >
                <UIIcon name="close" size={14} />
              </button>
            </span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}

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
    position: relative;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
    min-height: 28px;
    padding: 0 8px;
  }

  .panel-tabs {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .panel-tab {
    height: 28px;
    padding: 0 10px;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    letter-spacing: 0.35px;
    text-transform: uppercase;
    border-radius: 6px;
    transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }

  .panel-tab:hover {
    color: var(--color-text);
    background: color-mix(in srgb, var(--color-hover) 85%, transparent);
  }

  .panel-tab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-bg) 92%, transparent);
  }

  .panel-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .panel-action {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .panel-action:hover {
    background: color-mix(in srgb, var(--color-hover) 85%, transparent);
    color: var(--color-text);
  }

  .panel-action:disabled {
    opacity: 0.5;
    cursor: default;
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
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.1s ease;
  }

  .panel-close:hover {
    background: color-mix(in srgb, var(--color-hover) 85%, transparent);
    color: var(--color-text);
  }

  .terminal-menu {
    position: absolute;
    top: 28px;
    right: 8px;
    z-index: 3000;
    width: 260px;
    max-height: 320px;
    overflow: auto;
    background: var(--color-bg-elevated, var(--color-bg-panel));
    border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
    border-radius: 10px;
    box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
    padding: 6px;
  }

  .terminal-menu-empty {
    padding: 10px;
    color: var(--color-text-secondary);
    font-size: 12px;
  }

  .terminal-menu-item {
    width: 100%;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    border-radius: 8px;
    text-align: left;
    color: var(--color-text);
    cursor: pointer;
    transition: background-color 0.12s ease;
  }

  .terminal-menu-item:hover {
    background: color-mix(in srgb, var(--color-hover) 85%, transparent);
  }

  .terminal-menu-item.active {
    background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  }

  .terminal-menu-icon {
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .terminal-menu-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .terminal-menu-actions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .terminal-menu-kill {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    color: var(--color-text-secondary);
    opacity: 0;
    transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
  }

  .terminal-menu-item:hover .terminal-menu-kill {
    opacity: 1;
  }

  .terminal-menu-kill:hover {
    background: color-mix(in srgb, var(--color-error) 22%, transparent);
    color: var(--color-error);
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
