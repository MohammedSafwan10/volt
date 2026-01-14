<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import type { ToolCall, ToolCallStatus } from '$lib/stores/assistant.svelte';

  interface Props {
    toolCall: ToolCall;
    onApprove: () => void;
    onDeny: () => void;
  }

  let { toolCall, onApprove, onDeny }: Props = $props();

  let expanded = $state(false);
  
  // Auto-expand when screenshot data arrives
  $effect(() => {
    if (toolCall.name === 'browser_screenshot' && toolCall.data?.image_base64 && !expanded) {
      expanded = true;
    }
  });

  const statusIcons: Record<ToolCallStatus, 'spinner' | 'check' | 'error' | 'close' | 'clock'> = {
    pending: 'clock',
    running: 'spinner',
    completed: 'check',
    failed: 'error',
    cancelled: 'close'
  };

  const statusLabels: Record<ToolCallStatus, string> = {
    pending: 'Pending approval',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled'
  };

  function formatDuration(start?: number, end?: number): string {
    if (!start) return '';
    const endTime = end ?? Date.now();
    const ms = endTime - start;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatArguments(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return '(no arguments)';
    return entries
      .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 30)}`)
      .join(', ');
  }
</script>

<div 
  class="tool-call-row {toolCall.status}"
  role="article"
  aria-label="Tool call: {toolCall.name}"
>
  <div class="tool-header">
    <button
      class="expand-btn"
      onclick={() => expanded = !expanded}
      aria-expanded={expanded}
      aria-label={expanded ? 'Collapse' : 'Expand'}
      type="button"
    >
      <UIIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
    </button>
    
    <span class="tool-icon">
      <UIIcon name={statusIcons[toolCall.status]} size={14} />
    </span>
    
    <span class="tool-name">{toolCall.name}</span>
    
    <span class="tool-status">{statusLabels[toolCall.status]}</span>
    
    {#if toolCall.startTime}
      <span class="tool-duration">
        {formatDuration(toolCall.startTime, toolCall.endTime)}
      </span>
    {/if}

    {#if toolCall.requiresApproval && toolCall.status === 'pending'}
      <div class="approval-actions">
        <button
          class="approve-btn"
          onclick={onApprove}
          title="Approve"
          aria-label="Approve tool execution"
          type="button"
        >
          <UIIcon name="check" size={12} />
          <span>Approve</span>
        </button>
        <button
          class="deny-btn"
          onclick={onDeny}
          title="Deny"
          aria-label="Deny tool execution"
          type="button"
        >
          <UIIcon name="close" size={12} />
          <span>Deny</span>
        </button>
      </div>
    {/if}
  </div>

  {#if expanded}
    <div class="tool-details">
      <div class="detail-section">
        <span class="detail-label">Arguments:</span>
        <code class="detail-value">{formatArguments(toolCall.arguments)}</code>
      </div>
      
      {#if toolCall.output}
        <div class="detail-section">
          <span class="detail-label">Output:</span>
          <pre class="detail-output">{toolCall.output}</pre>
        </div>
      {/if}
      
      {#if toolCall.data?.image_base64}
        <div class="detail-section">
          <span class="detail-label">Screenshot:</span>
          <div class="screenshot-container">
            <img 
              src="data:image/png;base64,{toolCall.data.image_base64}" 
              alt="Browser screenshot"
              class="screenshot-image"
            />
          </div>
        </div>
      {/if}
      
      {#if toolCall.error}
        <div class="detail-section error">
          <span class="detail-label">Error:</span>
          <pre class="detail-output">{toolCall.error}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-call-row {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    margin-bottom: 6px;
    overflow: hidden;
  }

  .tool-call-row.running {
    border-color: var(--color-accent);
  }

  .tool-call-row.completed {
    border-color: var(--color-success);
  }

  .tool-call-row.failed {
    border-color: var(--color-error);
  }

  .tool-call-row.cancelled {
    opacity: 0.7;
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    font-size: 12px;
  }

  .expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 3px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .expand-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .tool-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
  }

  .running .tool-icon {
    color: var(--color-accent);
  }

  .running .tool-icon :global(svg) {
    animation: spin 1s linear infinite;
  }

  .completed .tool-icon {
    color: var(--color-success);
  }

  .failed .tool-icon {
    color: var(--color-error);
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .tool-name {
    font-weight: 500;
    color: var(--color-text);
    font-family: monospace;
  }

  .tool-status {
    color: var(--color-text-secondary);
    margin-left: auto;
  }

  .tool-duration {
    color: var(--color-text-disabled);
    font-size: 11px;
  }

  .approval-actions {
    display: flex;
    gap: 4px;
    margin-left: 8px;
  }

  .approve-btn,
  .deny-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .approve-btn {
    background: var(--color-success);
    color: var(--color-bg);
  }

  .approve-btn:hover {
    filter: brightness(1.1);
  }

  .deny-btn {
    background: var(--color-surface0);
    color: var(--color-text);
  }

  .deny-btn:hover {
    background: var(--color-error);
    color: var(--color-bg);
  }

  .tool-details {
    padding: 8px 10px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-sidebar);
  }

  .detail-section {
    margin-bottom: 8px;
  }

  .detail-section:last-child {
    margin-bottom: 0;
  }

  .detail-section.error {
    color: var(--color-error);
  }

  .detail-label {
    display: block;
    font-size: 10px;
    font-weight: 500;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }

  .detail-value {
    font-size: 11px;
    color: var(--color-text);
    word-break: break-all;
  }

  .detail-output {
    font-size: 11px;
    font-family: monospace;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    max-height: 150px;
    overflow-y: auto;
  }

  .screenshot-container {
    margin-top: 4px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--color-border);
  }

  .screenshot-image {
    display: block;
    max-width: 100%;
    height: auto;
    max-height: 300px;
    object-fit: contain;
    background: var(--color-bg);
  }
</style>
