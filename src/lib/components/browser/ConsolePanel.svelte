<script lang="ts">
  /**
   * ConsolePanel - Shows browser console logs, errors, and warnings
   * Integrated with AI for debugging assistance
   */
  import { UIIcon } from '$lib/components/ui';
  import { browserDevToolsStore, type ConsoleLog, type ConsoleLogLevel } from '$lib/stores/browser-devtools.svelte';

  interface Props {
    onAskAI?: (context: string) => void;
  }

  let { onAskAI }: Props = $props();

  let filterLevel = $state<ConsoleLogLevel | 'all'>('all');
  let searchQuery = $state('');
  let autoScroll = $state(true);
  let listRef: HTMLDivElement | null = $state(null);
  let stickToBottom = $state(true);
  let lastRenderedCount = $state(0);
  let renderLimit = $state<100 | 200 | 500>(200);

  // Filter logs
  const filteredLogs = $derived(() => {
    let logs = browserDevToolsStore.consoleLogs;
    
    if (filterLevel !== 'all') {
      logs = logs.filter(l => l.level === filterLevel);
    }
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      logs = logs.filter(l => l.message.toLowerCase().includes(query));
    }
    
    return logs;
  });
  const visibleLogs = $derived(filteredLogs().slice(-renderLimit));

  function isNearBottom(el: HTMLDivElement): boolean {
    const threshold = 20;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= threshold;
  }

  function handleLogScroll(): void {
    if (!listRef) return;
    stickToBottom = isNearBottom(listRef);
  }

  // Auto-scroll to bottom when new logs arrive
  $effect(() => {
    const count = visibleLogs.length;
    const hasNewRows = count > lastRenderedCount;
    lastRenderedCount = count;

    if (autoScroll && listRef && hasNewRows && stickToBottom) {
      requestAnimationFrame(() => {
        if (listRef) {
          listRef.scrollTo({ top: listRef.scrollHeight });
        }
      });
    }
  });

  function getLevelIcon(level: ConsoleLogLevel): 'error' | 'warning' | 'info' | 'code' | 'console' {
    switch (level) {
      case 'error': return 'error';
      case 'warn': return 'warning';
      case 'info': return 'info';
      case 'debug': return 'code';
      default: return 'console';
    }
  }

  function getLevelClass(level: ConsoleLogLevel): string {
    switch (level) {
      case 'error': return 'level-error';
      case 'warn': return 'level-warn';
      case 'info': return 'level-info';
      case 'debug': return 'level-debug';
      default: return 'level-log';
    }
  }

  function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      fractionalSecondDigits: 3
    });
  }

  function handleAskAI(): void {
    if (!onAskAI) return;
    
    const errors = browserDevToolsStore.consoleLogs.filter(l => l.level === 'error');
    const warnings = browserDevToolsStore.consoleLogs.filter(l => l.level === 'warn');
    
    let context = `Browser Console Summary:\n`;
    context += `- ${errors.length} errors\n`;
    context += `- ${warnings.length} warnings\n\n`;
    
    if (errors.length > 0) {
      context += `Recent Errors:\n`;
      errors.slice(-5).forEach(e => {
        context += `- ${e.message}\n`;
        if (e.source) context += `  at ${e.source}:${e.line}\n`;
      });
    }
    
    onAskAI(context);
  }

  function handleClear(): void {
    browserDevToolsStore.clearConsoleLogs();
  }

  function toggleAutoScroll(): void {
    autoScroll = !autoScroll;
    if (!autoScroll || !listRef) return;
    requestAnimationFrame(() => {
      if (!listRef) return;
      listRef.scrollTo({ top: listRef.scrollHeight });
      stickToBottom = true;
    });
  }
</script>

