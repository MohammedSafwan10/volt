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

import { getLspRegistry, type LspTransport, type JsonRpcMessage } from './sidecar';
import { problemsStore, type Problem, type ProblemSeverity } from '$lib/stores/problems.svelte';
import { projectStore } from '$lib/stores/project.svelte';

// Server instance tracking
let jsonServerTransport: LspTransport | null = null;
let jsonServerInitialized = false;
let initializationPromise: Promise<void> | null = null;

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

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
  const normalizedPath = filepath.replace(/\\/g, '/');
  if (normalizedPath.match(/^[a-zA-Z]:/)) {
    return `file:///${normalizedPath}`;
  }
  return `file://${normalizedPath}`;
}

/**
 * Convert URI to file path
 */
function uriToPath(uri: string): string {
  let path = uri.replace('file://', '');
  if (path.match(/^\/[a-zA-Z]:/)) {
    path = path.slice(1);
  }
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

  problemsStore.setProblemsForFile(filePath, problems, 'json');
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
        cwd: projectStore.rootPath ?? undefined
      });

      jsonServerTransport.onMessage(handleLspMessage);
      jsonServerTransport.onError((error) => {
        console.error('[JSON LSP] Server error:', error);
      });
      jsonServerTransport.onExit(() => {
        console.log('[JSON LSP] Server exited');
        jsonServerTransport = null;
        jsonServerInitialized = false;
        initializationPromise = null;
        openDocuments.clear();
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

  await initializeServer();
  if (!jsonServerTransport || !jsonServerInitialized) return;

  const uri = pathToUri(filepath);
  const existing = openDocuments.get(filepath);

  if (existing) {
    if (existing.content !== content) {
      existing.version++;
      existing.content = content;
      await jsonServerTransport.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: content }]
      });
    }
  } else {
    openDocuments.set(filepath, { version: 1, content });
    await jsonServerTransport.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: getLanguageId(filepath),
        version: 1,
        text: content
      }
    });
  }
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
export async function stopJsonLsp(): Promise<void> {
  if (!jsonServerTransport) return;

  try {
    await jsonServerTransport.sendRequest('shutdown', null);
    await jsonServerTransport.sendNotification('exit', null);
  } catch {
    // Ignore errors during shutdown
  }

  jsonServerTransport = null;
  jsonServerInitialized = false;
  initializationPromise = null;
  openDocuments.clear();
}
