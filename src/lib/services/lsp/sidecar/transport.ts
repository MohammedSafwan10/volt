/**
 * LSP Sidecar Transport
 * 
 * Handles communication between the frontend and LSP server sidecars
 * running in the Rust backend via Tauri commands and events.
 * Also supports external LSP servers from user's PATH (e.g., Dart, Rust Analyzer).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  LspServerConfig,
  ExternalLspConfig,
  LspServerInfo,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  MessageHandler,
  ErrorHandler,
  ExitHandler,
  HealthHandler,
  HealthConfig,
  HealthStatus,
} from './types';
import { DEFAULT_HEALTH_CONFIG } from './types';

/** Pending request tracking */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timestamp: number;
}

type StartMode = 'sidecar' | 'external';

/**
 * LSP Transport - manages communication with a single LSP server sidecar
 */
export class LspTransport {
  private serverId: string;
  private serverType: string;
  private messageHandlers: Set<MessageHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private exitHandlers: Set<ExitHandler> = new Set();
  private healthHandlers: Set<HealthHandler> = new Set();
  private pendingRequests: Map<number | string, PendingRequest> = new Map();
  private nextRequestId = 1;
  private unlisteners: UnlistenFn[] = [];
  private isConnected = false;
  private startMode: StartMode | null = null;
  private startConfig: Omit<LspServerConfig, 'serverId' | 'serverType'> | Omit<ExternalLspConfig, 'serverId' | 'serverType'> | null = null;
  private isRestarting = false;

  // Health monitoring state
  private healthConfig: Required<HealthConfig>;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthStatus: HealthStatus = {
    healthy: true,
    lastResponseAt: null,
    consecutiveFailures: 0,
    lastCheckAt: null,
    avgResponseTimeMs: null,
    message: 'Not started',
  };
  private responseTimes: number[] = []; // Rolling window for avg calculation
  private static readonly RESPONSE_TIME_WINDOW = 10; // Keep last 10 response times

