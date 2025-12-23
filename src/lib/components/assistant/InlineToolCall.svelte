<script lang="ts">
  /**
   * InlineToolCall - Displays tool activity inline within assistant messages
   * Shows tool name, status, and expandable output like Kiro's UI
   * Supports streaming progress for file write operations
   */
  import { UIIcon, type UIIconName } from '$lib/components/ui';
  import type { ToolCall, ToolCallStatus, StreamingProgress } from '$lib/stores/assistant.svelte';

  interface Props {
    toolCall: ToolCall;
    /** Streaming progress for file write tools */
    streamingProgress?: StreamingProgress | null;
    onApprove?: () => void;
    onDeny?: () => void;
    onAcceptEdit?: (() => void) | null;
    onRejectEdit?: (() => void) | null;
  }

  let { toolCall, streamingProgress, onApprove, onDeny, onAcceptEdit, onRejectEdit }: Props = $props();

  let expanded = $state(false);

  // Tool display names (more user-friendly)
  const toolDisplayNames: Record<string, string> = {
    list_dir: 'List directory',
    read_file: 'Read file(s)',
    get_file_info: 'Get file info',
    workspace_search: 'Search workspace',
    get_active_file: 'Get active file',
    get_selection: 'Get selection',
    get_open_files: 'Get open files',
    write_file: 'Write file',
    create_file: 'Create file',
    create_dir: 'Create directory',
    delete_path: 'Delete',
    rename_path: 'Rename',
    run_command: 'Run command',
    terminal_create: 'Create terminal',
    terminal_write: 'Execute in terminal',
    terminal_kill: 'Kill terminal',
    terminal_get_output: 'Get terminal output',
    run_check: 'Run check'
  };

  // Tool icons - using valid UIIconName values
  const toolIcons: Record<string, UIIconName> = {
    list_dir: 'folder',
    read_file: 'file',
    get_file_info: 'info',
    workspace_search: 'search',
    get_active_file: 'file',
    get_selection: 'code',
    get_open_files: 'files',
    write_file: 'pencil',
    create_file: 'file-plus',
    create_dir: 'folder-plus',
    delete_path: 'trash',
    rename_path: 'pencil',
    run_command: 'terminal',
    terminal_create: 'terminal',
    terminal_write: 'terminal',
    terminal_kill: 'close',
    terminal_get_output: 'terminal',
    run_check: 'check'
  };

  const statusIcons: Record<ToolCallStatus, UIIconName> = {
    pending: 'clock',
    running: 'spinner',
    completed: 'check',
    failed: 'error',
    cancelled: 'close'
  };

  // Get display name for tool
  function getToolDisplayName(): string {
    return toolDisplayNames[toolCall.name] ?? toolCall.name;
  }

  // Get icon for tool
  function getToolIcon(): UIIconName {
    return toolIcons[toolCall.name] ?? 'code';
  }

  // Get summary of what the tool is doing
  function getToolSummary(): string {
    const args = toolCall.arguments;
    const resultMeta = toolCall.meta as Record<string, unknown> | undefined;
    
    switch (toolCall.name) {
      case 'list_dir':
        return args.path ? String(args.path) : '.';
      case 'read_file': {
        const filename = args.path ? String(args.path).split('/').pop() ?? String(args.path) : '';
        // Use result meta for actual lines read (more accurate than args)
        if (resultMeta?.startLine && resultMeta?.endLine) {
          const start = Number(resultMeta.startLine);
          const end = Number(resultMeta.endLine);
          const total = resultMeta.totalLines ? Number(resultMeta.totalLines) : null;
          if (start === 1 && end === total) {
            // Full file read
            return `${filename} (${total} lines)`;
          }
          return `${filename} ${start} - ${end}`;
        }
        // Fallback to args if result meta not available yet
        const startLine = args.startLine ? Number(args.startLine) : null;
        const endLine = args.endLine ? Number(args.endLine) : null;
        if (startLine && endLine) {
          return `${filename} ${startLine} - ${endLine}`;
        } else if (startLine) {
          return `${filename} ${startLine}+`;
        } else if (endLine) {
          return `${filename} 1 - ${endLine}`;
        }
        return filename;
      }
      case 'read_files': {
        const paths = args.paths as string[] | undefined;
        if (!paths || paths.length === 0) return '';
        const names = paths.map(p => String(p).split('/').pop() ?? p);
        // Add total lines from result meta if available
        const totalLines = resultMeta?.totalLines ? Number(resultMeta.totalLines) : null;
        const suffix = totalLines ? ` (${totalLines} lines)` : '';
        if (names.length === 1) return names[0] + suffix;
        if (names.length === 2) return `${names[0]}, ${names[1]}${suffix}`;
        return `${names[0]} +${names.length - 1} more${suffix}`;
      }
      case 'workspace_search':
        return args.query ? `"${String(args.query)}"` : '';
      case 'write_file':
      case 'create_file':
        return args.path ? String(args.path).split('/').pop() ?? String(args.path) : '';
      case 'create_dir':
        return args.path ? String(args.path) : '';
      case 'delete_path':
        return args.path ? String(args.path).split('/').pop() ?? String(args.path) : '';
      case 'rename_path':
        return args.oldPath ? `${String(args.oldPath).split('/').pop()} → ${String(args.newPath).split('/').pop()}` : '';
      case 'run_command':
        return args.command ? String(args.command).slice(0, 50) : '';
      case 'terminal_write':
        return args.command ? String(args.command).slice(0, 40) : '';
      case 'run_check':
        return args.checkType ? String(args.checkType) : '';
      default:
        return '';
    }
  }

  // Get meta info if available
  function getMeta(): { why?: string; risk?: string; undo?: string } | null {
    const meta = toolCall.arguments.meta as Record<string, unknown> | undefined;
    if (!meta) return null;
    return {
      why: meta.why ? String(meta.why) : undefined,
      risk: meta.risk ? String(meta.risk) : undefined,
      undo: meta.undo ? String(meta.undo) : undefined
    };
  }

  const meta = $derived(getMeta());
  const summary = $derived(getToolSummary());
  const isRunning = $derived(toolCall.status === 'running');
  const isPending = $derived(toolCall.status === 'pending' && toolCall.requiresApproval);
  const isComplete = $derived(toolCall.status === 'completed');
  const isFailed = $derived(toolCall.status === 'failed');

  const isReviewPending = $derived(toolCall.reviewStatus === 'pending');

  const hasRevert = $derived.by(() => {
    const metaAny = toolCall.meta as any;
    const before = metaAny?.fileEdit?.beforeContent;
    return typeof before === 'string' && before.length > 0;
  });
  
  // Check if this is a file write tool that supports streaming
  const isFileWriteTool = $derived(
    toolCall.name === 'write_file' ||
    toolCall.name === 'create_file' ||
    toolCall.name === 'apply_edit' ||
    toolCall.name === 'multi_replace_file_content'
  );
  const isStreaming = $derived(isFileWriteTool && isRunning && streamingProgress != null);
  
  // Format streaming progress
  function formatProgress(progress: StreamingProgress): string {
    return `${progress.linesWritten}/${progress.totalLines} lines`;
  }
