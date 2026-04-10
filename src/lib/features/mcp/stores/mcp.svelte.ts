/**
 * MCP (Model Context Protocol) Store
 * Manages MCP server connections, tools, and configuration
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { homeDir, join } from '@tauri-apps/api/path';
import { getFileInfoQuiet, readFileQuiet } from '$core/services/file-system';
import { showToast } from '$shared/stores/toast.svelte';
import { logOutput } from '$features/terminal/stores/output.svelte';
import { registerCleanup } from '$core/services/hmr-cleanup';

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

  private startPromises = new Map<string, Promise<void>>();
  private initializePromise: Promise<void> | null = null;
  private reloading = false;
  private reloadQueued = false;
  private static readonly MAX_RETRY_ATTEMPTS = 3;
  private static readonly RETRY_DELAY_MS = 30000; // 30 seconds

  // Config
  userConfig = $state<McpConfig | null>(null);
  workspaceConfig = $state<McpConfig | null>(null);

  // Loading state
  loading = $state(false);
  initialized = $state(false);

  // File watchers
  private userConfigWatcher: (() => void) | null = null;
  private workspaceConfigWatcher: (() => void) | null = null;
  private workspaceConfigPollTimer: ReturnType<typeof setInterval> | null = null;
  private workspaceConfigLastModified: number | null | undefined = undefined;
  private workspaceConfigPollInFlight = false;
  private eventUnlisteners: UnlistenFn[] = [];
  private listenersInitialized = false;

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
    if (this.initializePromise) {
      await this.initializePromise;
      if (workspacePath && workspacePath !== this.currentWorkspace) {
        await this.updateWorkspaceConfig(workspacePath);
      }
      return;
    }

    if (this.initialized) {
      // Already initialized - just update workspace config if provided
      if (workspacePath && workspacePath !== this.currentWorkspace) {
        await this.updateWorkspaceConfig(workspacePath);
      }
      return;
    }

    this.initializePromise = this.initializeInternal(workspacePath);
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  private async initializeInternal(workspacePath?: string): Promise<void> {
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
    const mergedBefore = JSON.stringify(this.mergedConfig);
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
      const content = await readFileQuiet(this.workspaceConfigPath);
      if (!content) {
        this.workspaceConfig = null;
      } else {
        this.workspaceConfig = JSON.parse(content);
      }
    } catch {
      this.workspaceConfig = null;
    }

    this.startWorkspaceConfigPolling();

    // Reload only when merged config actually changed.
    // This avoids stop/start thrash when opening a project that has no workspace MCP config.
    const mergedAfter = JSON.stringify(this.mergedConfig);
    if (mergedAfter !== mergedBefore) {
      await this.reload();
    } else {
      logOutput('MCP', 'Workspace changed but MCP config unchanged, skipping reload');
    }
  }

  /** Clean up on shutdown */
  async cleanup(): Promise<void> {
    this.startPromises.clear();

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
    this.listenersInitialized = false;

    // Stop file watchers
    if (this.userConfigWatcher) {
      this.userConfigWatcher();
      this.userConfigWatcher = null;
    }
    if (this.workspaceConfigWatcher) {
      this.workspaceConfigWatcher();
      this.workspaceConfigWatcher = null;
    }
    if (this.workspaceConfigPollTimer) {
      clearInterval(this.workspaceConfigPollTimer);
      this.workspaceConfigPollTimer = null;
    }
    this.workspaceConfigLastModified = undefined;
    this.workspaceConfigPollInFlight = false;

    this.servers.clear();
    this.tools = [];
    this.initialized = false;
  }

  /** Reload all servers (after config change) */
  async reload(): Promise<void> {
    if (this.reloading) {
      this.reloadQueued = true;
      logOutput('MCP', 'Reload already running, queued one follow-up reload');
      return;
    }

    this.reloading = true;
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
      this.reloading = false;
      this.loading = false;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.reload();
      }
    }
  }

  /** Start a specific server */
  async startServer(serverId: string, options?: { showErrorToast?: boolean }): Promise<void> {
    const existing = this.startPromises.get(serverId);
    if (existing) {
      return existing;
    }

    const startPromise = this.startServerInternal(
      serverId,
      options?.showErrorToast ?? true,
    ).finally(() => {
      this.startPromises.delete(serverId);
    });
    this.startPromises.set(serverId, startPromise);
    return startPromise;
  }

  private async startServerInternal(serverId: string, showErrorToast: boolean): Promise<void> {
    const config = this.mergedConfig.mcpServers?.[serverId];
    if (!config) {
      logOutput('MCP', `[ERROR] Server '${serverId}' not found in config`);
      if (showErrorToast) {
        showToast({ message: `Server '${serverId}' not found in config`, type: 'error' });
      }
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
      const state = await invoke<McpServerState>('start_mcp_server_managed', {
        serverId,
        config: {
          command: config.command,
          args: config.args || [],
          env: config.env || {},
          disabled: config.disabled || false,
          auto_approve: config.autoApprove || [],
        },
        maxRetries: McpStore.MAX_RETRY_ATTEMPTS,
        retryDelayMs: McpStore.RETRY_DELAY_MS,
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

      // Only show error in console, not spam user
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

      if (showErrorToast) {
        showToast({ message: `Failed to start ${serverId}: ${errorMsg}`, type: 'error' });
      }
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
    if (this.listenersInitialized) {
      return;
    }

    for (const unlisten of this.eventUnlisteners) {
      try {
        unlisten();
      } catch {
        // ignore stale listeners
      }
    }
    this.eventUnlisteners = [];

    // Server state changes
    const unlistenState = await listen<McpServerEvent>('mcp://server-state', (event) => {
      const { server_id, state } = event.payload;
      const prev = this.servers.get(server_id);
      const prevTools = prev?.tools?.map((t) => t.name).join('|') ?? '';
      const nextTools = state.tools?.map((t) => t.name).join('|') ?? '';
      const unchanged =
        prev?.status === state.status &&
        (prev?.error ?? '') === (state.error ?? '') &&
        prevTools === nextTools;
      if (unchanged) return;
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
    this.listenersInitialized = true;
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
        const content = await readFileQuiet(this.workspaceConfigPath);
        if (content) {
          this.workspaceConfig = JSON.parse(content);
          logOutput('MCP', `Loaded workspace config with ${Object.keys(this.workspaceConfig?.mcpServers || {}).length} servers`);
        } else {
          this.workspaceConfig = null;
        }
      } catch {
        this.workspaceConfig = null;
      }
    }
  }

  private async watchConfigs(): Promise<void> {
    // Note: User config (~/.volt/settings/mcp.json) cannot be watched due to Tauri security scope
    // User must click Reload button after editing the config file
    // Only workspace config can be auto-watched

    this.startWorkspaceConfigPolling();
  }

  private startWorkspaceConfigPolling(): void {
    if (this.workspaceConfigPollTimer) {
      clearInterval(this.workspaceConfigPollTimer);
      this.workspaceConfigPollTimer = null;
    }
    this.workspaceConfigLastModified = undefined;

    if (!this.workspaceConfigPath) {
      this.workspaceConfigWatcher = null;
      return;
    }

    const poll = async (): Promise<void> => {
      if (!this.workspaceConfigPath || this.workspaceConfigPollInFlight) {
        return;
      }
      this.workspaceConfigPollInFlight = true;

      try {
        const info = await getFileInfoQuiet(this.workspaceConfigPath);
        const nextModified = info?.modified ?? null;
        if (this.workspaceConfigLastModified === undefined) {
          this.workspaceConfigLastModified = nextModified;
          return;
        }

        if (nextModified !== this.workspaceConfigLastModified) {
          this.workspaceConfigLastModified = nextModified;
          logOutput('MCP', 'Workspace config changed, reloading...');
          await this.reload();
        }
      } finally {
        this.workspaceConfigPollInFlight = false;
      }
    };

    void poll();
    this.workspaceConfigPollTimer = setInterval(() => {
      void poll();
    }, 1500);
    this.workspaceConfigWatcher = () => {
      if (this.workspaceConfigPollTimer) {
        clearInterval(this.workspaceConfigPollTimer);
        this.workspaceConfigPollTimer = null;
      }
      this.workspaceConfigLastModified = undefined;
      this.workspaceConfigPollInFlight = false;
    };
  }

  private async startEnabledServers(): Promise<void> {
    const config = this.mergedConfig;
    if (!config.mcpServers) return;

    const isDefaultDisabledServer = (serverId: string, serverConfig: McpServerConfig): boolean =>
      (serverId === 'brave-search' || serverId === 'fetch') &&
      serverConfig.disabled === undefined;

    // First, populate all servers from config (including disabled ones)
    for (const [serverId, serverConfig] of Object.entries(config.mcpServers)) {
      if (!this.servers.has(serverId)) {
        this.servers.set(serverId, {
          id: serverId,
          name: serverId,
          status: serverConfig.disabled || isDefaultDisabledServer(serverId, serverConfig) ? 'stopped' : 'connecting',
          tools: [],
          error: undefined,
        });
      }
    }

    const enabledServers = Object.entries(config.mcpServers).filter(
      ([serverId, cfg]) => !(cfg.disabled || isDefaultDisabledServer(serverId, cfg))
    );

    if (enabledServers.length === 0) {
      logOutput('MCP', 'No enabled servers to start');
      return;
    }

    logOutput('MCP', `Starting ${enabledServers.length} enabled server(s)...`);
    const states = await invoke<McpServerState[]>('start_mcp_servers_managed', {
      servers: Object.fromEntries(
        enabledServers.map(([serverId, serverConfig]) => [
          serverId,
          {
            command: serverConfig.command,
            args: serverConfig.args || [],
            env: serverConfig.env || {},
            disabled: serverConfig.disabled || false,
            auto_approve: serverConfig.autoApprove || [],
          },
        ]),
      ),
      maxRetries: McpStore.MAX_RETRY_ATTEMPTS,
      retryDelayMs: McpStore.RETRY_DELAY_MS,
    });

    for (const state of states) {
      this.servers.set(state.id, state);
    }
    this.servers = new Map(this.servers);
    this.updateTools();
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

// Register HMR cleanup to prevent orphaned event listeners
registerCleanup('mcp-store', () => mcpStore.cleanup());
