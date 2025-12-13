/**
 * LSP Sidecar Registry
 * 
 * Manages multiple LSP server connections and provides a unified interface
 * for starting, stopping, and communicating with language servers.
 * 
 * Uses Tauri's externalBin sidecar mechanism for bundled language servers.
 */

import { LspTransport, createTransport, stopAllServers } from './transport';
import type { LspServerType } from './types';

/** Sidecar configuration for each LSP type */
interface SidecarConfig {
  /** Relative path to the language server entrypoint script within resources (or dev workspace). */
  entrypoint: string;
  /** Default args to pass to the language server. */
  args: string[];
}

/** We ship a real Node runtime as a single sidecar and execute JS-based language servers via entrypoint scripts. */
const NODE_SIDECAR_NAME = 'node';

/** Sidecar configurations for each server type */
const SIDECAR_CONFIGS: Record<LspServerType, SidecarConfig> = {
  typescript: {
    entrypoint: 'node_modules/typescript-language-server/lib/cli.mjs',
    args: ['--stdio'],
  },
  tailwind: {
    entrypoint: 'node_modules/@tailwindcss/language-server/bin/tailwindcss-language-server',
    args: ['--stdio'],
  },
  eslint: {
    entrypoint: 'node_modules/vscode-langservers-extracted/bin/vscode-eslint-language-server',
    args: ['--stdio'],
  },
  svelte: {
    entrypoint: 'node_modules/svelte-language-server/bin/server.js',
    args: ['--stdio'],
  },
  html: {
    entrypoint: 'node_modules/vscode-langservers-extracted/bin/vscode-html-language-server',
    args: ['--stdio'],
  },
  css: {
    entrypoint: 'node_modules/vscode-langservers-extracted/bin/vscode-css-language-server',
    args: ['--stdio'],
  },
  json: {
    entrypoint: 'node_modules/vscode-langservers-extracted/bin/vscode-json-language-server',
    args: ['--stdio'],
  },
};

/**
 * LSP Registry - manages all LSP server connections
 */
class LspRegistry {
  private transports: Map<string, LspTransport> = new Map();
  private projectRoot: string | null = null;

  /**
   * Set the project root directory
   */
  setProjectRoot(root: string | null): void {
    this.projectRoot = root;
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string | null {
    return this.projectRoot;
  }


  /**
   * Start a language server sidecar of the given type
   */
  async startServer(
    serverType: LspServerType,
    options?: {
      serverId?: string;
      cwd?: string;
      env?: Record<string, string>;
    }
  ): Promise<LspTransport> {
    const serverId = options?.serverId ?? `${serverType}-${Date.now()}`;
    
    // Check if already running
    if (this.transports.has(serverId)) {
      return this.transports.get(serverId)!;
    }

    // Get sidecar config for this server type
    const config = SIDECAR_CONFIGS[serverType];
    if (!config) {
      throw new Error(`Unknown server type: ${serverType}`);
    }

    // Create transport
    const transport = createTransport(serverId, serverType);

    // Start the language server using the Node sidecar
    await transport.start({
      sidecarName: NODE_SIDECAR_NAME,
      entrypoint: config.entrypoint,
      args: config.args,
      cwd: options?.cwd ?? this.projectRoot ?? undefined,
      env: options?.env,
    });

    // Store transport
    this.transports.set(serverId, transport);

    // Set up exit handler to clean up
    transport.onExit(() => {
      this.transports.delete(serverId);
    });

    return transport;
  }

  /**
   * Get a running transport by ID
   */
  getTransport(serverId: string): LspTransport | undefined {
    return this.transports.get(serverId);
  }

  /**
   * Get all transports of a given type
   */
  getTransportsByType(serverType: LspServerType): LspTransport[] {
    return Array.from(this.transports.values()).filter(t => t.type === serverType);
  }

  /**
   * Stop a specific server
   */
  async stopServer(serverId: string): Promise<void> {
    const transport = this.transports.get(serverId);
    if (transport) {
      await transport.stop();
      this.transports.delete(serverId);
    }
  }

  /**
   * Stop all servers of a given type
   */
  async stopServersByType(serverType: LspServerType): Promise<void> {
    const transports = this.getTransportsByType(serverType);
    await Promise.all(transports.map(t => this.stopServer(t.id)));
  }

  /**
   * Stop all running servers
   */
  async stopAll(): Promise<void> {
    // Stop all local transports
    const stopPromises = Array.from(this.transports.values()).map(t => t.stop());
    await Promise.all(stopPromises);
    this.transports.clear();

    // Also call backend to ensure all are stopped
    try {
      await stopAllServers();
    } catch (e) {
      console.error('[LSP Registry] Error stopping all servers:', e);
    }
  }

  /**
   * Check if a server is running
   */
  isRunning(serverId: string): boolean {
    const transport = this.transports.get(serverId);
    return transport?.connected ?? false;
  }

  /**
   * Check if any server of a given type is running
   */
  hasRunningServer(serverType: LspServerType): boolean {
    return this.getTransportsByType(serverType).some(t => t.connected);
  }

  /**
   * Get all running server IDs
   */
  getRunningServerIds(): string[] {
    return Array.from(this.transports.keys());
  }

  /**
   * Get info about all running servers
   */
  getRunningServers(): Array<{ id: string; type: string; connected: boolean }> {
    return Array.from(this.transports.entries()).map(([id, transport]) => ({
      id,
      type: transport.type,
      connected: transport.connected,
    }));
  }
}

// Singleton instance
let registryInstance: LspRegistry | null = null;

/**
 * Get the LSP registry singleton
 */
export function getLspRegistry(): LspRegistry {
  if (!registryInstance) {
    registryInstance = new LspRegistry();
  }
  return registryInstance;
}

/**
 * Initialize the LSP registry with a project root
 */
export function initLspRegistry(projectRoot: string | null): LspRegistry {
  const registry = getLspRegistry();
  registry.setProjectRoot(projectRoot);
  return registry;
}

/**
 * Dispose the LSP registry and stop all servers
 */
export async function disposeLspRegistry(): Promise<void> {
  if (registryInstance) {
    await registryInstance.stopAll();
    registryInstance = null;
  }
}

// Re-export types
export type { LspTransport };
export type { LspServerConfig, LspServerInfo, LspServerType } from './types';