</script>

<div 
  class="inline-tool-call {toolCall.status}"
  role="article"
  aria-label="Tool: {getToolDisplayName()}"
>
  <button
    class="tool-header"
    onclick={() => expanded = !expanded}
    aria-expanded={expanded}
    type="button"
  >
    <span class="tool-icon" class:spinning={isRunning && !isStreaming}>
      {#if isStreaming}
        <UIIcon name="pencil" size={14} />
      {:else if isRunning}
        <UIIcon name="spinner" size={14} />
      {:else}
        <UIIcon name={getToolIcon()} size={14} />
      {/if}
    </span>
    
    <span class="tool-name">{getToolDisplayName()}</span>
    
    {#if isStreaming && streamingProgress}
      <span class="tool-progress">
        <span class="progress-text">{formatProgress(streamingProgress)}</span>
        <span class="progress-bar">
          <span class="progress-fill" style="width: {streamingProgress.percent}%"></span>
        </span>
      </span>
    {:else if summary}
      <span class="tool-summary">{summary}</span>
    {/if}
    
    <span class="tool-status-icon">
      {#if isStreaming}
        <span class="streaming-indicator"></span>
      {:else if isRunning}
        <!-- Already showing spinner in tool-icon -->
      {:else if isComplete}
        <UIIcon name="check" size={12} />
      {:else if isFailed}
        <UIIcon name="error" size={12} />
      {:else if isPending}
        <UIIcon name="clock" size={12} />
      {/if}
    </span>
    
    <span class="expand-icon" class:expanded>
      <UIIcon name="chevron-down" size={12} />
    </span>
  </button>

  {#if isPending && onApprove && onDeny}
    <div class="approval-bar">
      {#if meta?.why}
        <span class="approval-reason">{meta.why}</span>
      {/if}
      <div class="approval-actions">
        <button
          class="approve-btn"
          onclick={onApprove}
          type="button"
        >
          <UIIcon name="check" size={12} />
          Approve
        </button>
        <button
          class="deny-btn"
          onclick={onDeny}
          type="button"
        >
          <UIIcon name="close" size={12} />
          Deny
        </button>
      </div>
    </div>
  {/if}

  {#if isComplete && isFileWriteTool && isReviewPending && hasRevert}
    <div class="approval-bar">
      <span class="approval-reason">Review edit</span>
      <div class="approval-actions">
        <button class="approve-btn" onclick={onAcceptEdit} type="button">
          <UIIcon name="check" size={12} />
          Accept
        </button>
        <button class="deny-btn" onclick={onRejectEdit} type="button">
          <UIIcon name="close" size={12} />
          Reject
        </button>
      </div>
    </div>
  {/if}

  {#if expanded}
    <div class="tool-details">
      {#if meta?.why && !isPending}
        <div class="detail-row">
          <span class="detail-label">Why:</span>
          <span class="detail-value">{meta.why}</span>
        </div>
      {/if}
      
      {#if meta?.risk}
        <div class="detail-row">
          <span class="detail-label">Risk:</span>
          <span class="detail-value risk-{meta.risk}">{meta.risk}</span>
        </div>
      {/if}
      
      {#if toolCall.output}
        <div class="detail-section">
          <span class="detail-label">Output:</span>
          <pre class="detail-output">{toolCall.output}</pre>
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
  .inline-tool-call {
    margin: 8px 0;
    border-radius: 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    overflow: hidden;
    font-size: 12px;
  }

  .inline-tool-call.running {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface0));
  }

  .inline-tool-call.completed {
    border-color: var(--color-success);
  }

  .inline-tool-call.failed {
    border-color: var(--color-error);
  }

  .inline-tool-call.pending {
    border-color: var(--color-warning);
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    color: var(--color-text);
    transition: background 0.15s ease;
  }

  .tool-header:hover {
    background: var(--color-hover);
  }

  .tool-icon {
    display: flex;
    align-items: center;
    color: var(--color-accent);
    flex-shrink: 0;
  }

  .tool-icon.spinning :global(svg) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .tool-name {
    font-weight: 500;
    color: var(--color-text);
  }

  .tool-summary {
    color: var(--color-text-secondary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: monospace;
    font-size: 11px;
  }

  .tool-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .progress-text {
    font-size: 10px;
    color: var(--color-accent);
    font-family: monospace;
    white-space: nowrap;
  }

  .progress-bar {
    flex: 1;
    height: 3px;
    background: var(--color-surface1);
    border-radius: 2px;
    overflow: hidden;
    min-width: 40px;
    max-width: 100px;
  }

  .progress-fill {
    height: 100%;
    background: var(--color-accent);
    border-radius: 2px;
    transition: width 0.1s ease-out;
  }

  .streaming-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: pulse-stream 1s ease-in-out infinite;
  }

  @keyframes pulse-stream {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
  }

  .tool-status-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .completed .tool-status-icon {
    color: var(--color-success);
  }

  .failed .tool-status-icon {
    color: var(--color-error);
  }

  .pending .tool-status-icon {
    color: var(--color-warning);
  }

  .expand-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }

  .expand-icon.expanded {
    transform: rotate(180deg);
  }

  .approval-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg));
    border-top: 1px solid var(--color-border);
  }

  .approval-reason {
    color: var(--color-text-secondary);
    font-size: 11px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .approval-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .approve-btn,
  .deny-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
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
    background: var(--color-surface1);
    color: var(--color-text);
  }

  .deny-btn:hover {
    background: var(--color-error);
    color: var(--color-bg);
  }

  .tool-details {
    padding: 8px 12px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .detail-row {
    display: flex;
    gap: 8px;
    margin-bottom: 4px;
  }

  .detail-row:last-child {
    margin-bottom: 0;
  }

  .detail-section {
    margin-top: 8px;
  }

  .detail-section.error {
    color: var(--color-error);
  }

  .detail-label {
    font-size: 10px;
    font-weight: 500;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .detail-value {
    font-size: 11px;
    color: var(--color-text);
  }

  .detail-value.risk-low {
    color: var(--color-success);
  }

  .detail-value.risk-medium {
    color: var(--color-warning);
  }

  .detail-value.risk-high {
    color: var(--color-error);
  }

  .detail-output {
    font-size: 11px;
    font-family: monospace;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 4px 0 0 0;
    padding: 8px;
    background: var(--color-surface0);
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
