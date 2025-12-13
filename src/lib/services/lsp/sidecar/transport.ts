/**
 * LSP Sidecar Transport
 * 
 * Handles communication between the frontend and LSP server sidecars
 * running in the Rust backend via Tauri commands and events.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  LspServerConfig,
  LspServerInfo,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  MessageHandler,
  ErrorHandler,
  ExitHandler,
} from './types';

/** Pending request tracking */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timestamp: number;
}

/**
 * LSP Transport - manages communication with a single LSP server sidecar
 */
export class LspTransport {
  private serverId: string;
  private serverType: string;
  private messageHandlers: Set<MessageHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private exitHandlers: Set<ExitHandler> = new Set();
  private pendingRequests: Map<number | string, PendingRequest> = new Map();
  private nextRequestId = 1;
  private unlisteners: UnlistenFn[] = [];
  private isConnected = false;

  constructor(serverId: string, serverType: string) {
    this.serverId = serverId;
    this.serverType = serverType;
  }

  /** Get the server ID */
  get id(): string {
    return this.serverId;
  }

  /** Get the server type */
  get type(): string {
    return this.serverType;
  }

  /** Check if connected */
  get connected(): boolean {
    return this.isConnected;
  }


  /**
   * Start the LSP server sidecar and set up event listeners
   */
  async start(config: Omit<LspServerConfig, 'serverId' | 'serverType'>): Promise<LspServerInfo> {
    // Start the server via Tauri command
    const info = await invoke<LspServerInfo>('lsp_start_server', {
      serverId: this.serverId,
      serverType: this.serverType,
      sidecarName: config.sidecarName,
      entrypoint: config.entrypoint,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
    });

    // Set up event listeners
    await this.setupEventListeners();
    this.isConnected = true;

    return info;
  }

  /**
   * Set up Tauri event listeners for this server
   */
  private async setupEventListeners(): Promise<void> {
    // Listen for JSON-RPC messages from the server
    const messageUnlisten = await listen<JsonRpcMessage>(
      `lsp://${this.serverId}//message`,
      (event) => {
        this.handleIncomingMessage(event.payload);
      }
    );
    this.unlisteners.push(messageUnlisten);

    // Listen for stderr output (logging)
    const stderrUnlisten = await listen<string>(
      `lsp://${this.serverId}//stderr`,
      (event) => {
        this.notifyError(event.payload);
      }
    );
    this.unlisteners.push(stderrUnlisten);

    // Listen for errors
    const errorUnlisten = await listen<string>(
      `lsp://${this.serverId}//error`,
      (event) => {
        this.notifyError(event.payload);
      }
    );
    this.unlisteners.push(errorUnlisten);

    // Listen for server exit
    const exitUnlisten = await listen(
      `lsp://${this.serverId}//exit`,
      () => {
        this.handleServerExit();
      }
    );
    this.unlisteners.push(exitUnlisten);

    // Listen for server stopped
    const stoppedUnlisten = await listen(
      `lsp://${this.serverId}//stopped`,
      () => {
        this.handleServerExit();
      }
    );
    this.unlisteners.push(stoppedUnlisten);
  }

  /**
   * Handle incoming JSON-RPC message from the server
   */
  private handleIncomingMessage(message: JsonRpcMessage): void {
    // Check if this is a response to a pending request
    if ('id' in message && message.id !== null) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        
        if ('error' in message && message.error) {
          pending.reject(new Error(message.error.message));
        } else if ('result' in message) {
          pending.resolve(message.result);
        } else {
          pending.resolve(undefined);
        }
        return;
      }
    }

    // Notify all message handlers
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (e) {
        console.error('[LSP Transport] Message handler error:', e);
      }
    }
  }

  /**
   * Handle server exit
   */
  private handleServerExit(): void {
    this.isConnected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Server exited'));
      this.pendingRequests.delete(id);
    }

    // Notify exit handlers
    for (const handler of this.exitHandlers) {
      try {
        handler();
      } catch (e) {
        console.error('[LSP Transport] Exit handler error:', e);
      }
    }
  }

  /**
   * Notify error handlers
   */
  private notifyError(error: string): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (e) {
        console.error('[LSP Transport] Error handler error:', e);
      }
    }
  }


  /**
   * Send a JSON-RPC request and wait for response
   */
  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.isConnected) {
      throw new Error('Transport not connected');
    }

    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    // Create promise for the response
    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        method,
        timestamp: Date.now(),
      });
    });

    // Send the request
    const message = JSON.stringify(request);
    await invoke('lsp_send_message', {
      serverId: this.serverId,
      message,
    });

    return responsePromise;
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Transport not connected');
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const message = JSON.stringify(notification);
    await invoke('lsp_send_message', {
      serverId: this.serverId,
      message,
    });
  }

  /**
   * Register a message handler
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Register an error handler
   */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Register an exit handler
   */
  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /**
   * Stop the server and clean up
   */
  async stop(): Promise<void> {
    // Remove all event listeners
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];

    // Stop the server
    if (this.isConnected) {
      try {
        await invoke('lsp_stop_server', { serverId: this.serverId });
      } catch (e) {
        console.error('[LSP Transport] Error stopping server:', e);
      }
    }

    this.isConnected = false;
    this.messageHandlers.clear();
    this.errorHandlers.clear();
    this.exitHandlers.clear();
    this.pendingRequests.clear();
  }

  /**
   * Dispose the transport (alias for stop)
   */
  dispose(): Promise<void> {
    return this.stop();
  }
}

/**
 * Create a new LSP transport for a server
 */
export function createTransport(serverId: string, serverType: string): LspTransport {
  return new LspTransport(serverId, serverType);
}

/**
 * List all running LSP servers
 */
export async function listServers(): Promise<LspServerInfo[]> {
  return invoke<LspServerInfo[]>('lsp_list_servers');
}

/**
 * Get info about a specific server
 */
export async function getServerInfo(serverId: string): Promise<LspServerInfo> {
  return invoke<LspServerInfo>('lsp_get_server_info', { serverId });
}

/**
 * Check if a server is running
 */
export async function isServerRunning(serverId: string): Promise<boolean> {
  return invoke<boolean>('lsp_is_server_running', { serverId });
}

/**
 * Stop all running servers
 */
export async function stopAllServers(): Promise<void> {
  return invoke('lsp_stop_all');
}
