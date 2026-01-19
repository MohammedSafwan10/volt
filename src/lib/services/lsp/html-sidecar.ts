/**
 * HTML LSP Sidecar Service
 * 
 * Provides HTML language intelligence using vscode-html-language-server:
 * - Completions (tags, attributes, events)
 * - Hover information
 * - Go to definition (for linked resources)
 * - Formatting
 * - Diagnostics
 * 
 * Strategy:
 * - Start server when opening an HTML file
 * - Workspace root = projectStore.rootPath
 */

import { getLspRegistry, type LspTransport, type JsonRpcMessage } from './sidecar';
import { problemsStore, type Problem, type ProblemSeverity } from '$lib/stores/problems.svelte';
import { projectStore } from '$lib/stores/project.svelte';

// Server instance tracking
let htmlServerTransport: LspTransport | null = null;
let htmlServerInitialized = false;
let initializationPromise: Promise<void> | null = null;

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

/**
 * Check if a file is an HTML file
 */
export function isHtmlFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ['html', 'htm'].includes(ext);
}

/**
 * Get the language ID for LSP
 */
function getLanguageId(_filepath: string): string {
  return 'html';
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
      htmlServerTransport?.sendResponse(id, result);
    } else {
      htmlServerTransport?.sendResponse(id, null);
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
    id: `html:${filePath}:${diag.range.start.line}:${diag.range.start.character}:${index}`,
    file: filePath,
    fileName,
    line: diag.range.start.line + 1,
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    severity: mapSeverity(diag.severity ?? 1),
    source: diag.source || 'html',
    code: diag.code?.toString()
  }));

  problemsStore.setProblemsForFile(filePath, problems, 'html');
}

/**
 * Initialize the HTML language server
 */
async function initializeServer(): Promise<void> {
  if (!projectStore.rootPath) return;
  if (htmlServerInitialized) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    try {
      const registry = getLspRegistry();

      htmlServerTransport = await registry.startServer('html', {
        serverId: 'html-main',
        cwd: projectStore.rootPath ?? undefined
      });

      htmlServerTransport.onMessage(handleLspMessage);
      htmlServerTransport.onError((error) => {
        console.error('[HTML LSP] Server error:', error);
      });
      htmlServerTransport.onExit(() => {
        console.log('[HTML LSP] Server exited');
        htmlServerTransport = null;
        htmlServerInitialized = false;
        initializationPromise = null;
        openDocuments.clear();
      });

      const rootUri = pathToUri(projectStore.rootPath!);

      await htmlServerTransport.sendRequest('initialize', {
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
            definition: {
              dynamicRegistration: true
            },
            references: {
              dynamicRegistration: true
            },
            formatting: {
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
        ]
      });

      await htmlServerTransport.sendNotification('initialized', {});
      htmlServerInitialized = true;
      console.log('[HTML LSP] Server initialized');
    } catch (error) {
      console.error('[HTML LSP] Failed to initialize:', error);
      htmlServerTransport = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Notify the server that a document was opened
 */
export async function notifyHtmlDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isHtmlFile(filepath)) return;
  if (!projectStore.rootPath) return;

  // Initialize server if needed
  await initializeServer();

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(filepath);
  if (existing && existing.content === content) return;

  if (!htmlServerTransport || !htmlServerInitialized) return;

  const uri = pathToUri(filepath);
  const languageId = getLanguageId(filepath);

  // Track document
  openDocuments.set(filepath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await htmlServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await htmlServerTransport.sendNotification('textDocument/didOpen', {
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
export async function notifyHtmlDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isHtmlFile(filepath)) return;
  if (!htmlServerTransport || !htmlServerInitialized) return;

  const existing = openDocuments.get(filepath);
  if (!existing) {
    await notifyHtmlDocumentOpened(filepath, content);
    return;
  }

  existing.version++;
  existing.content = content;

  await htmlServerTransport.sendNotification('textDocument/didChange', {
    textDocument: { uri: pathToUri(filepath), version: existing.version },
    contentChanges: [{ text: content }]
  });
}

/**
 * Notify the server that a document was closed
 */
export async function notifyHtmlDocumentClosed(filepath: string): Promise<void> {
  if (!htmlServerTransport || !htmlServerInitialized) return;
  if (!openDocuments.has(filepath)) return;

  openDocuments.delete(filepath);
  await htmlServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri: pathToUri(filepath) }
  });
}

export interface Location {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Request hover information
 */
export async function getHtmlHover(
  filepath: string,
  line: number,
  character: number
): Promise<{ contents: unknown; range?: unknown } | null> {
  if (!isHtmlFile(filepath)) return null;
  if (!htmlServerTransport || !htmlServerInitialized) return null;

  try {
    const result = await htmlServerTransport.sendRequest('textDocument/hover', {
      textDocument: { uri: pathToUri(filepath) },
      position: { line, character }
    });
    return result as { contents: unknown; range?: unknown } | null;
  } catch (error) {
    console.error('[HTML LSP] Hover error:', error);
    return null;
  }
}

/**
 * Request definition location
 */
export async function getHtmlDefinition(
  filepath: string,
  line: number,
  character: number
): Promise<Location[] | null> {
  if (!isHtmlFile(filepath)) return null;
  if (!htmlServerTransport || !htmlServerInitialized) return null;

  try {
    const result = await htmlServerTransport.sendRequest<Location | Location[] | null>(
      'textDocument/definition',
      {
        textDocument: { uri: pathToUri(filepath) },
        position: { line, character }
      }
    );
    if (!result) return null;
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    console.error('[HTML LSP] Definition error:', error);
    return null;
  }
}

/**
 * Request references
 */
export async function getHtmlReferences(
  filepath: string,
  line: number,
  character: number,
  includeDeclaration = true
): Promise<Location[] | null> {
  if (!isHtmlFile(filepath)) return null;
  if (!htmlServerTransport || !htmlServerInitialized) return null;

  try {
    const result = await htmlServerTransport.sendRequest<Location[] | null>(
      'textDocument/references',
      {
        textDocument: { uri: pathToUri(filepath) },
        position: { line, character },
        context: { includeDeclaration }
      }
    );
    return result;
  } catch (error) {
    console.error('[HTML LSP] References error:', error);
    return null;
  }
}

/**
 * Check if HTML LSP is initialized
 */
export function isHtmlLspInitialized(): boolean {
  return htmlServerInitialized;
}

/**
 * Check if HTML LSP is connected
 */
export function isHtmlLspConnected(): boolean {
  return htmlServerTransport !== null && htmlServerInitialized;
}

/**
 * Ensure HTML LSP is started
 */
export async function ensureHtmlLspStarted(): Promise<void> {
  if (!htmlServerInitialized) {
    await initializeServer();
  }
}

/**
 * Stop the HTML LSP server
 */
export async function stopHtmlLsp(): Promise<void> {
  if (!htmlServerTransport) return;

  try {
    await htmlServerTransport.sendRequest('shutdown', null);
    await htmlServerTransport.sendNotification('exit', null);
  } catch {
    // Ignore errors during shutdown
  }

  htmlServerTransport = null;
  htmlServerInitialized = false;
  initializationPromise = null;
  openDocuments.clear();
}
