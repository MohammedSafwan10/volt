/**
 * LSP Sidecar Types
 * 
 * Type definitions for the LSP sidecar infrastructure
 */

/** Configuration for starting an LSP server sidecar */
export interface LspServerConfig {
  /** Unique identifier for this server instance */
  serverId: string;
  /** Server type (e.g., "typescript", "tailwind", "eslint", "svelte") */
  serverType: LspServerType;
  /** Sidecar name (matches externalBin in tauri.conf.json) */
  sidecarName: string;
  /** Relative path to the server entrypoint script within the app bundle resources (or dev workspace). */
  entrypoint: string;
  /** Arguments for the language server (e.g. --stdio). */
  args: string[];
  /** Working directory (usually project root) */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
}

/** Configuration for starting an external LSP server (from user's PATH) */
export interface ExternalLspConfig {
  /** Unique identifier for this server instance */
  serverId: string;
  /** Server type (e.g., "dart", "rust-analyzer", "gopls") */
  serverType: LspServerType;
  /** Command to execute (e.g., "dart", "rust-analyzer") */
  command: string;
  /** Arguments for the command (e.g., ["language-server", "--client-id", "volt"]) */
  args: string[];
  /** Working directory (usually project root) */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
}

/** Supported LSP server types */
export type LspServerType =
  | 'typescript'
  | 'tailwind'
  | 'eslint'
  | 'svelte'
  | 'html'
  | 'css'
  | 'json'
  | 'dart'
  | 'yaml'
  | 'xml';

/** Whether a server type is external (from PATH) or bundled (sidecar) */
export function isExternalServerType(serverType: LspServerType): boolean {
  return serverType === 'dart' || serverType === 'yaml' || serverType === 'xml';
}

/** Information about a running LSP server */
export interface LspServerInfo {
  serverId: string;
  serverType: string;
  pid: number | null;
  status: LspServerStatus;
}

/** Status of an LSP server */
export type LspServerStatus =
  | 'Starting'
  | 'Running'
  | 'Stopping'
  | 'Stopped'
  | 'Error';

/** LSP error from backend */
export interface LspError {
  type: 'ServerNotFound' | 'ServerAlreadyRunning' | 'SpawnFailed' | 'SendFailed' | 'ProcessError' | 'InvalidConfig';
  server_id?: string;
  message?: string;
}

/** JSON-RPC request message */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC notification message (no id) */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** JSON-RPC response message */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC error */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Union type for all JSON-RPC messages */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Callback for handling incoming messages */
export type MessageHandler = (message: JsonRpcMessage) => void;

/** Callback for handling errors */
export type ErrorHandler = (error: string) => void;

/** Callback for handling server exit */
export type ExitHandler = () => void;

/** Callback for handling health status changes */
export type HealthHandler = (status: HealthStatus) => void;

/** Health check configuration */
export interface HealthConfig {
  /** Enable health monitoring (default: true) */
  enabled?: boolean;
  /** Interval between health checks in ms (default: 30000 = 30s) */
  intervalMs?: number;
  /** Timeout for health check response in ms (default: 5000 = 5s) */
  timeoutMs?: number;
  /** Number of consecutive failures before marking unhealthy (default: 3) */
  failureThreshold?: number;
  /** Auto-restart on unhealthy (default: false) */
  autoRestart?: boolean;
}

/** Default health configuration */
export const DEFAULT_HEALTH_CONFIG: Required<HealthConfig> = {
  enabled: true,
  intervalMs: 30000, // 30 seconds
  timeoutMs: 5000,   // 5 seconds
  failureThreshold: 3,
  autoRestart: false,
};

/** Health status of an LSP server */
export interface HealthStatus {
  /** Whether the server is considered healthy */
  healthy: boolean;
  /** Last successful response timestamp */
  lastResponseAt: number | null;
  /** Consecutive failure count */
  consecutiveFailures: number;
  /** Last health check timestamp */
  lastCheckAt: number | null;
  /** Average response time in ms (rolling average of last 10) */
  avgResponseTimeMs: number | null;
  /** Detailed status message */
  message: string;
}
