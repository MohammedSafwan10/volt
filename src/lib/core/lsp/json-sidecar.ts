/**
 * JSON LSP Sidecar Service
 * 
 * Provides JSON language intelligence using vscode-json-language-server:
 * - Completions (from JSON schemas)
 * - Hover information (from schemas)
 * - Diagnostics (syntax errors, schema validation)
 * - Formatting
 * 
 * Strategy:
 * - Start server when opening a JSON file
 * - Workspace root = projectStore.rootPath
 * - Supports package.json, tsconfig.json, etc. with built-in schemas
 */

import {
  getLspRegistry,
  sendDidSaveForTrackedDocument,
  createLspRecoveryController,
  type LspTransport,
  type JsonRpcMessage,
} from './sidecar';
import { projectStore } from '$shared/stores/project.svelte';

// Server instance tracking
let jsonServerTransport: LspTransport | null = null;
let jsonServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
const jsonRecovery = createLspRecoveryController({
  source: 'json',
  restart: async () => {
    await recoverJsonLspAfterExit();
  },
});

/**
 * Check if a file is a JSON file
 */
export function isJsonFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ['json', 'jsonc'].includes(ext);
}

/**
 * Get the language ID for LSP
 */
function getLanguageId(filepath: string): string {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'jsonc') return 'jsonc';
  // Check for common JSONC files (with comments)
  const filename = filepath.split(/[/\\]/).pop()?.toLowerCase() || '';
  if (filename === 'tsconfig.json' || filename === 'jsconfig.json') {
    return 'jsonc';
  }
  return 'json';
}

/**
 * Convert file path to URI
 */
function pathToUri(filepath: string): string {
  // Handle Windows paths
  let normalizedPath = filepath.replace(/\\/g, '/');
  // Normalize drive letter to lowercase for consistency
  if (normalizedPath.match(/^[a-zA-Z]:/)) {
    normalizedPath = normalizedPath[0].toLowerCase() + normalizedPath.slice(1);
  }
  const encodedPath = encodeURI(normalizedPath);
  if (normalizedPath.match(/^[a-zA-Z]:/)) {
    return `file:///${encodedPath}`;
  }
  return `file://${encodedPath}`;
}

/**
 * Handle incoming LSP messages
 */
function handleLspMessage(message: JsonRpcMessage): void {
  // Handle server requests that require a response
  if ('id' in message && 'method' in message && message.id !== null) {
    const id = message.id;
    if (message.method === 'workspace/configuration') {
      const items = (message.params as any)?.items || [];
      const result = items.map(() => ({}));
      jsonServerTransport?.sendResponse(id, result);
    } else {
      jsonServerTransport?.sendResponse(id, null);
    }
    return;
  }

}

/**
 * Initialize the JSON language server
 */
