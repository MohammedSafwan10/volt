<script lang="ts">
  /**
   * FileEditCard - Kiro-style file edit display
   * Single edit: ✓ Accepted edits to [filename] [View diff] [↩ Revert]
   * Grouped edits: ▼ 3 edits to file [filename] [View diff] [↩ Revert]
   *   └─ Expanded shows individual edits with their own buttons
   */
  import { UIIcon } from '$lib/components/ui';
  import type { ToolCall } from '$lib/stores/assistant.svelte';

  interface Props {
    toolCall: ToolCall;
    groupedToolCalls?: ToolCall[];
    onViewDiff?: (tc: ToolCall) => void;
    onRevert?: (tc: ToolCall) => void;
    onUndoRevert?: (tc: ToolCall) => void;
    isReverted?: boolean;
    // Track which individual edits are reverted (for grouped)
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

  const fileExt = $derived.by(() => {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ext;
  });

  // Check if a specific tool call can be reverted
  function canRevertEdit(tc: ToolCall): boolean {
    if (tc.status !== 'completed') return false;
    if (revertedIds.has(tc.id)) return false;
    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    return typeof fileEdit?.beforeContent === 'string';
  }

  // Check if a specific tool call can show diff
  function canViewDiffEdit(tc: ToolCall): boolean {
    if (tc.status !== 'completed') return false;
    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    return typeof fileEdit?.beforeContent === 'string';
  }

  const canRevert = $derived(allToolCalls.some(tc => canRevertEdit(tc)));
  const canViewDiffAny = $derived(allToolCalls.some(tc => canViewDiffEdit(tc)));

  const hasAnyComplete = $derived(successCount > 0);
  const hasAnyFailed = $derived(failedCount > 0);
  const isAllRunning = $derived(runningCount > 0 && successCount === 0 && failedCount === 0);
  const isAllFailed = $derived(failedCount > 0 && successCount === 0);

  function getSingleEditText(tc: ToolCall): string {
    if (revertedIds.has(tc.id)) return 'Reverted';
    if (tc.status === 'failed') return 'Failed to edit';
    if (tc.status === 'running') return 'Editing';
    
    switch (tc.name) {
      case 'write_file':
        const meta = tc.meta as Record<string, unknown> | undefined;
        const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
        return fileEdit?.isNewFile ? 'Created' : 'Accepted edits to';
      case 'str_replace':
      case 'apply_edit':
        return 'Accepted edits to';
      case 'append_file':
        return 'Appended to';
      case 'create_file':
        return 'Created';
      default:
        return 'Modified';
    }
  }

  const headerText = $derived.by(() => {
    if (isReverted) return `Reverted ${totalCount} edits to`;
    if (isAllRunning) return `Editing`;
    if (isAllFailed) return `${totalCount} edits failed to`;
    if (!isGrouped) return getSingleEditText(toolCall);
    
    if (hasAnyFailed && hasAnyComplete) {
      return `${successCount}/${totalCount} edits to`;
    }
    return `${totalCount} edits to`;
  });

  const firstError = $derived.by(() => {
    const failed = allToolCalls.find(tc => tc.status === 'failed' && tc.error);
    return failed?.error;
  });

  // Get error count from meta (for showing in UI)
  const errorCount = $derived.by(() => {
    let total = 0;
    for (const tc of allToolCalls) {
      const meta = tc.meta as Record<string, unknown> | undefined;
      const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
      const count = fileEdit?.errorCount as number | undefined;
      if (typeof count === 'number') total += count;
    }
    return total;
  });
</script>

<div class="file-edit-card" class:failed={isAllFailed} class:partial-fail={hasAnyFailed && hasAnyComplete} class:running={isAllRunning} class:reverted={isReverted} class:grouped={isGrouped}>
  <!-- Main header row -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="card-header" class:expandable={isGrouped} onclick={isGrouped ? () => isExpanded = !isExpanded : undefined} role={isGrouped ? "button" : undefined}>
    {#if isGrouped}
      <button class="expand-btn" type="button" tabindex="-1">
        <UIIcon name={isExpanded ? "chevron-down" : "chevron-right"} size={12} />
      </button>
    {:else}
      <span class="status-icon" class:success={hasAnyComplete && !isAllFailed && !isReverted}>
        {#if isAllRunning}
          <UIIcon name="spinner" size={14} />
        {:else if isAllFailed}
          <UIIcon name="error" size={14} />
        {:else if isReverted}
          <UIIcon name="undo" size={14} />
        {:else}
          <UIIcon name="check" size={14} />
        {/if}
      </span>
    {/if}

    <span class="action-text">{headerText}</span>

    <span class="file-badge" data-ext={fileExt}>
      <UIIcon name="file" size={12} />
      <span class="file-name">{filename}</span>
    </span>

    {#if errorCount > 0}
      <span class="error-badge" title="{errorCount} error{errorCount > 1 ? 's' : ''} found">
        <UIIcon name="warning" size={10} />
        <span>{errorCount}</span>
      </span>
    {/if}

    <span class="spacer"></span>

    <!-- Header action buttons (for non-grouped or grouped header) -->
    {#if !isGrouped && hasAnyComplete && !isAllFailed}
      {#if isReverted}
        {#if onUndoRevert}
          <button class="action-btn undo-revert" onclick={(e) => { e.stopPropagation(); onUndoRevert(toolCall); }} type="button" title="Restore AI changes">
            <UIIcon name="redo" size={12} />
          </button>
        {/if}
      {:else}
        {#if canViewDiffAny && onViewDiff}
          <button class="action-btn view-diff" onclick={(e) => { e.stopPropagation(); onViewDiff(toolCall); }} type="button" title="View diff">
            <UIIcon name="replace" size={12} />
          </button>
        {/if}
        {#if canRevert && onRevert}
          <button class="action-btn revert" onclick={(e) => { e.stopPropagation(); onRevert(toolCall); }} type="button" title="Revert changes">
            <UIIcon name="undo" size={12} />
          </button>
        {/if}
      {/if}
    {/if}
  </div>

  <!-- Expanded content for grouped edits -->
  {#if isGrouped && isExpanded}
    <div class="grouped-edits">
      {#each allToolCalls as tc (tc.id)}
        {@const isEditReverted = revertedIds.has(tc.id)}
        <div class="edit-item" class:failed={tc.status === 'failed'} class:running={tc.status === 'running'} class:reverted={isEditReverted}>
          <span class="edit-status">
            {#if tc.status === 'running'}
              <UIIcon name="spinner" size={12} />
            {:else if tc.status === 'failed'}
              <UIIcon name="error" size={12} />
            {:else if isEditReverted}
              <UIIcon name="undo" size={12} />
            {:else}
              <UIIcon name="check" size={12} />
            {/if}
          </span>
          <span class="edit-text">{getSingleEditText(tc)}</span>
          <span class="edit-file">{filename}</span>
          
          <span class="edit-spacer"></span>
          
          <!-- Individual edit action buttons -->
          {#if tc.status === 'completed'}
            {#if isEditReverted}
              {#if onUndoRevert}
                <button class="edit-action-btn undo" onclick={() => onUndoRevert(tc)} type="button" title="Restore this edit">
                  <UIIcon name="redo" size={10} />
                </button>
              {/if}
            {:else}
              {#if canViewDiffEdit(tc) && onViewDiff}
                <button class="edit-action-btn diff" onclick={() => onViewDiff(tc)} type="button" title="View diff">
                  <UIIcon name="replace" size={10} />
                </button>
              {/if}
              {#if canRevertEdit(tc) && onRevert}
                <button class="edit-action-btn revert" onclick={() => onRevert(tc)} type="button" title="Revert this edit">
                  <UIIcon name="undo" size={10} />
                </button>
              {/if}
            {/if}
          {/if}
          
          {#if tc.status === 'failed' && tc.error}
            <div class="edit-error">{tc.error.split('\n')[0]}</div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Error summary for non-grouped failed edits -->
  {#if !isGrouped && isAllFailed && firstError}
    <div class="error-message">{firstError}</div>
  {/if}
</div>

<style>
  .file-edit-card {
    margin: 8px 0;
    border-radius: 6px;
    background: var(--color-surface0);
    border: 1px solid var(--color-success);
    overflow: hidden;
  }

  .file-edit-card.grouped {
    border-color: var(--color-border);
  }

  .file-edit-card.failed {
    border-color: var(--color-error);
  }

  .file-edit-card.partial-fail {
    border-color: var(--color-warning);
  }

  .file-edit-card.running {
    border-color: var(--color-accent);
  }

  .file-edit-card.reverted {
    border-color: var(--color-warning);
    opacity: 0.7;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
  }

  .card-header.expandable {
    cursor: pointer;
  }

  .card-header.expandable:hover {
    background: var(--color-hover);
  }

  .expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    background: transparent;
    transition: all 0.15s ease;
    pointer-events: none;
  }

  .status-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
  }

  .status-icon.success {
    color: var(--color-success);
  }

  .file-edit-card.failed .status-icon {
    color: var(--color-error);
  }

  .file-edit-card.running .status-icon {
    color: var(--color-accent);
  }

  .file-edit-card.running .status-icon :global(svg) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .action-text {
    font-size: 12px;
    color: var(--color-text);
  }

  .file-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--color-surface1);
    font-size: 11px;
    font-family: monospace;
    color: var(--color-text);
  }

  .file-badge[data-ext="ts"],
  .file-badge[data-ext="tsx"] {
    background: color-mix(in srgb, #3178c6 20%, var(--color-surface1));
    color: #3178c6;
  }

  .file-badge[data-ext="js"],
  .file-badge[data-ext="jsx"] {
    background: color-mix(in srgb, #f7df1e 15%, var(--color-surface1));
    color: #f7df1e;
  }

  .file-badge[data-ext="svelte"] {
    background: color-mix(in srgb, #ff3e00 15%, var(--color-surface1));
    color: #ff3e00;
  }

  .file-badge[data-ext="css"],
  .file-badge[data-ext="scss"] {
    background: color-mix(in srgb, #264de4 15%, var(--color-surface1));
    color: #264de4;
  }

  .file-badge[data-ext="json"] {
    background: color-mix(in srgb, #cbcb41 15%, var(--color-surface1));
    color: #cbcb41;
  }

  .file-name {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--color-error) 20%, transparent);
    color: var(--color-error);
    font-size: 10px;
    font-weight: 500;
  }

  .error-badge :global(svg) {
    flex-shrink: 0;
  }

  .spacer {
    flex: 1;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-text-secondary);
    background: transparent;
    transition: all 0.15s ease;
  }

  .action-btn:hover {
    background: var(--color-surface1);
    color: var(--color-text);
  }

  .action-btn.view-diff {
    color: var(--color-accent);
  }

  .action-btn.view-diff:hover {
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  }

  .action-btn.revert:hover {
    background: color-mix(in srgb, var(--color-warning) 15%, transparent);
    color: var(--color-warning);
  }

  .action-btn.undo-revert {
    color: var(--color-success);
  }

  .action-btn.undo-revert:hover {
    background: color-mix(in srgb, var(--color-success) 15%, transparent);
  }

  /* Grouped edits dropdown */
  .grouped-edits {
    border-top: 1px solid var(--color-border);
    padding: 4px 8px 8px 32px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .edit-item {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 4px;
    background: var(--color-surface0);
    border: 1px solid var(--color-success);
    font-size: 11px;
  }

  .edit-item.failed {
    border-color: var(--color-error);
  }

  .edit-item.running {
    border-color: var(--color-accent);
  }

  .edit-item.reverted {
    border-color: var(--color-warning);
    opacity: 0.7;
  }

  .edit-status {
    display: flex;
    color: var(--color-success);
  }

  .edit-item.failed .edit-status {
    color: var(--color-error);
  }

  .edit-item.running .edit-status {
    color: var(--color-accent);
  }

  .edit-item.reverted .edit-status {
    color: var(--color-warning);
  }

  .edit-item.running .edit-status :global(svg) {
    animation: spin 1s linear infinite;
  }

  .edit-text {
    color: var(--color-text);
  }

  .edit-file {
    color: var(--color-text-secondary);
    font-family: monospace;
  }

  .edit-spacer {
    flex: 1;
  }

  .edit-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    background: transparent;
    transition: all 0.15s ease;
  }

  .edit-action-btn:hover {
    background: var(--color-surface1);
    color: var(--color-text);
  }

  .edit-action-btn.diff {
    color: var(--color-accent);
  }

  .edit-action-btn.diff:hover {
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  }

  .edit-action-btn.revert:hover {
    background: color-mix(in srgb, var(--color-warning) 15%, transparent);
    color: var(--color-warning);
  }

  .edit-action-btn.undo {
    color: var(--color-success);
  }

  .edit-action-btn.undo:hover {
    background: color-mix(in srgb, var(--color-success) 15%, transparent);
  }

  .edit-error {
    width: 100%;
    margin-top: 4px;
    padding: 4px 6px;
    background: color-mix(in srgb, var(--color-error) 10%, transparent);
    border-radius: 3px;
    color: var(--color-error);
    font-size: 10px;
    font-family: monospace;
  }

  .error-message {
    padding: 8px 12px;
    font-size: 11px;
    color: var(--color-error);
    background: color-mix(in srgb, var(--color-error) 10%, var(--color-bg));
    border-top: 1px solid var(--color-border);
    font-family: monospace;
    white-space: pre-wrap;
  }
</style>
