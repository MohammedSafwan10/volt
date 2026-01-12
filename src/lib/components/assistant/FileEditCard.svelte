<script lang="ts">
  /**
   * FileEditCard - Clean file edit display card
   * Shows: ✓ Edited filename.ext [diff] [revert]
   */
  import { UIIcon } from '$lib/components/ui';
  import type { ToolCall } from '$lib/stores/assistant.svelte';

  interface Props {
    toolCall: ToolCall;
    groupedToolCalls?: ToolCall[];
    onViewDiff?: (tc: ToolCall, allToolCalls?: ToolCall[]) => void;
    onRevert?: (tc: ToolCall) => void;
    onUndoRevert?: (tc: ToolCall) => void;
    isReverted?: boolean;
    revertedIds?: Set<string>;
  }

  let { 
    toolCall, 
    groupedToolCalls = [], 
    onViewDiff, 
    onRevert, 
    onUndoRevert, 
    isReverted = false,
    revertedIds = new Set()
  }: Props = $props();

  const allToolCalls = $derived([toolCall, ...groupedToolCalls]);
  const isGrouped = $derived(groupedToolCalls.length > 0);
  let isExpanded = $state(false);
  
  const successCount = $derived(allToolCalls.filter(tc => tc.status === 'completed').length);
  const failedCount = $derived(allToolCalls.filter(tc => tc.status === 'failed').length);
  const runningCount = $derived(allToolCalls.filter(tc => tc.status === 'running').length);
  const totalCount = $derived(allToolCalls.length);

  const filename = $derived.by(() => {
    const path = toolCall.arguments.path as string | undefined;
    if (!path) return 'file';
    return path.split('/').pop() || path.split('\\').pop() || path;
  });

  const fileExt = $derived(filename.split('.').pop()?.toLowerCase() || '');

  function canRevertEdit(tc: ToolCall): boolean {
    if (tc.status !== 'completed' || revertedIds.has(tc.id)) return false;
    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    return typeof fileEdit?.beforeContent === 'string';
  }

  function canViewDiffEdit(tc: ToolCall): boolean {
    if (tc.status !== 'completed') return false;
    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    return typeof fileEdit?.beforeContent === 'string';
  }

  const canRevert = $derived(allToolCalls.some(tc => canRevertEdit(tc)));
  const canViewDiffAny = $derived(allToolCalls.some(tc => canViewDiffEdit(tc)));
  const hasAnyComplete = $derived(successCount > 0);
  const isAllRunning = $derived(runningCount > 0 && successCount === 0 && failedCount === 0);
  const isAllFailed = $derived(failedCount > 0 && successCount === 0);

  function getStatusText(): string {
    if (isReverted) return 'Reverted';
    if (isAllRunning) return 'Editing';
    if (isAllFailed) return 'Failed';
    
    const meta = toolCall.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    if (fileEdit?.isNewFile) return 'Created';
    return 'Edited';
  }

  const statusText = $derived(getStatusText());
  const firstError = $derived(allToolCalls.find(tc => tc.status === 'failed' && tc.error)?.error);
</script>

