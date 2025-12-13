<script lang="ts">
  import { uiStore, type SidebarPanel } from '$lib/stores/ui.svelte';
  import { showToast } from '$lib/stores/toast.svelte';

  interface ActivityItem {
    id: SidebarPanel;
    icon: string;
    label: string;
    implemented: boolean;
  }

  const topItems: ActivityItem[] = [
    { id: 'explorer', icon: '📁', label: 'Explorer', implemented: true },
    { id: 'search', icon: '🔍', label: 'Search', implemented: false },
    { id: 'git', icon: '🌿', label: 'Source Control', implemented: false }
  ];

  const bottomItems: ActivityItem[] = [
    { id: 'settings', icon: '⚙️', label: 'Settings', implemented: false }
  ];

  function handleClick(item: ActivityItem): void {
    uiStore.setActiveSidebarPanel(item.id);

    if (!item.implemented) {
      showToast({
        message: `${item.label} coming soon`,
        type: 'info',
        duration: 3000
      });
    }
  }

  function handleKeydown(event: KeyboardEvent, item: ActivityItem): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick(item);
    }
  }

  function isActive(itemId: SidebarPanel): boolean {
    return uiStore.sidebarOpen && uiStore.activeSidebarPanel === itemId;
  }
</script>

<nav class="activity-bar" aria-label="Activity Bar">
  <div class="activity-top">
    {#each topItems as item (item.id)}
      <button
        class="activity-item"
        class:active={isActive(item.id)}
        onclick={() => handleClick(item)}
        onkeydown={(e) => handleKeydown(e, item)}
        aria-label={item.label}
        aria-pressed={isActive(item.id)}
        title={item.label}
        type="button"
      >
        <span class="activity-icon" aria-hidden="true">{item.icon}</span>
      </button>
    {/each}
  </div>

  <div class="activity-bottom">
    {#each bottomItems as item (item.id)}
      <button
        class="activity-item"
        class:active={isActive(item.id)}
        onclick={() => handleClick(item)}
        onkeydown={(e) => handleKeydown(e, item)}
        aria-label={item.label}
        aria-pressed={isActive(item.id)}
        title={item.label}
        type="button"
      >
        <span class="activity-icon" aria-hidden="true">{item.icon}</span>
      </button>
    {/each}
  </div>
</nav>

<style>
  .activity-bar {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    width: 48px;
    background: var(--color-bg-sidebar);
    border-right: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .activity-top,
  .activity-bottom {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 0;
  }

  .activity-item {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    color: var(--color-text-secondary);
    border-left: 2px solid transparent;
    transition: all 0.15s ease;
    cursor: pointer;
  }

  .activity-item:hover {
    color: var(--color-text);
    background: var(--color-hover);
  }

  .activity-item:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .activity-item.active {
    color: var(--color-text);
    border-left-color: var(--color-accent);
    background: var(--color-active);
  }

  .activity-icon {
    font-size: 22px;
    line-height: 1;
  }
</style>