  constructor(serverId: string, serverType: string, healthConfig?: HealthConfig) {
    this.serverId = serverId;
    this.serverType = serverType;
    this.healthConfig = { ...DEFAULT_HEALTH_CONFIG, ...healthConfig };
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

  /** Get current health status */
  get health(): HealthStatus {
    return { ...this.healthStatus };
  }

  /** Check if server is healthy */
  get healthy(): boolean {
    return this.healthStatus.healthy;
  }

  /** Lightweight runtime metrics for leak/perf monitoring */
  getRuntimeSnapshot(): {
    id: string;
    type: string;
    connected: boolean;
    healthy: boolean;
    pendingRequests: number;
    eventListeners: number;
    messageHandlers: number;
    errorHandlers: number;
    exitHandlers: number;
    healthHandlers: number;
  } {
    return {
      id: this.serverId,
      type: this.serverType,
      connected: this.isConnected,
      healthy: this.healthStatus.healthy,
      pendingRequests: this.pendingRequests.size,
      eventListeners: this.unlisteners.length,
      messageHandlers: this.messageHandlers.size,
      errorHandlers: this.errorHandlers.size,
      exitHandlers: this.exitHandlers.size,
      healthHandlers: this.healthHandlers.size,
    };
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
    this.startMode = 'sidecar';
    this.startConfig = { ...config };

    // Start health monitoring
    this.startHealthMonitoring();

    return info;
  }

  /**
   * Start an external LSP server (from user's PATH) and set up event listeners
   */
  async startExternal(config: Omit<ExternalLspConfig, 'serverId' | 'serverType'>): Promise<LspServerInfo> {
    // Start the external server via Tauri command
    const info = await invoke<LspServerInfo>('lsp_start_external_server', {
      serverId: this.serverId,
      serverType: this.serverType,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
    });

    // Set up event listeners (same as sidecar)
    await this.setupEventListeners();
    this.isConnected = true;
    this.startMode = 'external';
    this.startConfig = { ...config };

    // Start health monitoring
    this.startHealthMonitoring();

    return info;
  }

  /**
   * Set up Tauri event listeners for this server
   */
  private async setupEventListeners(): Promise<void> {
    // Defensive cleanup in case listeners were left over from a prior lifecycle.
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];

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

  // ============================================================
  // Health Monitoring Methods
  // ============================================================

  /**
   * Start periodic health monitoring
   */
  private startHealthMonitoring(): void {
    if (!this.healthConfig.enabled) {
      this.updateHealthStatus({
        healthy: true,
        message: 'Health monitoring disabled',
      });
      return;
    }

    // Clear any existing timer
    this.stopHealthMonitoring();

    // Update initial status
    this.updateHealthStatus({
      healthy: true,
      lastResponseAt: Date.now(),
      consecutiveFailures: 0,
      message: 'Server started',
    });

    // Start periodic health checks
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.healthConfig.intervalMs);

    console.log(`[LSP Health] Started monitoring for ${this.serverId} (interval: ${this.healthConfig.intervalMs}ms)`);
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Perform a single health check
   */
  private async performHealthCheck(): Promise<void> {
    if (!this.isConnected) {
      this.updateHealthStatus({
        healthy: false,
        consecutiveFailures: this.healthStatus.consecutiveFailures + 1,
        lastCheckAt: Date.now(),
        message: 'Server disconnected',
      });
      return;
    }

    const startTime = Date.now();

    try {
      // Use a simple request that most LSP servers support
      // We use $/cancelRequest with an invalid ID which should return quickly
      // or textDocument/hover with null params (will error but confirms server is alive)
      await this.sendHealthPing();

      // Success - record response time
      const responseTime = Date.now() - startTime;
      this.recordResponseTime(responseTime);

      this.updateHealthStatus({
        healthy: true,
        lastResponseAt: Date.now(),
        consecutiveFailures: 0,
        lastCheckAt: Date.now(),
        avgResponseTimeMs: this.calculateAvgResponseTime(),
        message: `Healthy (${responseTime}ms)`,
      });

    } catch (error) {
      const failures = this.healthStatus.consecutiveFailures + 1;
      const isUnhealthy = failures >= this.healthConfig.failureThreshold;
      const wasHealthy = this.healthStatus.healthy;

      this.updateHealthStatus({
        healthy: !isUnhealthy,
        consecutiveFailures: failures,
        lastCheckAt: Date.now(),
        message: isUnhealthy
          ? `Unhealthy: ${failures} consecutive failures`
          : `Warning: ${failures}/${this.healthConfig.failureThreshold} failures`,
      });

      // Only log on state transition (healthy → unhealthy) to reduce noise
      if (wasHealthy && isUnhealthy) {
        console.warn(`[LSP Health] ${this.serverId} became unhealthy after ${failures} failures`);
      }

      // Stop monitoring once threshold is reached (no infinite loop)
      if (isUnhealthy) {
        console.log(`[LSP Health] Stopping monitoring for ${this.serverId} (unhealthy)`);
        this.stopHealthMonitoring();

        // Auto-restart if configured
        if (this.healthConfig.autoRestart) {
          console.log(`[LSP Health] Auto-restarting unhealthy server: ${this.serverId}`);
          this.notifyError(`Server unhealthy, attempting restart...`);
          await this.restartFromSavedConfig();
        }
      }
    }
  }

  /**
   * Send a health ping to the server
   * Uses $/cancelRequest with a fake ID - this is fast and doesn't trigger warnings
   */
  private async sendHealthPing(): Promise<void> {
    await this.sendRequestWithTimeout(
      'workspace/symbol',
      { query: '__volt_health_check__' },
      this.healthConfig.timeoutMs
    );
  }

  /**
   * Record a response time for average calculation
   */
  private recordResponseTime(timeMs: number): void {
    this.responseTimes.push(timeMs);
    // Keep only the last N response times.
    if (this.responseTimes.length > LspTransport.RESPONSE_TIME_WINDOW) {
      this.responseTimes.shift();
    }
  }

  /**
   * Calculate average response time from recorded times
   */
  private calculateAvgResponseTime(): number | null {
    if (this.responseTimes.length === 0) return null;
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.responseTimes.length);
  }

  /**
   * Update health status and notify handlers
   */
  private updateHealthStatus(partial: Partial<HealthStatus>): void {
    const previousHealthy = this.healthStatus.healthy;
    const hadPreviousCheck = this.healthStatus.lastCheckAt !== null;
    this.healthStatus = { ...this.healthStatus, ...partial };

    // Notify on health transitions and first completed check.
    const healthChanged = previousHealthy !== this.healthStatus.healthy;
    const isFirstCheck = !hadPreviousCheck && this.healthStatus.lastCheckAt !== null;

    if (healthChanged || isFirstCheck) {
      for (const handler of this.healthHandlers) {
        try {
          handler(this.health);
        } catch (e) {
          console.error('[LSP Transport] Health handler error:', e);
        }
      }
    }
  }