<div 
  class="edit-card" 
  class:success={hasAnyComplete && !isAllFailed && !isReverted}
  class:failed={isAllFailed}
  class:running={isAllRunning}
  class:reverted={isReverted}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
  <div class="card-row" role={isGrouped ? "button" : undefined} onclick={isGrouped ? () => isExpanded = !isExpanded : undefined}>
    <!-- Status indicator -->
    <div class="status-dot">
      {#if isAllRunning}
        <span class="dot running"></span>
      {:else if isAllFailed}
        <span class="dot failed"></span>
      {:else if isReverted}
        <span class="dot reverted"></span>
      {:else}
        <span class="dot success"></span>
      {/if}
    </div>

    <!-- Main content -->
    <div class="content">
      <span class="status-text">{statusText}</span>
      <span class="filename" data-ext={fileExt}>{filename}</span>
      {#if isGrouped}
        <span class="edit-count">+{groupedToolCalls.length}</span>
      {/if}
    </div>

    <!-- Actions -->
    <div class="actions">
      {#if hasAnyComplete && !isAllFailed}
        {#if isReverted}
          {#if onUndoRevert}
            <button class="action-btn restore" onclick={(e) => { e.stopPropagation(); onUndoRevert(toolCall); }} title="Restore changes">
              <UIIcon name="redo" size={14} />
            </button>
          {/if}
        {:else}
          {#if canViewDiffAny && onViewDiff}
            <button class="action-btn diff" onclick={(e) => { e.stopPropagation(); onViewDiff(toolCall, isGrouped ? allToolCalls : undefined); }} title="View diff">
              <UIIcon name="replace" size={14} />
            </button>
          {/if}
          {#if canRevert && onRevert}
            <button class="action-btn revert" onclick={(e) => { e.stopPropagation(); onRevert(toolCall); }} title="Revert">
              <UIIcon name="undo" size={14} />
            </button>
          {/if}
        {/if}
      {/if}
      {#if isGrouped}
        <button class="action-btn expand" class:expanded={isExpanded}>
          <UIIcon name="chevron-down" size={12} />
        </button>
      {/if}
    </div>
  </div>

  <!-- Expanded list for grouped edits -->
  {#if isGrouped && isExpanded}
    <div class="expanded-list">
      {#each allToolCalls as tc, i (tc.id)}
        {@const tcReverted = revertedIds.has(tc.id)}
        <div class="sub-item" class:reverted={tcReverted}>
          <span class="sub-index">{i + 1}.</span>
          <span class="sub-status">{tcReverted ? 'Reverted' : tc.status === 'failed' ? 'Failed' : 'Edited'}</span>
          <div class="sub-actions">
            {#if tc.status === 'completed'}
              {#if tcReverted}
                {#if onUndoRevert}
                  <button class="sub-btn" onclick={() => onUndoRevert(tc)} title="Restore">
                    <UIIcon name="redo" size={12} />
                  </button>
                {/if}
              {:else}
                {#if canViewDiffEdit(tc) && onViewDiff}
                  <button class="sub-btn" onclick={() => onViewDiff(tc)} title="Diff">
                    <UIIcon name="replace" size={12} />
                  </button>
                {/if}
                {#if canRevertEdit(tc) && onRevert}
                  <button class="sub-btn" onclick={() => onRevert(tc)} title="Revert">
                    <UIIcon name="undo" size={12} />
                  </button>
                {/if}
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Error message -->
  {#if isAllFailed && firstError}
    <div class="error-row">{firstError.split('\n')[0]}</div>
  {/if}
</div>

<style>
  .edit-card {
    border-radius: 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    overflow: hidden;
    transition: border-color 0.15s ease;
  }

  .edit-card.success { border-left: 3px solid var(--color-success); }
  .edit-card.failed { border-left: 3px solid var(--color-error); }
  .edit-card.running { border-left: 3px solid var(--color-accent); }
  .edit-card.reverted { border-left: 3px solid var(--color-warning); opacity: 0.8; }

  .card-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    cursor: default;
  }

  .edit-card:has(.edit-count) .card-row { cursor: pointer; }
  .edit-card:has(.edit-count) .card-row:hover { background: var(--color-hover); }

  .status-dot {
    flex-shrink: 0;
  }

  .dot {
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .dot.success { background: var(--color-success); }
  .dot.failed { background: var(--color-error); }
  .dot.reverted { background: var(--color-warning); }
  .dot.running {
    background: var(--color-accent);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }

  .content {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .status-text {
    font-size: 12px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .filename {
    font-size: 12px;
    font-family: var(--font-mono, monospace);
    font-weight: 500;
    color: var(--color-text);
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--color-surface1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* File type colors */
  .filename[data-ext="ts"], .filename[data-ext="tsx"] { color: #3178c6; }
  .filename[data-ext="js"], .filename[data-ext="jsx"] { color: #f0db4f; }
  .filename[data-ext="svelte"] { color: #ff3e00; }
  .filename[data-ext="css"], .filename[data-ext="scss"] { color: #42a5f5; }
  .filename[data-ext="json"] { color: #fbc02d; }
  .filename[data-ext="html"] { color: #e44d26; }
  .filename[data-ext="md"] { color: #42a5f5; }
  .filename[data-ext="rs"] { color: #dea584; }
  .filename[data-ext="py"] { color: #3572A5; }

  .edit-count {
    font-size: 10px;
    color: var(--color-text-secondary);
    background: var(--color-surface1);
    padding: 2px 6px;
    border-radius: 10px;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    color: var(--color-text-secondary);
    background: transparent;
    transition: all 0.12s ease;
  }

  .action-btn:hover {
    background: var(--color-surface1);
    color: var(--color-text);
  }

  .action-btn.diff:hover { color: var(--color-accent); }
  .action-btn.revert:hover { color: var(--color-warning); }
  .action-btn.restore { color: var(--color-success); }
  .action-btn.restore:hover { background: color-mix(in srgb, var(--color-success) 15%, transparent); }

  .action-btn.expand {
    width: 20px;
    height: 20px;
    transition: transform 0.15s ease;
  }

  .action-btn.expand.expanded { transform: rotate(180deg); }

  /* Expanded list */
  .expanded-list {
    border-top: 1px solid var(--color-border);
    padding: 6px 12px 8px 30px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .sub-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
  }

  .sub-item:hover { background: var(--color-hover); }
  .sub-item.reverted { opacity: 0.6; }

  .sub-index {
    color: var(--color-text-secondary);
    font-family: var(--font-mono, monospace);
    min-width: 18px;
  }

  .sub-status {
    flex: 1;
    color: var(--color-text);
  }

  .sub-actions {
    display: flex;
    gap: 2px;
  }

  .sub-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.12s ease;
  }

  .sub-btn:hover {
    background: var(--color-surface1);
    color: var(--color-text);
  }

  /* Error row */
  .error-row {
    padding: 8px 12px;
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    color: var(--color-error);
    background: color-mix(in srgb, var(--color-error) 8%, transparent);
    border-top: 1px solid var(--color-border);
  }
</style>
