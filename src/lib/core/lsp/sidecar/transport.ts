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
  LspTrackedDocumentSyncResult,
  LspTrackedDocumentInfo,
  MessageHandler,
  ErrorHandler,
  ExitHandler,
  RestartHandler,
  HealthHandler,
  HealthConfig,
  HealthStatus,
  LspRecoveryState,
  RestartPolicy,
} from './types';
import { DEFAULT_HEALTH_CONFIG, DEFAULT_RESTART_POLICY } from './types';
import {
  applyBackendDiagnostics,
  applyBackendDiagnosticsSourceState,
  clearBackendDiagnosticsFile,
  type BackendLspDiagnosticsClearFileEvent,
  type BackendLspDiagnosticsEvent,
  type BackendLspDiagnosticsSourceStateEvent,
} from './diagnostics';

/** Pending request tracking */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timestamp: number;
}

function formatTransportError(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    const candidate =
      ('message' in error && typeof error.message === 'string' && error.message) ||
      ('type' in error && typeof error.type === 'string' && error.type) ||
      JSON.stringify(error);
    return candidate;
  }

  return String(error ?? 'Unknown LSP error');
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
  private restartHandlers: Set<RestartHandler> = new Set();
  private healthHandlers: Set<HealthHandler> = new Set();
  private pendingRequests: Map<number | string, PendingRequest> = new Map();
  private nextRequestId = 1;
  private unlisteners: UnlistenFn[] = [];
  private isConnected = false;
  private isRestarting = false;
  private restartCount = 0;
  private restartPolicy: Required<RestartPolicy> = { ...DEFAULT_RESTART_POLICY };
  private recoveryState: LspRecoveryState = {
    scheduled: false,
    restarting: false,
    attemptsInWindow: 0,
  };
  private exitHandled = false;

  // Health monitoring state
  private healthConfig: Required<HealthConfig>;
  private healthStatus: HealthStatus = {
    healthy: true,
    lastResponseAt: null,
    consecutiveFailures: 0,
    lastCheckAt: null,
    avgResponseTimeMs: null,
    message: 'Not started',
  };

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
    restartCount: number;
    recoveryState: LspRecoveryState;
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
      restartCount: this.restartCount,
      recoveryState: { ...this.recoveryState },
    };
  }


  /**
   * Start the LSP server sidecar and set up event listeners
   */
  async start(config: Omit<LspServerConfig, 'serverId' | 'serverType'>): Promise<LspServerInfo> {
    // Start the server via Tauri command
    const info = await invoke<LspServerInfo>('lsp_start_server_managed', {
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
    this.exitHandled = false;
    await this.resetRecoveryState();

    // Start health monitoring
    this.startHealthMonitoring();

    return info;
  }

  /**
   * Start an external LSP server (from user's PATH) and set up event listeners
   */
  async startExternal(config: Omit<ExternalLspConfig, 'serverId' | 'serverType'>): Promise<LspServerInfo> {
    // Start the external server via Tauri command
    const info = await invoke<LspServerInfo>('lsp_start_external_server_managed', {
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
    this.exitHandled = false;
    await this.resetRecoveryState();

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

    const restartedUnlisten = await listen<LspServerInfo>(
      `lsp://${this.serverId}//restarted`,
      (event) => {
        void this.handleServerRestarted(event.payload);
      }
    );
    this.unlisteners.push(restartedUnlisten);

    const diagnosticsUnlisten = await listen<BackendLspDiagnosticsEvent>(
      `lsp://${this.serverId}//diagnostics`,
      (event) => {
        applyBackendDiagnostics(event.payload);
      }
    );
    this.unlisteners.push(diagnosticsUnlisten);

    const diagnosticsClearUnlisten = await listen<BackendLspDiagnosticsClearFileEvent>(
      `lsp://${this.serverId}//diagnostics-clear-file`,
      (event) => {
        clearBackendDiagnosticsFile(event.payload);
      }
    );
    this.unlisteners.push(diagnosticsClearUnlisten);

    const diagnosticsStateUnlisten = await listen<BackendLspDiagnosticsSourceStateEvent>(
      `lsp://${this.serverId}//diagnostics-source-state`,
      (event) => {
        applyBackendDiagnosticsSourceState(event.payload);
      }
    );
    this.unlisteners.push(diagnosticsStateUnlisten);

    const healthUnlisten = await listen<HealthStatus>(
      `lsp://${this.serverId}//health`,
      (event) => {
        void this.handleMonitoredHealthStatus(event.payload);
      }
    );
    this.unlisteners.push(healthUnlisten);
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
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    this.isConnected = false;
    this.stopHealthMonitoring();
    this.updateHealthStatus({
      healthy: false,
      lastCheckAt: Date.now(),
      message: 'Server exited',
    });

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Server exited'));
      this.pendingRequests.delete(id);
    }

    if (this.isRestarting) {
      return;
    }

    if (this.restartPolicy.enabled) {
      void this.scheduleRecovery('transport exit');
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
  private notifyError(error: unknown): void {
    const message = formatTransportError(error);
    for (const handler of this.errorHandlers) {
      try {
        handler(message);
      } catch (e) {
        console.error('[LSP Transport] Error handler error:', e);
      }
    }
  }

  private async handleServerRestarted(info: LspServerInfo): Promise<void> {
    this.isConnected = true;
    this.exitHandled = false;
    this.updateHealthStatus({
      healthy: true,
      lastResponseAt: Date.now(),
      consecutiveFailures: 0,
      message: 'Server restarted',
    });
    await this.resetRecoveryState();
    this.startHealthMonitoring();
    this.restartCount += 1;

    for (const handler of this.restartHandlers) {
      try {
        handler(info);
      } catch (e) {
        console.error('[LSP Transport] Restart handler error:', e);
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

    this.stopHealthMonitoring();

    // Update initial status
    this.updateHealthStatus({
      healthy: true,
      lastResponseAt: Date.now(),
      consecutiveFailures: 0,
      message: 'Server started',
    });
    void invoke('lsp_start_health_monitoring', {
      serverId: this.serverId,
      intervalMs: this.healthConfig.intervalMs,
      failureThreshold: this.healthConfig.failureThreshold,
    });

    console.log(`[LSP Health] Started monitoring for ${this.serverId} (interval: ${this.healthConfig.intervalMs}ms)`);
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    void invoke('lsp_stop_health_monitoring', {
      serverId: this.serverId,
    });
  }

  /**
   * Perform a single health check
   */
  private async performHealthCheck(): Promise<void> {
    try {
      const wasHealthy = this.healthStatus.healthy;
      const nextStatus = await invoke<HealthStatus>('lsp_check_health', {
        serverId: this.serverId,
        transportConnected: this.isConnected,
        failureThreshold: this.healthConfig.failureThreshold,
      });
      const isUnhealthy =
        !nextStatus.healthy &&
        nextStatus.consecutiveFailures >= this.healthConfig.failureThreshold;

      this.updateHealthStatus(nextStatus);

      // Only log on state transition (healthy -> unhealthy) to reduce noise
      if (wasHealthy && isUnhealthy) {
        console.warn(
          `[LSP Health] ${this.serverId} became unhealthy after ${nextStatus.consecutiveFailures} failures`,
        );
      }

      // Stop monitoring once threshold is reached (no infinite loop)
      if (isUnhealthy) {
        console.log(`[LSP Health] Stopping monitoring for ${this.serverId} (unhealthy)`);
        this.stopHealthMonitoring();

        // Auto-restart if configured
        if (this.healthConfig.autoRestart && this.restartPolicy.enabled) {
          console.log(`[LSP Health] Auto-restarting unhealthy server: ${this.serverId}`);
          this.notifyError(`Server unhealthy, attempting restart...`);
          await this.scheduleRecovery('health-check failure');
        }
      }
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
        if (this.healthConfig.autoRestart && this.restartPolicy.enabled) {
          console.log(`[LSP Health] Auto-restarting unhealthy server: ${this.serverId}`);
          this.notifyError(`Server unhealthy, attempting restart...`);
          await this.scheduleRecovery('health-check failure');
        }
      }
    }
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
  if (this.isConnected) {
    this.stopHealthMonitoring();
    if (this.healthConfig.enabled) {
      this.startHealthMonitoring();
    }
  }
}

configureRestartPolicy(policy: RestartPolicy): void {
  this.restartPolicy = { ...this.restartPolicy, ...policy };
  if (!this.restartPolicy.enabled) {
    this.recoveryState = {
      scheduled: false,
      restarting: false,
      attemptsInWindow: 0,
    };
    void this.resetRecoveryState();
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

  async syncDocument(filePath: string, languageId: string, text: string): Promise<LspTrackedDocumentSyncResult> {
    if (!this.isConnected) {
      throw new Error('Transport not connected');
    }

    return invoke<LspTrackedDocumentSyncResult>('lsp_sync_document', {
      serverId: this.serverId,
      filePath,
      languageId,
      text,
    });
  }

  async closeDocument(filePath: string): Promise<boolean> {
    if (!this.isConnected) {
      throw new Error('Transport not connected');
    }

    return invoke<boolean>('lsp_close_document', {
      serverId: this.serverId,
      filePath,
    });
  }

  async listTrackedDocuments(): Promise<LspTrackedDocumentInfo[]> {
    if (!this.isConnected) {
      return [];
    }

    return invoke<LspTrackedDocumentInfo[]>('lsp_list_tracked_documents', {
      serverId: this.serverId,
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

  onRestart(handler: RestartHandler): () => void {
  this.restartHandlers.add(handler);
  return() => this.restartHandlers.delete(handler);
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
  await this.resetRecoveryState();

  // Remove all event listeners
  for(const unlisten of this.unlisteners) {
  unlisten();
}
this.unlisteners = [];

// Stop the server
if (this.isConnected) {
  try {
    await invoke('lsp_stop_server', {
      serverId: this.serverId,
      preserveState: false,
    });
  } catch (e) {
    console.error('[LSP Transport] Error stopping server:', e);
  }
}

this.isConnected = false;
this.messageHandlers.clear();
this.errorHandlers.clear();
this.exitHandlers.clear();
this.restartHandlers.clear();
this.healthHandlers.clear();
this.pendingRequests.clear();
this.recoveryState = {
  scheduled: false,
  restarting: false,
  attemptsInWindow: 0,
};
  }

  private async restartFromSavedConfig(): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    this.isRestarting = true;

    try {
      await invoke('lsp_restart_server', {
        serverId: this.serverId,
      });

      this.isConnected = true;
      this.exitHandled = false;
      this.startHealthMonitoring();

      this.restartCount += 1;
      this.recoveryState = {
        scheduled: false,
        restarting: false,
        attemptsInWindow: 0,
      };
    } catch (error) {
      this.notifyError(`Failed to auto-restart server: ${formatTransportError(error)}`);
    } finally {
      this.isRestarting = false;
    }
  }

  private async handleMonitoredHealthStatus(status: HealthStatus): Promise<void> {
    const wasHealthy = this.healthStatus.healthy;
    const isUnhealthy =
      !status.healthy &&
      status.consecutiveFailures >= this.healthConfig.failureThreshold;

    this.updateHealthStatus(status);

    if (wasHealthy && isUnhealthy) {
      console.warn(
        `[LSP Health] ${this.serverId} became unhealthy after ${status.consecutiveFailures} failures`,
      );
    }

    if (isUnhealthy && this.healthConfig.autoRestart && this.restartPolicy.enabled) {
      console.log(`[LSP Health] Auto-restarting unhealthy server: ${this.serverId}`);
      this.notifyError(`Server unhealthy, attempting restart...`);
      await this.scheduleRecovery('health-check failure');
    }
  }

  private async scheduleRecovery(reason: string): Promise<void> {
    if (!this.restartPolicy.enabled) {
      return;
    }

    try {
      this.recoveryState = await invoke<LspRecoveryState>('lsp_schedule_recovery', {
        serverId: this.serverId,
        reason,
        baseDelayMs: this.restartPolicy.baseDelayMs,
        maxDelayMs: this.restartPolicy.maxDelayMs,
        maxAttempts: this.restartPolicy.maxAttempts,
        windowMs: this.restartPolicy.windowMs,
      });
    } catch (error) {
      this.notifyError(`Failed to schedule backend recovery: ${formatTransportError(error)}`);
    }
  }

  private async resetRecoveryState(): Promise<void> {
    this.recoveryState = {
      scheduled: false,
      restarting: false,
      attemptsInWindow: 0,
    };

    try {
      this.recoveryState = await invoke<LspRecoveryState>('lsp_reset_recovery', {
        serverId: this.serverId,
      });
    } catch {
      // Keep the local transport state cleared even if the backend server never started.
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
