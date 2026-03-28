<script lang="ts">
  /**
   * ContextGatheringCard - Shows real-time context gathering progress
   * Displays "Searched workspace" UI with bullet points
   */
  import { UIIcon, type UIIconName } from '$shared/components/ui';
  
  export interface ContextActivity {
    id: string;
    type: 'search' | 'read' | 'analyze' | 'index';
    message: string;
    status: 'active' | 'done';
    timestamp: number;
  }

  interface Props {
    activities: ContextActivity[];
    isGathering: boolean;
    stats?: {
      filesFound: number;
      symbolsIndexed: number;
      budgetUsed: number;
    };
  }

  let { activities, isGathering, stats }: Props = $props();

  const typeIcons: Record<ContextActivity['type'], UIIconName> = {
    search: 'search',
    read: 'file',
    analyze: 'code',
    index: 'symbol-class'
  };

  const typeLabels: Record<ContextActivity['type'], string> = {
    search: 'Searched workspace',
    read: 'Reading files',
    analyze: 'Analyzing code',
    index: 'Indexing symbols'
  };

  // Group activities by type for cleaner display
  const groupedActivities = $derived.by(() => {
    const groups = new Map<ContextActivity['type'], ContextActivity[]>();
    for (const activity of activities) {
      const existing = groups.get(activity.type) || [];
      existing.push(activity);
      groups.set(activity.type, existing);
    }
    return groups;
  });

  const hasActivities = $derived(activities.length > 0);
</script>

{#if hasActivities || isGathering}
  <div class="context-card" class:gathering={isGathering}>
    <div class="card-header">
      <span class="header-icon" class:shimmer-icon={isGathering} title={isGathering ? 'Gathering context...' : 'Context'}>
        {#if isGathering}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2 2.5 2.5 0 0 1 .5 0Z"
            />
            <path
              d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2 2.5 2.5 0 0 0-.5 0Z"
            />
          </svg>
        {:else}
          <UIIcon name="search" size={14} />
        {/if}
      </span>
      {#if stats}
        <span class="header-stats" title="{stats.filesFound} files · {stats.symbolsIndexed} symbols">
          <UIIcon name="symbol-property" size={12} />
        </span>
      {/if}
    </div>

    <div class="activities-list">
      {#each [...groupedActivities.entries()] as [type, items]}
        <div class="activity-group">
          <div class="group-header" title={typeLabels[type]}>
            <UIIcon name={typeIcons[type]} size={14} />
          </div>
          <ul class="activity-items">
            {#each items.slice(-5) as activity}
              <li class="activity-item" class:active={activity.status === 'active'} title={activity.message}>
                <span class="bullet">•</span>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>

    {#if isGathering}
      <div class="progress-bar">
        <div class="progress-fill" style="width: {stats?.budgetUsed ?? 0}%"></div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .context-card {
    margin: 4px 0;
    border-radius: 8px;
    background: transparent;
    border: none;
    overflow: hidden;
    font-size: 13px;
  }

  .context-card.gathering {
    background: transparent;
    border: none;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
  }

  .header-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
  }

  .header-stats {
    margin-left: auto;
    font-size: 11px;
    color: var(--color-text-secondary);
    font-family: monospace;
  }

  .activities-list {
    padding: 10px 14px;
  }

  .activity-group {
    margin-bottom: 10px;
  }

  .activity-group:last-child {
    margin-bottom: 0;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }

  .activity-items {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .activity-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 3px 0;
    color: var(--color-text);
    font-size: 12px;
  }

  .activity-item.active {
    color: var(--color-accent);
  }

  .bullet {
    color: var(--color-accent);
    font-weight: bold;
    line-height: 1.4;
  }

  .progress-bar {
    height: 3px;
    background: var(--color-surface1);
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--color-accent), var(--color-success));
    transition: width 0.3s ease-out;
  }
</style>
