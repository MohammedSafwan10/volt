/**
 * LSP Sidecar Registry
 * 
 * Manages multiple LSP server connections and provides a unified interface
 * for starting, stopping, and communicating with language servers.
 * 
 * Uses Tauri's externalBin sidecar mechanism for bundled language servers,
 * and external process spawning for user-installed servers (Dart, Rust Analyzer, etc.).
 */

import { LspTransport, createTransport, stopAllServers } from './transport';
import type { LspServerType, HealthConfig, HealthStatus } from './types';
import { isExternalServerType } from './types';
import { detectYamlLsp } from '../yaml-sdk';
import { getLemminxCommand } from '../xml-sdk';

/** Sidecar configuration for each LSP type (bundled servers) */
interface SidecarConfig {
  /** Relative path to the language server entrypoint script within resources (or dev workspace). */
  entrypoint: string;
  /** Default args to pass to the language server. */
  args: string[];
}

/** External server configuration (from user's PATH) */
interface ExternalConfig {
  /** Command to execute (e.g., "dart", "rust-analyzer") */
  command: string;
  /** Arguments for the command */
  args: string[];
}

/** We ship a real Node runtime as a single sidecar and execute JS-based language servers via entrypoint scripts. */
const NODE_SIDECAR_NAME = 'node';

/** Sidecar configurations for each server type */
/** Sidecar configurations for bundled server types (not external) */
const SIDECAR_CONFIGS: Partial<Record<LspServerType, SidecarConfig>> = {
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

/** External server configurations (from user's PATH) */
const EXTERNAL_CONFIGS: Partial<Record<LspServerType, ExternalConfig>> = {
  dart: {
    command: 'dart',
    args: ['language-server', '--client-id', 'volt-ide', '--client-version', '1.0.0'],
  },
  // yaml and xml use dynamic command resolution - see getDynamicExternalConfig()
};

/**
 * Get dynamic external configuration for servers that need runtime detection
 * Returns null if the server is not available
 */
async function getDynamicExternalConfig(serverType: LspServerType): Promise<ExternalConfig | null> {
  switch (serverType) {
    case 'yaml': {
      const yamlInfo = await detectYamlLsp();
      if (!yamlInfo) return null;
      return {
        command: yamlInfo.serverPath,
        args: ['--stdio'],
      };
    }
    case 'xml': {
      const xmlCommand = await getLemminxCommand();
      if (!xmlCommand) return null;
      return {
        command: xmlCommand.command,
        args: xmlCommand.args,
      };
    }
    default:
      return null;
  }
}

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
   * Start a language server of the given type
   * Automatically chooses between bundled sidecar or external server based on type
   */
  async startServer(
    serverType: LspServerType,
    options?: {
      serverId?: string;
      cwd?: string;
      env?: Record<string, string>;
      health?: HealthConfig;
      command?: string;
      args?: string[];
    }
  ): Promise<LspTransport> {
    const serverId = options?.serverId ?? `${serverType}-${Date.now()}`;

    // Check if already running
    if (this.transports.has(serverId)) {
      return this.transports.get(serverId)!;
    }

    // Create transport with optional health config
    const transport = createTransport(serverId, serverType, options?.health);

    // Check if this is an external server type
    if (isExternalServerType(serverType)) {
      // Use provided command/args if available, otherwise try dynamic then static config
      let externalConfig: ExternalConfig | null = (options?.command)
        ? { command: options.command, args: options.args ?? [] }
        : await getDynamicExternalConfig(serverType);

      // Fall back to static config (for dart)
      if (!externalConfig) {
        externalConfig = EXTERNAL_CONFIGS[serverType] ?? null;
      }

      if (!externalConfig) {
        throw new Error(`No external config for server type: ${serverType}. The server may not be installed.`);
      }

      // Start external server
      await transport.startExternal({
        command: externalConfig.command,
        args: externalConfig.args,
        cwd: options?.cwd ?? this.projectRoot ?? undefined,
        env: options?.env,
      });
    } else {
      // Get bundled sidecar config
      const config = SIDECAR_CONFIGS[serverType];
      if (!config) {
        throw new Error(`Unknown server type: ${serverType}`);
      }

      // Start the language server using the Node sidecar
      await transport.start({
        sidecarName: NODE_SIDECAR_NAME,
        entrypoint: config.entrypoint,
        args: config.args,
        cwd: options?.cwd ?? this.projectRoot ?? undefined,
        env: options?.env,
      });
    }

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
   * Get info about all running servers including health status
   */
  getRunningServers(): Array<{ id: string; type: string; connected: boolean; healthy: boolean }> {
    return Array.from(this.transports.entries()).map(([id, transport]) => ({
      id,
      type: transport.type,
      connected: transport.connected,
      healthy: transport.healthy,
    }));
  }

  /**
   * Get health status for a specific server
   */
  getServerHealth(serverId: string) {
    const transport = this.transports.get(serverId);
    return transport?.health ?? null;
  }

  /**
   * Get health status for all running servers
   */
  getAllServerHealth(): Array<{ id: string; type: string; health: HealthStatus }> {
    return Array.from(this.transports.entries()).map(([id, transport]) => ({
      id,
      type: transport.type,
      health: transport.health,
    }));
  }

  /**
   * Check if all servers are healthy
   */
  areAllServersHealthy(): boolean {
    for (const transport of this.transports.values()) {
      if (!transport.healthy) {
        return false;
      }
    }
    return true;
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
