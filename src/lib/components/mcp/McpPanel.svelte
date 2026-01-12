<script lang="ts">
  /**
   * MCP Panel - Shows connected MCP servers and their tools
   */
  import { UIIcon } from '$lib/components/ui';
  import { mcpStore, type McpServerState } from '$lib/stores/mcp.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';
  import { assistantStore } from '$lib/stores/assistant.svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';

  let expandedServers = $state<Set<string>>(new Set());
  let configPath = $state<string>('~/.volt/settings/mcp.json');

  // Get actual config path on mount and auto-open the config file
  onMount(async () => {
    try {
      const path = await invoke<string>('get_mcp_config_path');
      configPath = path.replace(/^[A-Z]:\\Users\\[^\\]+/i, '~').replace(/\\/g, '/');
      
      // Auto-open mcp.json in editor when panel opens
      await editorStore.openFile(path);
    } catch {
      // Keep default
    }
  });

  const DEFAULT_MCP_CONFIG = `{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "env": {},
      "disabled": true,
      "autoApprove": []
    }
  }
}`;

  // Group servers by status
  const connectedServers = $derived(mcpStore.serverList.filter(s => s.status === 'connected'));
  const connectingServers = $derived(mcpStore.serverList.filter(s => s.status === 'connecting'));
  const otherServers = $derived(mcpStore.serverList.filter(s => s.status !== 'connected' && s.status !== 'connecting'));

  function toggleServer(serverId: string): void {
    if (expandedServers.has(serverId)) {
      expandedServers.delete(serverId);
    } else {
      expandedServers.add(serverId);
    }
    expandedServers = new Set(expandedServers);
  }

  function getStatusIcon(status: McpServerState['status']): 'check-circle' | 'spinner' | 'error' | 'circle' {
    switch (status) {
      case 'connected': return 'check-circle';
      case 'connecting': return 'spinner';
      case 'error': return 'error';
      case 'stopped': return 'circle';
      default: return 'circle';
    }
  }

  function getStatusColor(status: McpServerState['status']): string {
    switch (status) {
      case 'connected': return 'var(--color-success)';
      case 'connecting': return 'var(--color-accent)';
      case 'error': return 'var(--color-error)';
      case 'stopped': return 'var(--color-text-secondary)';
      default: return 'var(--color-text-secondary)';
    }
  }

  async function handleReload(): Promise<void> {
    await mcpStore.reload();
  }

  async function handleStopAll(): Promise<void> {
    for (const server of connectedServers) {
      await mcpStore.stopServer(server.id);
    }
  }

  async function handleStartAll(): Promise<void> {
    for (const server of otherServers) {
      mcpStore.startServer(server.id);
    }
  }

  async function handleAddServer(): Promise<void> {
    try {
      const configPath = await invoke<string>('ensure_mcp_config', { 
        defaultContent: DEFAULT_MCP_CONFIG 
      });
      await editorStore.openFile(configPath);
    } catch (err) {
      console.error('[MCP] Failed to open config:', err);
    }
  }

  async function handleOpenConfig(): Promise<void> {
    try {
      const configPath = await invoke<string>('get_mcp_config_path');
      await editorStore.openFile(configPath);
    } catch (err) {
      console.error('[MCP] Failed to open config:', err);
    }
  }

  async function handleToggleEnabled(serverId: string, isCurrentlyActive: boolean): Promise<void> {
    // Update UI immediately for instant feedback
    if (isCurrentlyActive) {
      // Immediately show as stopped
      mcpStore.updateServerState(serverId, { status: 'stopped', tools: [], error: undefined });
    } else {
      // Immediately show as connecting
      mcpStore.updateServerState(serverId, { status: 'connecting' });
    }

    try {
      if (isCurrentlyActive) {
        // Stop the server
        await mcpStore.stopServer(serverId);
      } else {
        // Start the server (don't await - let it connect in background)
        mcpStore.startServer(serverId);
      }
      
      // Update config file in background (fire and forget)
      invoke<string>('read_mcp_config').then(configContent => {
        const config = JSON.parse(configContent);
        if (config.mcpServers?.[serverId]) {
          if (isCurrentlyActive) {
            // Disabling - set disabled: true
            config.mcpServers[serverId].disabled = true;
          } else {
            // Enabling - remove disabled key (false is default)
            delete config.mcpServers[serverId].disabled;
          }
          invoke('write_mcp_config', { content: JSON.stringify(config, null, 2) });
        }
      }).catch(() => {});
    } catch (err) {
      console.error('[MCP] Failed to toggle server:', err);
    }
  }
</script>

