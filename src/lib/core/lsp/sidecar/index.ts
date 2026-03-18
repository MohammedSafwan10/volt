/**
 * LSP Sidecar Infrastructure
 * 
 * This module provides infrastructure for running real language servers
 * as sidecar processes and connecting them to Monaco Editor.
 * 
 * Architecture:
 * - Backend (Rust): Spawns and manages LSP server processes
 * - Transport: JSON-RPC communication via Tauri events
 * - Registry: Manages multiple server connections
 * 
 * Usage:
 * ```typescript
 * import { getLspRegistry, initLspRegistry } from '$core/lsp/sidecar';
 * 
 * // Initialize with project root
 * initLspRegistry('/path/to/project');
 * 
 * // Start a TypeScript server
 * const registry = getLspRegistry();
 * const transport = await registry.startServer('typescript');
 * 
 * // Send LSP requests
 * const result = await transport.sendRequest('initialize', { ... });
 * 
 * // Diagnostics are emitted by the Rust LSP manager and applied centrally.
 * // Use transport notifications for editor features and server-specific events.
 * 
 * // Stop when done
 * await registry.stopAll();
 * ```
 */

// Types
export type {
  LspServerConfig,
  LspServerInfo,
  LspServerType,
  LspServerStatus,
  LspError,
  LspTrackedDocumentSyncResult,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcMessage,
  MessageHandler,
  ErrorHandler,
  ExitHandler,
  HealthHandler,
  HealthConfig,
  HealthStatus,
  RestartPolicy,
} from './types';

// Constants
export { DEFAULT_HEALTH_CONFIG, DEFAULT_RESTART_POLICY } from './types';

// Transport
export {
  LspTransport,
  createTransport,
  listServers,
  getServerInfo,
  isServerRunning,
  stopAllServers,
} from './transport';

// Registry
export {
  getLspRegistry,
  initLspRegistry,
  disposeLspRegistry,
} from './register';

export {
  sendDidSaveForTrackedDocument,
  getTrackedDocumentPathSet,
} from './document-lifecycle';

export {
  applyBackendDiagnostics,
  applyBackendDiagnosticsSourceState,
  clearBackendDiagnosticsFile,
  type BackendLspDiagnosticsClearFileEvent,
  type BackendLspDiagnosticsEvent,
  type BackendLspDiagnosticsSourceStateEvent,
} from './diagnostics';

export {
  createLspRecoveryController,
  LspRecoveryController,
  type LspRecoveryControllerOptions,
  type LspRecoveryState,
} from './recovery';

export {
  dispatchWatchedFileChanges,
  normalizeWatchedFileChanges,
  resetWatchedFileDispatch,
  type WatchedFileChange,
  type WatchedFileChangeKind,
} from './watched-files';
