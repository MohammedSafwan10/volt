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
  rehydrateTrackedDocuments,
  sendDidSaveForTrackedDocument,
  markSourceSessionReady,
  markSourceSessionStale,
  setSourceProblemsForFile,
  clearSourceProblemsForFile,
  startSourceSession,
  createLspRecoveryController,
  type LspTransport,
  type JsonRpcMessage,
} from './sidecar';
import { type Problem, type ProblemSeverity } from '$shared/stores/problems.svelte';
import { projectStore } from '$shared/stores/project.svelte';

// Server instance tracking
let jsonServerTransport: LspTransport | null = null;
let jsonServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
let jsonSessionGeneration = 0;
const jsonRecovery = createLspRecoveryController({
  source: 'json',
  restart: async () => {
    await recoverJsonLspAfterExit();
  },
});

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

async function rehydrateOpenDocuments(): Promise<void> {
  await rehydrateTrackedDocuments(openDocuments, notifyJsonDocumentOpened);
}

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
 * Convert URI to file path
 */
function uriToPath(uri: string): string {
  let path = uri.replace('file://', '');
  // Handle Windows paths (file:///C:/...)
  if (path.match(/^\/[a-zA-Z]:/)) {
    path = path.slice(1);
  }
  // Normalize drive letter to lowercase for consistency
  if (path.match(/^[a-zA-Z]:/)) {
    path = path[0].toLowerCase() + path.slice(1);
  }
  // Normalize to forward slashes for consistency with editorStore
  return path.replace(/\\/g, '/');
}

/**
 * Map LSP severity to our severity
 */
function mapSeverity(lspSeverity: number): ProblemSeverity {
  switch (lspSeverity) {
    case 1: return 'error';
    case 2: return 'warning';
    case 3: return 'info';
    case 4: return 'hint';
    default: return 'info';
  }
}

interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number;
  code?: number | string;
  source?: string;
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
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

  // Handle notifications
  if ('method' in message && !('id' in message)) {
    if (message.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(message.params as PublishDiagnosticsParams);
    }
  }
}

/**
 * Handle diagnostics from the LSP server
 */
function handleDiagnostics(params: PublishDiagnosticsParams): void {
  const filePath = uriToPath(params.uri);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  const problems: Problem[] = params.diagnostics.map((diag, index) => ({
    id: `json:${filePath}:${diag.range.start.line}:${diag.range.start.character}:${index}`,
    file: filePath,
    fileName,
    line: diag.range.start.line + 1,
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    severity: mapSeverity(diag.severity ?? 1),
    source: diag.source || 'json',
    code: diag.code?.toString()
  }));

  setSourceProblemsForFile({
    source: 'json',
    generation: jsonSessionGeneration,
    filePath,
    problems,
  });
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
      jsonSessionGeneration = startSourceSession('json');

      jsonServerTransport.onMessage(handleLspMessage);
      jsonServerTransport.onError((error) => {
        console.error('[JSON LSP] Server error:', error);
      });
      jsonServerTransport.onExit(() => {
        console.log('[JSON LSP] Server exited');
        jsonSessionGeneration = markSourceSessionStale('json');
        jsonRecovery.schedule('transport exit');
        jsonServerTransport = null;
        jsonServerInitialized = false;
        initializationPromise = null;
        openDocuments.clear();
      });
      jsonServerTransport.onRestart(async () => {
        jsonSessionGeneration = startSourceSession('json');
        markSourceSessionReady('json', jsonSessionGeneration);
        await rehydrateOpenDocuments();
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
      markSourceSessionReady('json', jsonSessionGeneration);
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

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(filepath);
  if (existing && existing.content === content) return;

  if (!jsonServerTransport || !jsonServerInitialized) return;

  const uri = pathToUri(filepath);
  const languageId = getLanguageId(filepath);

  // Track document
  openDocuments.set(filepath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await jsonServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await jsonServerTransport.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId,
      version: 1,
      text: content
    }
  });
}

/**
 * Notify the server that a document was changed
 */
export async function notifyJsonDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isJsonFile(filepath)) return;
  if (!jsonServerTransport || !jsonServerInitialized) return;

  const existing = openDocuments.get(filepath);
  if (!existing) {
    await notifyJsonDocumentOpened(filepath, content);
    return;
  }

  existing.version++;
  existing.content = content;

  await jsonServerTransport.sendNotification('textDocument/didChange', {
    textDocument: { uri: pathToUri(filepath), version: existing.version },
    contentChanges: [{ text: content }]
  });
}

/**
 * Notify the server that a document was closed
 */
export async function notifyJsonDocumentClosed(filepath: string): Promise<void> {
  if (!jsonServerTransport || !jsonServerInitialized) return;
  if (!openDocuments.has(filepath)) return;

  openDocuments.delete(filepath);
  await jsonServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri: pathToUri(filepath) }
  });
  clearSourceProblemsForFile({
    source: 'json',
    generation: jsonSessionGeneration,
    filePath: filepath,
  });
}

export async function notifyJsonDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isJsonFile(filepath)) return;
  await sendDidSaveForTrackedDocument({
    filepath,
    content,
    openDocuments,
    transport: jsonServerTransport,
    initialized: jsonServerInitialized,
    ensureOpen: notifyJsonDocumentOpened,
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
  openDocuments.clear();
  jsonSessionGeneration = markSourceSessionStale('json');
  jsonRecovery.reset();
}