  /**
   * Manually trigger a health check (useful for testing or on-demand verification)
   */
  async checkHealth(): Promise < HealthStatus > {
  await this.performHealthCheck();
  return this.health;
}

/**
 * Update health configuration at runtime
 */
configureHealth(config: HealthConfig): void {
  this.healthConfig = { ...this.healthConfig, ...config };

  // Restart monitoring if enabled state changed
  if(this.isConnected) {
  this.stopHealthMonitoring();
  if (this.healthConfig.enabled) {
    this.startHealthMonitoring();
  }
}
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async sendRequest < T = unknown > (method: string, params ?: unknown): Promise < T > {
    return this.sendRequestWithTimeout<T>(method, params);
  }

  private async sendRequestWithTimeout<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
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
    try {
      await invoke('lsp_send_message', {
        serverId: this.serverId,
        message,
      });
    } catch (error) {
      this.pendingRequests.delete(id);
      throw error;
    }

    if (!timeoutMs || timeoutMs <= 0) {
      return responsePromise;
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);

      responsePromise
        .then((value) => {
          clearTimeout(timeoutId);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  async sendNotification(method: string, params ?: unknown): Promise < void> {
  if(!this.isConnected) {
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
   * Send a JSON-RPC response to a server request
   */
  async sendResponse(id: number | string, result: unknown): Promise < void> {
  if(!this.isConnected) {
  throw new Error('Transport not connected');
}

const response: JsonRpcResponse = {
  jsonrpc: '2.0',
  id,
  result,
};

const message = JSON.stringify(response);
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
  return() => this.messageHandlers.delete(handler);
}

/**
 * Register an error handler
 */
onError(handler: ErrorHandler): () => void {
  this.errorHandlers.add(handler);
  return() => this.errorHandlers.delete(handler);
}

/**
 * Register an exit handler
 */
onExit(handler: ExitHandler): () => void {
  this.exitHandlers.add(handler);
  return() => this.exitHandlers.delete(handler);
}

/**
 * Register a health status change handler
 */
onHealth(handler: HealthHandler): () => void {
  this.healthHandlers.add(handler);
  return() => this.healthHandlers.delete(handler);
}

  /**
   * Stop the server and clean up
   */
  async stop(): Promise < void> {
  // Stop health monitoring first
  this.stopHealthMonitoring();

  // Remove all event listeners
  for(const unlisten of this.unlisteners) {
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
this.healthHandlers.clear();
this.pendingRequests.clear();
this.responseTimes = [];
  }

  private async restartFromSavedConfig(): Promise<void> {
    if (this.isRestarting || !this.startMode || !this.startConfig) {
      return;
    }

    this.isRestarting = true;
    const messageHandlers = new Set(this.messageHandlers);
    const errorHandlers = new Set(this.errorHandlers);
    const exitHandlers = new Set(this.exitHandlers);
    const healthHandlers = new Set(this.healthHandlers);

    try {
      await this.stop();
      this.messageHandlers = messageHandlers;
      this.errorHandlers = errorHandlers;
      this.exitHandlers = exitHandlers;
      this.healthHandlers = healthHandlers;

      if (this.startMode === 'sidecar') {
        await this.start(this.startConfig as Omit<LspServerConfig, 'serverId' | 'serverType'>);
      } else {
        await this.startExternal(this.startConfig as Omit<ExternalLspConfig, 'serverId' | 'serverType'>);
      }
    } catch (error) {
      this.notifyError(`Failed to auto-restart server: ${String(error)}`);
    } finally {
      this.isRestarting = false;
    }
  }

/**
 * Dispose the transport (alias for stop)
 */
dispose(): Promise < void> {
  return this.stop();
}
}

/**
 * Create a new LSP transport for a server
 * @param serverId - Unique identifier for the server
 * @param serverType - Type of server (e.g., 'typescript', 'dart')
 * @param healthConfig - Optional health monitoring configuration
 */
export function createTransport(
  serverId: string,
  serverType: string,
  healthConfig?: HealthConfig
): LspTransport {
  return new LspTransport(serverId, serverType, healthConfig);
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