<div class="console-panel">
  <!-- Toolbar -->
  <div class="console-toolbar">
    <div class="toolbar-left">
      <button class="tool-btn" title="Clear Console" onclick={handleClear}>
        <UIIcon name="trash" size={14} />
      </button>
      
      <div class="separator"></div>
      
      <select class="filter-select" bind:value={filterLevel}>
        <option value="all">All Levels</option>
        <option value="log">Log</option>
        <option value="info">Info</option>
        <option value="warn">Warnings</option>
        <option value="error">Errors</option>
        <option value="debug">Debug</option>
      </select>
      <select class="filter-select" bind:value={renderLimit} title="Visible rows">
        <option value={100}>100 rows</option>
        <option value={200}>200 rows</option>
        <option value={500}>500 rows</option>
      </select>
      
      <div class="search-box">
        <UIIcon name="search" size={12} />
        <input 
          type="text" 
          placeholder="Filter logs..." 
          bind:value={searchQuery}
        />
      </div>
    </div>
    
    <div class="toolbar-right">
      <div class="counts">
        {#if browserDevToolsStore.errorCount > 0}
          <span class="count error">
            <UIIcon name="error" size={12} />
            {browserDevToolsStore.errorCount}
          </span>
        {/if}
        {#if browserDevToolsStore.warningCount > 0}
          <span class="count warn">
            <UIIcon name="warning" size={12} />
            {browserDevToolsStore.warningCount}
          </span>
        {/if}
      </div>
      
      <button 
        class="tool-btn" 
        class:active={autoScroll}
        title="Auto-scroll"
        onclick={toggleAutoScroll}
      >
        <UIIcon name="chevron-down" size={14} />
      </button>

      <button
        class="tool-btn"
        class:active={browserDevToolsStore.isCapturing}
        title={browserDevToolsStore.isCapturing ? 'Pause capture' : 'Resume capture'}
        onclick={() => browserDevToolsStore.toggleCapturing()}
      >
        <UIIcon name={browserDevToolsStore.isCapturing ? 'pause' : 'play'} size={14} />
      </button>
      
      {#if onAskAI && browserDevToolsStore.errorCount > 0}
        <button class="ai-btn" title="Ask AI about errors" onclick={handleAskAI}>
          <UIIcon name="sparkle" size={14} />
          <span>Ask AI</span>
        </button>
      {/if}
    </div>
  </div>

  <!-- Log List -->
  <div class="console-logs" bind:this={listRef} onscroll={handleLogScroll}>
    {#if visibleLogs.length === 0}
      <div class="empty-state">
        <UIIcon name="console" size={24} />
        <span>No console logs yet</span>
        <span class="hint">Logs from the browser will appear here</span>
      </div>
    {:else}
      {#each visibleLogs as log (log.id)}
        <div class="log-entry {getLevelClass(log.level)}">
          <span class="log-icon">
            <UIIcon name={getLevelIcon(log.level)} size={12} />
          </span>
          <span class="log-time">{formatTime(log.timestamp)}</span>
          <span class="log-message">{log.message}</span>
          {#if log.source}
            <span class="log-source">{log.source}:{log.line}</span>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .console-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
  }

  .console-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: var(--color-bg-panel);
    border-bottom: 1px solid var(--color-border);
    gap: 8px;
  }

  .toolbar-left, .toolbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tool-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .tool-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .tool-btn.active {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .separator {
    width: 1px;
    height: 16px;
    background: var(--color-border);
  }

  .filter-select {
    padding: 4px 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text);
    font-size: 11px;
    cursor: pointer;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }

  .search-box input {
    background: transparent;
    border: none;
    outline: none;
    color: var(--color-text);
    font-size: 11px;
    width: 120px;
  }

  .search-box :global(.ui-icon) {
    color: var(--color-text-secondary);
  }

  .counts {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .count {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 500;
  }

  .count.error {
    background: color-mix(in srgb, var(--color-error) 20%, transparent);
    color: var(--color-error);
  }

  .count.warn {
    background: color-mix(in srgb, var(--color-warning) 20%, transparent);
    color: var(--color-warning);
  }

  .ai-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    background: var(--color-accent);
    color: var(--color-bg);
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .ai-btn:hover {
    filter: brightness(1.1);
  }

  .console-logs {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 100%;
    color: var(--color-text-secondary);
  }

  .empty-state .hint {
    font-size: 11px;
    opacity: 0.7;
  }

  .log-entry {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--color-border);
    transition: background 0.1s ease;
  }

  .log-entry:hover {
    background: var(--color-hover);
  }

  .log-icon {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .log-time {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    font-size: 10px;
    opacity: 0.7;
  }

  .log-message {
    flex: 1;
    word-break: break-word;
    white-space: pre-wrap;
    color: var(--color-text);
  }

  .log-source {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    font-size: 10px;
    opacity: 0.6;
  }

  /* Level colors */
  .level-error {
    background: color-mix(in srgb, var(--color-error) 8%, transparent);
  }

  .level-error .log-icon {
    color: var(--color-error);
  }

  .level-error .log-message {
    color: var(--color-error);
  }

  .level-warn {
    background: color-mix(in srgb, var(--color-warning) 8%, transparent);
  }

  .level-warn .log-icon {
    color: var(--color-warning);
  }

  .level-warn .log-message {
    color: var(--color-warning);
  }

  .level-info .log-icon {
    color: var(--color-accent);
  }

  .level-debug .log-icon {
    color: var(--color-text-secondary);
  }

  .level-debug .log-message {
    opacity: 0.7;
  }

  .level-log .log-icon {
    color: var(--color-text-secondary);
  }
</style>
