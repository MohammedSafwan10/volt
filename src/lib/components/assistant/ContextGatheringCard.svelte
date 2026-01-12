<script lang="ts">
  /**
   * ContextGatheringCard - Shows real-time context gathering progress
   * Similar to Kiro's "Searched workspace" UI with bullet points
   */
  import { UIIcon, type UIIconName } from '$lib/components/ui';
  
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
      <span class="header-icon" class:spinning={isGathering}>
        <UIIcon name="search" size={16} />
      </span>
      <span class="header-title">
        {isGathering ? 'Gathering context...' : 'Context gathered'}
      </span>
      {#if stats}
        <span class="header-stats">
          {stats.filesFound} files · {stats.symbolsIndexed} symbols
        </span>
      {/if}
    </div>

    <div class="activities-list">
      {#each [...groupedActivities.entries()] as [type, items]}
        <div class="activity-group">
          <div class="group-header">
            <UIIcon name={typeIcons[type]} size={14} />
            <span>{typeLabels[type]}</span>
          </div>
          <ul class="activity-items">
            {#each items.slice(-5) as activity}
              <li class="activity-item" class:active={activity.status === 'active'}>
                <span class="bullet">•</span>
                <span class="activity-message">{activity.message}</span>
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
    margin: 8px 0;
    border-radius: 10px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    overflow: hidden;
    font-size: 13px;
  }

  .context-card.gathering {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface0));
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-border);
  }

  .header-icon {
    display: flex;
    align-items: center;
    color: var(--color-accent);
  }

  .header-icon.spinning :global(svg) {
    animation: spin 1.5s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .header-title {
    font-weight: 600;
    color: var(--color-text);
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

  .activity-message {
    flex: 1;
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
