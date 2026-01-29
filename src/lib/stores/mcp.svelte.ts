/**
 * MCP (Model Context Protocol) Store
 * Manages MCP server connections, tools, and configuration
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { homeDir, join } from '@tauri-apps/api/path';
import { readTextFile, watchImmediate } from '@tauri-apps/plugin-fs';
import { showToast } from './toast.svelte';
import { logOutput } from './output.svelte';

// Types matching Rust structs
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerState {
  id: string;
  name: string;
  status: 'connecting' | 'connected' | 'error' | 'stopped';
  tools: McpTool[];
  error?: string;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

interface McpServerEvent {
  server_id: string;
  state: McpServerState;
}

class McpStore {
  // Server states
  servers = $state<Map<string, McpServerState>>(new Map());

  // All available tools (server_id, tool)
  tools = $state<Array<{ serverId: string; tool: McpTool }>>([]);

  // Config
  userConfig = $state<McpConfig | null>(null);
  workspaceConfig = $state<McpConfig | null>(null);

  // Loading state
  loading = $state(false);
  initialized = $state(false);

  // File watchers
  private userConfigWatcher: (() => void) | null = null;
  private workspaceConfigWatcher: (() => void) | null = null;
  private eventUnlisteners: UnlistenFn[] = [];

  // Paths
  private userConfigPath: string | null = null;
  private workspaceConfigPath: string | null = null;

  /** Get merged config (workspace overrides user) */
  get mergedConfig(): McpConfig {
    const merged: McpConfig = { mcpServers: {} };

    if (this.userConfig?.mcpServers) {
      Object.assign(merged.mcpServers!, this.userConfig.mcpServers);
    }

    if (this.workspaceConfig?.mcpServers) {
      Object.assign(merged.mcpServers!, this.workspaceConfig.mcpServers);
    }

    return merged;
  }

  /** Get all servers as array */
  get serverList(): McpServerState[] {
    return Array.from(this.servers.values());
  }

  /** Get connected server count */
  get connectedCount(): number {
    return this.serverList.filter(s => s.status === 'connected').length;
  }

  /** Get total tool count */
  get toolCount(): number {
    return this.tools.length;
  }

  /** Update a server's state immediately (for instant UI feedback) */
  updateServerState(serverId: string, updates: Partial<McpServerState>): void {
    const current = this.servers.get(serverId);
    if (current) {
      this.servers.set(serverId, { ...current, ...updates });
    } else {
      // Create new server entry if it doesn't exist
      this.servers.set(serverId, {
        id: serverId,
        name: serverId,
        status: 'stopped',
        tools: [],
        error: undefined,
        ...updates,
      });
    }
    // Force Svelte 5 reactivity by creating new Map
    this.servers = new Map(this.servers);
    this.updateTools();
  }

  // Track current workspace
  private currentWorkspace: string | null = null;

  /** Initialize MCP system (call once on app startup) */
  async initialize(workspacePath?: string): Promise<void> {
    if (this.initialized) {
      // Already initialized - just update workspace config if provided
      if (workspacePath && workspacePath !== this.currentWorkspace) {
        await this.updateWorkspaceConfig(workspacePath);
      }
      return;
    }

    logOutput('MCP', 'Initializing MCP system...');
    this.loading = true;
    this.currentWorkspace = workspacePath || null;

    try {
      // Clean up any stale servers from previous session
      try {
        await invoke('stop_all_mcp_servers');
      } catch {
        // Ignore - might not have any
      }

      // Set up event listeners
      await this.setupEventListeners();

      // Determine config paths
      const home = await homeDir();
      this.userConfigPath = await join(home, '.volt', 'settings', 'mcp.json');
      logOutput('MCP', `User config: ${this.userConfigPath}`);

      if (workspacePath) {
        this.workspaceConfigPath = await join(workspacePath, '.volt', 'mcp.json');
        logOutput('MCP', `Workspace config: ${this.workspaceConfigPath}`);
      }

      // Load configs
      await this.loadConfigs();

      // Watch for config changes
      await this.watchConfigs();

      // Start enabled servers
      await this.startEnabledServers();

      this.initialized = true;
      logOutput('MCP', `MCP initialized. ${this.connectedCount} servers connected, ${this.toolCount} tools available`);
    } catch (error) {
      logOutput('MCP', `[ERROR] Initialize failed: ${error}`);
      console.error('[MCP] Initialize error:', error);
    } finally {
      this.loading = false;
    }
  }

  /** Update workspace config when project changes */
  private async updateWorkspaceConfig(workspacePath: string): Promise<void> {
    this.currentWorkspace = workspacePath;

    // Stop watching old workspace config
    if (this.workspaceConfigWatcher) {
      this.workspaceConfigWatcher();
      this.workspaceConfigWatcher = null;
    }

    // Set new workspace config path
    this.workspaceConfigPath = await join(workspacePath, '.volt', 'mcp.json');

    // Load new workspace config
    try {
      const content = await readTextFile(this.workspaceConfigPath);
      this.workspaceConfig = JSON.parse(content);
    } catch {
      this.workspaceConfig = null;
    }

    // Watch new workspace config
    try {
      this.workspaceConfigWatcher = await watchImmediate(
        this.workspaceConfigPath,
        async () => {
          console.log('[MCP] Workspace config changed, reloading...');
          await this.reload();
        },
        { recursive: false }
      );
    } catch {
      // File might not exist yet
    }

    // Reload servers with new merged config
    await this.reload();
  }

  /** Clean up on shutdown */
  async cleanup(): Promise<void> {
    // Stop all servers
    try {
      await invoke('stop_all_mcp_servers');
    } catch (error) {
      console.error('[MCP] Cleanup error:', error);
    }

    // Remove event listeners
    for (const unlisten of this.eventUnlisteners) {
      unlisten();
    }
    this.eventUnlisteners = [];

    // Stop file watchers
    if (this.userConfigWatcher) {
      this.userConfigWatcher();
      this.userConfigWatcher = null;
    }
    if (this.workspaceConfigWatcher) {
      this.workspaceConfigWatcher();
      this.workspaceConfigWatcher = null;
    }

    this.servers.clear();
    this.tools = [];
    this.initialized = false;
  }

  /** Reload all servers (after config change) */
  async reload(): Promise<void> {
    logOutput('MCP', 'Reloading MCP servers...');
    this.loading = true;

    try {
      // Stop all current servers
      await invoke('stop_all_mcp_servers');
      this.servers.clear();
      this.tools = [];

      // Reload configs
      await this.loadConfigs();

      // Start enabled servers
      await this.startEnabledServers();

      logOutput('MCP', `Reload complete. ${this.connectedCount} servers connected, ${this.toolCount} tools available`);
      showToast({ message: 'MCP servers reloaded', type: 'success' });
    } catch (error) {
      logOutput('MCP', `[ERROR] Reload failed: ${error}`);
      console.error('[MCP] Reload error:', error);
      showToast({ message: 'Failed to reload MCP servers', type: 'error' });
    } finally {
      this.loading = false;
    }
  }

  /** Start a specific server */
  async startServer(serverId: string): Promise<void> {
    const config = this.mergedConfig.mcpServers?.[serverId];
    if (!config) {
      logOutput('MCP', `[ERROR] Server '${serverId}' not found in config`);
      showToast({ message: `Server '${serverId}' not found in config`, type: 'error' });
      return;
    }

    logOutput('MCP', `Starting server: ${serverId}`);
    logOutput('MCP', `  Command: ${config.command} ${(config.args || []).join(' ')}`);

    // Set initial connecting state in UI immediately
    this.servers.set(serverId, {
      id: serverId,
      name: serverId,
      status: 'connecting',
      tools: [],
    });
    this.servers = new Map(this.servers);

    try {
      const state = await invoke<McpServerState>('start_mcp_server', {
        serverId,
        config: {
          command: config.command,
          args: config.args || [],
          env: config.env || {},
          disabled: config.disabled || false,
          auto_approve: config.autoApprove || [],
        },
      });

      console.log('[MCP] Server started:', serverId, state.status);
      this.servers.set(serverId, state);
      this.servers = new Map(this.servers);
      this.updateTools();

      logOutput('MCP', `Server '${serverId}' connected with ${state.tools.length} tools`);
      for (const tool of state.tools) {
        logOutput('MCP', `  - ${tool.name}${tool.description ? `: ${tool.description.slice(0, 60)}...` : ''}`);
      }

    } catch (error) {
      const errorMsg = String(error);
      logOutput('MCP', `[ERROR] Failed to start '${serverId}': ${errorMsg}`);
      console.error(`[MCP] Failed to start server '${serverId}':`, error);

      // Update state to show error
      this.servers.set(serverId, {
        id: serverId,
        name: serverId,
        status: 'error',
        tools: [],
        error: errorMsg,
      });
      this.servers = new Map(this.servers);

      showToast({ message: `Failed to start ${serverId}: ${errorMsg}`, type: 'error' });
    }
  }

  /** Stop a specific server */
  async stopServer(serverId: string): Promise<void> {
    logOutput('MCP', `Stopping server: ${serverId}`);
    try {
      await invoke('stop_mcp_server', { serverId });

      const server = this.servers.get(serverId);
      if (server) {
        this.servers.set(serverId, { ...server, status: 'stopped' });
        this.servers = new Map(this.servers);
      }

      this.updateTools();
      logOutput('MCP', `Server '${serverId}' stopped`);
    } catch (error) {
      logOutput('MCP', `[ERROR] Failed to stop '${serverId}': ${error}`);
      console.error(`[MCP] Failed to stop server '${serverId}':`, error);
    }
  }

  /** Call an MCP tool */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    logOutput('MCP', `Tool call: ${serverId}/${toolName}`);
    logOutput('MCP', `  Arguments: ${JSON.stringify(args).slice(0, 200)}`);
    try {
      const result = await invoke('call_mcp_tool', {
        serverId,
        toolName,
        arguments: args,
      });
      logOutput('MCP', `  Result: ${JSON.stringify(result).slice(0, 300)}${JSON.stringify(result).length > 300 ? '...' : ''}`);
      return result;
    } catch (error) {
      logOutput('MCP', `  [ERROR] ${error}`);
      console.error(`[MCP] Tool call failed:`, error);
      throw error;
    }
  }

  /** Check if a tool should be auto-approved */
  isAutoApproved(serverId: string, toolName: string): boolean {
    const config = this.mergedConfig.mcpServers?.[serverId];
    if (!config?.autoApprove) return false;
    return config.autoApprove.includes(toolName) || config.autoApprove.includes('*');
  }

  // Private methods

  private async setupEventListeners(): Promise<void> {
    // Server state changes
    const unlistenState = await listen<McpServerEvent>('mcp://server-state', (event) => {
      const { server_id, state } = event.payload;
      console.log('[MCP] State event:', server_id, state.status);
      this.servers.set(server_id, state);
      // Force reactivity by creating new Map
      this.servers = new Map(this.servers);
      this.updateTools();
    });
    this.eventUnlisteners.push(unlistenState);

    // Server stopped
    const unlistenStopped = await listen<string>('mcp://server-stopped', (event) => {
      const serverId = event.payload;
      console.log('[MCP] Stopped event:', serverId);
      const server = this.servers.get(serverId);
      if (server) {
        this.servers.set(serverId, { ...server, status: 'stopped' });
        // Force reactivity
        this.servers = new Map(this.servers);
        this.updateTools();
      }
    });
    this.eventUnlisteners.push(unlistenStopped);

    // Server logs (stderr output)
    const unlistenLog = await listen<{ server_id: string; message: string; level: string }>('mcp://server-log', (event) => {
      const { server_id, message } = event.payload;
      logOutput('MCP', `[${server_id}] ${message}`);
    });
    this.eventUnlisteners.push(unlistenLog);
  }

  private async loadConfigs(): Promise<void> {
    // Load user config using Rust command (bypasses Tauri FS scope)
    if (this.userConfigPath) {
      try {
        const content = await invoke<string>('read_mcp_config');
        this.userConfig = JSON.parse(content);
        logOutput('MCP', `Loaded user config with ${Object.keys(this.userConfig?.mcpServers || {}).length} servers`);
      } catch (err) {
        // File doesn't exist or invalid JSON - that's ok
        logOutput('MCP', `No user config found: ${err}`);
        this.userConfig = null;
      }
    }

    // Load workspace config (this one is in workspace so FS plugin works)
    if (this.workspaceConfigPath) {
      try {
        const content = await readTextFile(this.workspaceConfigPath);
        this.workspaceConfig = JSON.parse(content);
        logOutput('MCP', `Loaded workspace config with ${Object.keys(this.workspaceConfig?.mcpServers || {}).length} servers`);
      } catch {
        this.workspaceConfig = null;
      }
    }
  }

  private async watchConfigs(): Promise<void> {
    // Note: User config (~/.volt/settings/mcp.json) cannot be watched due to Tauri security scope
    // User must click Reload button after editing the config file
    // Only workspace config can be auto-watched

    // Watch workspace config (if in workspace, it can be watched)
    if (this.workspaceConfigPath) {
      try {
        this.workspaceConfigWatcher = await watchImmediate(
          this.workspaceConfigPath,
          async () => {
            logOutput('MCP', 'Workspace config changed, reloading...');
            await this.reload();
          },
          { recursive: false }
        );
      } catch {
        // File might not exist yet
      }
    }
  }

  private async startEnabledServers(): Promise<void> {
    const config = this.mergedConfig;
    if (!config.mcpServers) return;

    // First, populate all servers from config (including disabled ones)
    for (const [serverId, serverConfig] of Object.entries(config.mcpServers)) {
      if (!this.servers.has(serverId)) {
        this.servers.set(serverId, {
          id: serverId,
          name: serverId,
          status: serverConfig.disabled ? 'stopped' : 'connecting',
          tools: [],
          error: undefined,
        });
      }
    }

    const enabledServers = Object.entries(config.mcpServers).filter(([, cfg]) => !cfg.disabled);

    if (enabledServers.length === 0) {
      logOutput('MCP', 'No enabled servers to start');
      return;
    }

    logOutput('MCP', `Starting ${enabledServers.length} enabled server(s)...`);

    // Start all servers with a stagger to avoid resource contention
    for (const [serverId] of enabledServers) {
      // Fire and forget - don't block initialization
      this.startServer(serverId).catch(err => {
        logOutput('MCP', `[ERROR] Failed to start '${serverId}': ${err}`);
      });
      // Small stagger to prevent CPU spikes
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  private updateTools(): void {
    const allTools: Array<{ serverId: string; tool: McpTool }> = [];

    for (const [serverId, server] of this.servers) {
      if (server.status === 'connected') {
        for (const tool of server.tools) {
          allTools.push({ serverId, tool });
        }
      }
    }

    this.tools = allTools;
  }
}

// Singleton instance
export const mcpStore = new McpStore();
