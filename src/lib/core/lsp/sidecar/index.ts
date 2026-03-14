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
 * // Listen for notifications
 * transport.onMessage((msg) => {
 *   if ('method' in msg && msg.method === 'textDocument/publishDiagnostics') {
 *     // Handle diagnostics
 *   }
 * });
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
} from './types';

// Constants
export { DEFAULT_HEALTH_CONFIG } from './types';

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
  rehydrateTrackedDocuments,
  sendDidSaveForTrackedDocument,
} from './document-lifecycle';