<div class="mcp-panel">
  <div class="panel-toolbar">
    <button 
      class="toolbar-btn" 
      title="Add MCP Server" 
      onclick={handleAddServer}
    >
      <UIIcon name="plus" size={14} />
    </button>
    <button 
      class="toolbar-btn" 
      title="Reload servers" 
      onclick={handleReload}
      disabled={mcpStore.loading}
    >
      <UIIcon name={mcpStore.loading ? 'spinner' : 'refresh'} size={14} />
    </button>
    <button 
      class="toolbar-btn" 
      title="Edit mcp.json" 
      onclick={handleOpenConfig}
    >
      <UIIcon name="settings" size={14} />
    </button>
    <div class="toolbar-spacer"></div>
    {#if connectedServers.length > 0}
      <button 
        class="toolbar-btn stop-all" 
        title="Stop all servers" 
        onclick={handleStopAll}
      >
        <UIIcon name="stop" size={14} />
      </button>
    {/if}
  </div>

  <button class="config-path" onclick={handleOpenConfig} title="Open config file">
    <UIIcon name="file" size={12} />
    <span>{configPath}</span>
  </button>

  <div class="panel-content">
    {#if mcpStore.serverList.length === 0}
      <div class="empty-state">
        <UIIcon name="plug" size={32} />
        <p class="empty-title">No MCP servers configured</p>
        <p class="empty-desc">Add MCP servers to extend AI capabilities with external tools</p>
        <button class="add-btn" onclick={handleAddServer}>
          <UIIcon name="plus" size={14} />
          <span>Add Server</span>
        </button>
      </div>
    {:else}
      <!-- Connected Servers -->
      {#if connectedServers.length > 0}
        <div class="server-group">
          <div class="group-header">
            <span class="group-dot connected"></span>
            <span class="group-title">Connected</span>
            <span class="group-count">{connectedServers.length}</span>
          </div>
          <div class="server-list">
            {#each connectedServers as server (server.id)}
              {@render serverItem(server)}
            {/each}
          </div>
        </div>
      {/if}

      <!-- Connecting Servers -->
      {#if connectingServers.length > 0}
        <div class="server-group">
          <div class="group-header">
            <span class="group-dot connecting"></span>
            <span class="group-title">Connecting</span>
            <span class="group-count">{connectingServers.length}</span>
          </div>
          <div class="server-list">
            {#each connectingServers as server (server.id)}
              {@render serverItem(server)}
            {/each}
          </div>
        </div>
      {/if}

      <!-- Stopped/Error Servers -->
      {#if otherServers.length > 0}
        <div class="server-group">
          <div class="group-header">
            <span class="group-dot stopped"></span>
            <span class="group-title">Disconnected</span>
            <span class="group-count">{otherServers.length}</span>
            {#if otherServers.length > 1}
              <button class="group-action" onclick={handleStartAll} title="Start all">
                <UIIcon name="play" size={10} />
              </button>
            {/if}
          </div>
          <div class="server-list">
            {#each otherServers as server (server.id)}
              {@render serverItem(server)}
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <div class="panel-footer">
    <span class="stats">
      {mcpStore.connectedCount} connected · {mcpStore.toolCount} tools
    </span>
  </div>
</div>

{#snippet serverItem(server: McpServerState)}
  <div class="server-item" class:expanded={expandedServers.has(server.id)}>
    <div 
      class="server-header" 
      role="button"
      tabindex="0"
      onclick={() => toggleServer(server.id)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleServer(server.id); } }}
    >
      <span class="expand-icon" class:expanded={expandedServers.has(server.id)}>
        <UIIcon name="chevron-right" size={12} />
      </span>
      
      <span class="status-icon" style="color: {getStatusColor(server.status)}">
        <UIIcon name={getStatusIcon(server.status)} size={14} />
      </span>
      
      <span class="server-name">{server.name}</span>
      
      {#if server.status === 'connected'}
        <span class="tool-count">{server.tools.length} tools</span>
      {/if}
      
      <span class="server-actions">
        <!-- Toggle switch -->
        <button 
          class="toggle-btn"
          class:active={server.status === 'connected' || server.status === 'connecting'}
          title={server.status === 'connected' || server.status === 'connecting' ? 'Disable' : 'Enable'}
          onclick={(e) => { 
            e.stopPropagation(); 
            handleToggleEnabled(server.id, server.status === 'connected' || server.status === 'connecting'); 
          }}
        >
          <span class="toggle-track">
            <span class="toggle-thumb"></span>
          </span>
        </button>
      </span>
    </div>

    {#if expandedServers.has(server.id)}
      <div class="server-details">
        {#if server.error}
          <div class="error-message">
            <UIIcon name="error" size={12} />
            <span>{server.error}</span>
            <button 
              class="fix-error-btn" 
              title="Fix with Volt"
              onclick={(e) => {
                e.stopPropagation();
                const errorMsg = `MCP server "${server.id}" failed to start with error:\n\n${server.error}\n\nPlease help me fix this MCP configuration.`;
                assistantStore.setInputValue(errorMsg);
                assistantStore.openPanel();
              }}
            >
              <UIIcon name="sparkles" size={10} />
              <span>Fix</span>
            </button>
          </div>
        {/if}

        {#if server.tools.length > 0}
          <div class="tools-list">
            {#each server.tools as tool (tool.name)}
              <div class="tool-item">
                <UIIcon name="wrench" size={12} />
                <span class="tool-name">{tool.name}</span>
                {#if tool.description}
                  <span class="tool-desc" title={tool.description}>
                    {tool.description.slice(0, 50)}{tool.description.length > 50 ? '...' : ''}
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {:else if server.status === 'connected'}
          <div class="no-tools">No tools available</div>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .mcp-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg-panel);
  }

  .panel-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-border);
  }

  .toolbar-spacer {
    flex: 1;
  }

  .toolbar-btn.stop-all {
    color: var(--color-error);
  }

  .toolbar-btn.stop-all:hover {
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
  }

  .config-path {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 10px;
    color: var(--color-text-secondary);
    background: var(--color-surface0);
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .config-path:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .config-path span {
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .toolbar-btn:hover:not(:disabled) {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .toolbar-btn:disabled {
    opacity: 0.5;
  }

  .toolbar-btn :global(svg) {
    animation: none;
  }

  .toolbar-btn:disabled :global(svg) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
    text-align: center;
    color: var(--color-text-secondary);
  }

  .empty-state p {
    margin: 0;
  }

  .empty-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text);
    margin-top: 12px !important;
  }

  .empty-desc {
    font-size: 11px;
    opacity: 0.7;
    margin-top: 4px !important;
    max-width: 200px;
  }

  .add-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 16px;
    padding: 8px 16px;
    background: var(--color-accent);
    color: var(--color-bg);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .add-btn:hover {
    background: var(--color-accent-hover, var(--color-accent));
    filter: brightness(1.1);
  }

  /* Server Groups */
  .server-group {
    margin-bottom: 12px;
  }

  .server-group:last-child {
    margin-bottom: 0;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin-bottom: 4px;
  }

  .group-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .group-dot.connected {
    background: var(--color-success);
  }

  .group-dot.connecting {
    background: var(--color-accent);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .group-dot.stopped {
    background: var(--color-text-secondary);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .group-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text-secondary);
  }

  .group-count {
    font-size: 10px;
    color: var(--color-text-secondary);
    background: var(--color-surface1);
    padding: 1px 5px;
    border-radius: 8px;
  }

  .group-action {
    margin-left: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .group-action:hover {
    background: var(--color-hover);
    color: var(--color-success);
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .server-item {
    border-radius: 6px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    overflow: hidden;
  }

  .server-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .server-header:hover {
    background: var(--color-hover);
  }

  .server-header:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .expand-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--color-text-secondary);
    transition: transform 0.15s ease;
  }

  .expand-icon.expanded {
    transform: rotate(90deg);
  }

  .status-icon {
    display: flex;
    align-items: center;
  }

  .status-icon :global(svg) {
    animation: none;
  }

  .server-item:has(.status-icon[style*="accent"]) .status-icon :global(svg) {
    animation: spin 1s linear infinite;
  }

  .server-name {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text);
  }

  .tool-count {
    font-size: 10px;
    color: var(--color-text-secondary);
    background: var(--color-surface1);
    padding: 2px 6px;
    border-radius: 10px;
  }

  .server-actions {
    display: flex;
    gap: 2px;
  }

  .toggle-btn {
    display: flex;
    align-items: center;
    padding: 2px;
    border-radius: 4px;
    transition: all 0.15s ease;
  }

  .toggle-btn:hover {
    background: var(--color-surface1);
  }

  .toggle-track {
    position: relative;
    width: 28px;
    height: 14px;
    background: var(--color-surface1);
    border-radius: 7px;
    transition: all 0.2s ease;
  }

  .toggle-btn.active .toggle-track {
    background: var(--color-success);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 10px;
    height: 10px;
    background: var(--color-text-secondary);
    border-radius: 50%;
    transition: all 0.2s ease;
  }

  .toggle-btn.active .toggle-thumb {
    left: 16px;
    background: white;
  }

  .server-details {
    padding: 0 10px 10px 34px;
  }

  .error-message {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 8px;
    background: color-mix(in srgb, var(--color-error) 10%, transparent);
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-error);
    margin-bottom: 8px;
    word-break: break-word;
  }

  .error-message span {
    flex: 1;
    user-select: text;
    cursor: text;
  }

  .fix-error-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: var(--color-accent);
    color: var(--color-bg);
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    white-space: nowrap;
    transition: all 0.15s ease;
  }

  .fix-error-btn:hover {
    filter: brightness(1.1);
  }

  .tools-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tool-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .tool-item:hover {
    background: var(--color-hover);
  }

  .tool-name {
    font-family: var(--font-mono, monospace);
    color: var(--color-text);
  }

  .tool-desc {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.7;
  }

  .no-tools {
    font-size: 11px;
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .panel-footer {
    padding: 8px 12px;
    border-top: 1px solid var(--color-border);
  }

  .stats {
    font-size: 10px;
    color: var(--color-text-secondary);
  }
</style>