async function initializeServer(): Promise<void> {
  if (!projectStore.rootPath) return;
  if (jsonServerInitialized) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    try {
      const registry = getLspRegistry();

      jsonServerTransport = await registry.startServer('json', {
        serverId: 'json-main',
        cwd: projectStore.rootPath ?? undefined,
        restartPolicy: {
          enabled: true,
          baseDelayMs: 1000,
          maxDelayMs: 12_000,
          maxAttempts: 4,
          windowMs: 120_000,
        },
      });
      jsonServerTransport.configureHealth({ autoRestart: true });

      jsonServerTransport.onMessage(handleLspMessage);
      jsonServerTransport.onError((error) => {
        console.error('[JSON LSP] Server error:', error);
      });
      jsonServerTransport.onExit(() => {
        console.log('[JSON LSP] Server exited');
        jsonRecovery.schedule('transport exit');
        jsonServerTransport = null;
        jsonServerInitialized = false;
        initializationPromise = null;
      });

      const rootUri = pathToUri(projectStore.rootPath!);

      await jsonServerTransport.sendRequest('initialize', {
        processId: null,
        rootUri,
        rootPath: projectStore.rootPath,
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: true,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true
            },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext']
              }
            },
            hover: {
              dynamicRegistration: true,
              contentFormat: ['markdown', 'plaintext']
            },
            formatting: {
              dynamicRegistration: true
            },
            rangeFormatting: {
              dynamicRegistration: true
            },
            publishDiagnostics: {
              relatedInformation: true
            }
          },
          workspace: {
            applyEdit: true,
            workspaceEdit: { documentChanges: true },
            configuration: true,
            workspaceFolders: true
          }
        },
        workspaceFolders: [
          { uri: rootUri, name: projectStore.projectName }
        ],
        initializationOptions: {
          provideFormatter: true
        }
      });

      await jsonServerTransport.sendNotification('initialized', {});
      jsonServerInitialized = true;
      jsonRecovery.reset();
      console.log('[JSON LSP] Server initialized');
    } catch (error) {
      console.error('[JSON LSP] Failed to initialize:', error);
      jsonServerTransport = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Notify the server that a document was opened
 */
export async function notifyJsonDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isJsonFile(filepath)) return;
  if (!projectStore.rootPath) return;

  // Initialize server if needed
  await initializeServer();

  if (!jsonServerTransport || !jsonServerInitialized) return;

  const languageId = getLanguageId(filepath);
  await jsonServerTransport.syncDocument(filepath, languageId, content);
}

/**
 * Notify the server that a document was changed
 */
export async function notifyJsonDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isJsonFile(filepath)) return;
  if (!jsonServerTransport || !jsonServerInitialized) return;

  await jsonServerTransport.syncDocument(filepath, getLanguageId(filepath), content);
}

/**
 * Notify the server that a document was closed
 */
export async function notifyJsonDocumentClosed(filepath: string): Promise<void> {
  if (!jsonServerTransport || !jsonServerInitialized) return;
  await jsonServerTransport.closeDocument(filepath);
}

export async function notifyJsonDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isJsonFile(filepath)) return;
  await sendDidSaveForTrackedDocument({
    filepath,
    content,
    transport: jsonServerTransport,
    initialized: jsonServerInitialized,
    languageId: getLanguageId(filepath),
    pathToUri,
  });
}

/**
 * Request hover information
 */
export async function getJsonHover(
  filepath: string,
  line: number,
  character: number
): Promise<{ contents: unknown; range?: unknown } | null> {
  if (!isJsonFile(filepath)) return null;
  if (!jsonServerTransport || !jsonServerInitialized) return null;

  try {
    const result = await jsonServerTransport.sendRequest('textDocument/hover', {
      textDocument: { uri: pathToUri(filepath) },
      position: { line, character }
    });
    return result as { contents: unknown; range?: unknown } | null;
  } catch (error) {
    console.error('[JSON LSP] Hover error:', error);
    return null;
  }
}

/**
 * Check if JSON LSP is initialized
 */
export function isJsonLspInitialized(): boolean {
  return jsonServerInitialized;
}

/**
 * Check if JSON LSP is connected
 */
export function isJsonLspConnected(): boolean {
  return jsonServerTransport !== null && jsonServerInitialized;
}

/**
 * Ensure JSON LSP is started
 */
export async function ensureJsonLspStarted(): Promise<void> {
  if (!jsonServerInitialized) {
    await initializeServer();
  }
}

/**
 * Stop the JSON LSP server
 */
async function recoverJsonLspAfterExit(): Promise<void> {
  if (!projectStore.rootPath || jsonServerTransport || initializationPromise) {
    return;
  }
  await initializeServer();
}

export async function stopJsonLsp(): Promise<void> {
  if (!jsonServerTransport) return;

  const transport = jsonServerTransport;

  try {
    await transport.sendRequest('shutdown', null);
    await transport.sendNotification('exit', null);
  } catch {
    // Ignore errors during shutdown
  }

  await transport.stop();

  jsonServerTransport = null;
  jsonServerInitialized = false;
  initializationPromise = null;
  jsonRecovery.reset();
}
