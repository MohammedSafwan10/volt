<script lang="ts">
  /**
   * InlineToolCall - Displays tool activity inline within assistant messages
   * Shows tool name, status, and expandable output like Kiro's UI
   * Supports streaming progress for file write operations
   * 
   * Kiro-style: Only shows approval for the FIRST pending terminal command
   */
  import { UIIcon, type UIIconName } from '$lib/components/ui';
  import type { ToolCall, ToolCallStatus, StreamingProgress } from '$lib/stores/assistant.svelte';

  interface Props {
    toolCall: ToolCall;
    /** Streaming progress for file write tools */
    streamingProgress?: StreamingProgress | null;
    onApprove?: () => void;
    onDeny?: () => void;
    /** For terminal commands: is this the first pending one? (Kiro-style sequential approval) */
    isFirstPendingTerminal?: boolean;
  }

  let { toolCall, streamingProgress, onApprove, onDeny, isFirstPendingTerminal = true }: Props = $props();

  let expanded = $state(false);
  
  // Auto-expand when screenshot data arrives
  $effect(() => {
    if (toolCall.name === 'browser_screenshot' && toolCall.data?.image_base64 && !expanded) {
      expanded = true;
    }
  });

  // Format output with clickable URLs (global handler in layout opens them in browser)
  function formatOutputWithLinks(text: string): string {
    return text.replace(
      /(https?:\/\/[^\s<>"']+)/gi,
      '<a href="$1" class="output-link">$1</a>'
    );
  }

  // Tool display names (more user-friendly)
  const toolDisplayNames: Record<string, string> = {
    // Context & Search
    gather_context: 'Gathering context',
    workspace_search: 'Searched workspace',
    list_dir: 'Listed directory',
    read_file: 'Read file',
    read_files: 'Read files',
    get_file_info: 'Got file info',
    get_file_tree: 'Got file tree',
    find_files: 'Found files',
    search_symbols: 'Searched symbols',
    // Editor
    get_active_file: 'Got active file',
    get_selection: 'Got selection',
    get_open_files: 'Got open files',
    // File operations
    write_file: 'Wrote file',
    append_file: 'Appended to file',
    str_replace: 'Edited file',
    apply_edit: 'Edited file',
    create_file: 'Created file',
    create_dir: 'Created directory',
    delete_file: 'Deleted file',
    delete_path: 'Deleted',
    rename_path: 'Renamed',
    // Terminal - cleaner names
    run_command: 'Run command',
    start_process: 'Start process',
    stop_process: 'Stopped process',
    list_processes: 'Listed processes',
    get_process_output: 'Got process output',
    terminal_create: 'Created terminal',
    terminal_write: 'Executed command',
    terminal_kill: 'Killed terminal',
    terminal_get_output: 'Got terminal output',
    read_terminal: 'Read terminal',
    // Diagnostics
    run_check: 'Ran check',
    get_diagnostics: 'Got diagnostics'
  };

  // Tool icons - using valid UIIconName values
  const toolIcons: Record<string, UIIconName> = {
    // Context & Search
    gather_context: 'search',
    workspace_search: 'search',
    list_dir: 'folder',
    read_file: 'file',
    read_files: 'files',
    get_file_info: 'info',
    get_file_tree: 'files',
    find_files: 'search',
    search_symbols: 'symbol-class',
    // Editor
    get_active_file: 'file',
    get_selection: 'code',
    get_open_files: 'files',
    // File operations
    write_file: 'pencil',
    append_file: 'file-plus',
    str_replace: 'pencil',
    apply_edit: 'pencil',
    create_file: 'file-plus',
    create_dir: 'folder-plus',
    delete_file: 'trash',
    delete_path: 'trash',
    rename_path: 'pencil',
    // Terminal
    run_command: 'terminal',
    start_process: 'play',
    stop_process: 'stop',
    list_processes: 'files',
    get_process_output: 'terminal',
    terminal_create: 'terminal',
    terminal_write: 'terminal',
    terminal_kill: 'close',
    terminal_get_output: 'terminal',
    read_terminal: 'terminal',
    // Diagnostics
    run_check: 'check',
    get_diagnostics: 'warning'
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
      case 'workspace_search': {
        const query = args.query ? String(args.query) : '';
        const pattern = args.includePattern ? ` in ${String(args.includePattern)}` : '';
        return query ? `"${query}"${pattern}` : '';
      }
      case 'write_file':
      case 'append_file':
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
      case 'start_process':
        return args.command ? String(args.command).slice(0, 50) : '';
      case 'stop_process':
        return args.processId ? `Process ${args.processId}` : '';
      case 'get_process_output':
        return args.processId ? `Process ${args.processId}` : '';
      case 'list_processes':
        return '';
      case 'terminal_write':
        return args.command ? String(args.command).slice(0, 40) : '';
      case 'get_diagnostics': {
        // Show which files were checked (Kiro-style)
        const paths = args.paths as string[] | undefined;
        if (!paths || paths.length === 0) return 'all files';
        const names = paths.map(p => String(p).split('/').pop() ?? p);
        if (names.length === 1) return names[0];
        if (names.length === 2) return `${names[0]}, ${names[1]}`;
        return `${names[0]} +${names.length - 1} more`;
      }
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
  
  // Check if this is a terminal command tool
  const isTerminalTool = $derived(
    toolCall.name === 'run_command' ||
    toolCall.name === 'start_process' ||
    toolCall.name === 'terminal_write'
  );
  
  // For terminal commands, only show approval if this is the first pending one (Kiro-style)
  const shouldShowApproval = $derived(
    isPending && onApprove && onDeny && (
      !isTerminalTool || isFirstPendingTerminal
    )
  );
  
  // Get the command for terminal tools
  const terminalCommand = $derived(
    isTerminalTool ? String(toolCall.arguments.command || '') : ''
  );
  
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
  class:terminal-tool={isTerminalTool}
  role="article"
  aria-label="Tool: {getToolDisplayName()}"
>
  {#if isTerminalTool}
    <!-- Special terminal-style display -->
    <button
      class="tool-header terminal-header"
      onclick={() => expanded = !expanded}
      aria-expanded={expanded}
      type="button"
    >
      <span class="terminal-prompt">
        <UIIcon name="terminal" size={14} />
        <span class="prompt-symbol">$</span>
      </span>
      <span class="terminal-command">{terminalCommand || 'command'}</span>
      <span class="tool-status-icon">
        {#if isRunning}
          <span class="terminal-running-indicator"></span>
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
  {:else}
    <!-- Standard tool display -->
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
  {/if}

  {#if shouldShowApproval}
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
  {:else if isPending && isTerminalTool && !isFirstPendingTerminal}
    <!-- Queued terminal command - waiting for previous to complete -->
    <div class="queued-bar">
      <UIIcon name="clock" size={12} />
      <span>Queued - waiting for previous command</span>
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
          <pre class="detail-output">{@html formatOutputWithLinks(toolCall.output)}</pre>
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
  .inline-tool-call {
    margin: 8px 0;
    border-radius: 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    overflow: hidden;
    font-size: 12px;
  }

  /* Terminal tool special styling */
  .inline-tool-call.terminal-tool {
    background: var(--color-bg);
    border-color: var(--color-border);
  }

  .inline-tool-call.terminal-tool.running {
    border-color: var(--color-accent);
  }

  .inline-tool-call.terminal-tool.completed {
    border-color: var(--color-success);
  }

  .inline-tool-call.terminal-tool.failed {
    border-color: var(--color-error);
  }

  .inline-tool-call.terminal-tool.pending {
    border-color: var(--color-warning);
  }

  .terminal-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 10px 12px;
    text-align: left;
    color: var(--color-text);
    background: var(--color-surface0);
    font-family: var(--font-mono, 'Fira Code', 'Consolas', monospace);
  }

  .terminal-header:hover {
    background: var(--color-hover);
  }

  .terminal-prompt {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--color-success);
    flex-shrink: 0;
  }

  .prompt-symbol {
    font-weight: 600;
    font-size: 13px;
  }

  .terminal-command {
    flex: 1;
    font-size: 12px;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .terminal-running-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: terminal-pulse 1s ease-in-out infinite;
  }

  @keyframes terminal-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
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

  .queued-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--color-surface0);
    border-top: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: 11px;
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

  .detail-output :global(.output-link) {
    color: var(--color-accent);
    text-decoration: underline;
    cursor: pointer;
  }

  .detail-output :global(.output-link:hover) {
    color: var(--color-accent);
    text-decoration: underline;
    opacity: 0.8;
  }

  .screenshot-container {
    margin-top: 8px;
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
