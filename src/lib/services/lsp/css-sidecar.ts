/**
 * CSS LSP Sidecar Service
 * 
 * Provides CSS/SCSS/LESS language intelligence using vscode-css-language-server:
 * - Completions (properties, values, selectors)
 * - Hover information (property docs)
 * - Go to definition (variables, mixins)
 * - Color picker
 * - Diagnostics
 * 
 * Strategy:
 * - Start server when opening a CSS/SCSS/LESS file
 * - Workspace root = projectStore.rootPath
 */

import { getLspRegistry, type LspTransport, type JsonRpcMessage } from './sidecar';
import { problemsStore, type Problem, type ProblemSeverity } from '$lib/stores/problems.svelte';
import { projectStore } from '$lib/stores/project.svelte';

// Server instance tracking
let cssServerTransport: LspTransport | null = null;
let cssServerInitialized = false;
let initializationPromise: Promise<void> | null = null;

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

/**
 * Check if a file is a CSS file
 */
export function isCssFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ['css', 'scss', 'sass', 'less'].includes(ext);
}

/**
 * Get the language ID for LSP
 */
function getLanguageId(filepath: string): string {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'scss': return 'scss';
    case 'sass': return 'sass';
    case 'less': return 'less';
    default: return 'css';
  }
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
    id: `css:${filePath}:${diag.range.start.line}:${diag.range.start.character}:${index}`,
    file: filePath,
    fileName,
    line: diag.range.start.line + 1,
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    severity: mapSeverity(diag.severity ?? 1),
    source: diag.source || 'css',
    code: diag.code?.toString()
  }));

  problemsStore.setProblemsForFile(filePath, problems, 'css');
}

/**
 * Initialize the CSS language server
 */
async function initializeServer(): Promise<void> {
  if (!projectStore.rootPath) return;
  if (cssServerInitialized) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    try {
      const registry = getLspRegistry();
      
      cssServerTransport = await registry.startServer('css', {
        serverId: 'css-main',
        cwd: projectStore.rootPath ?? undefined
      });

      cssServerTransport.onMessage(handleLspMessage);
      cssServerTransport.onError((error) => {
        console.error('[CSS LSP] Server error:', error);
      });
      cssServerTransport.onExit(() => {
        console.log('[CSS LSP] Server exited');
        cssServerTransport = null;
        cssServerInitialized = false;
        initializationPromise = null;
        openDocuments.clear();
      });

      const rootUri = pathToUri(projectStore.rootPath!);
      
      await cssServerTransport.sendRequest('initialize', {
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
            colorProvider: {
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

      await cssServerTransport.sendNotification('initialized', {});
      cssServerInitialized = true;
      console.log('[CSS LSP] Server initialized');
    } catch (error) {
      console.error('[CSS LSP] Failed to initialize:', error);
      cssServerTransport = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Notify the server that a document was opened
 */
export async function notifyCssDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isCssFile(filepath)) return;
  if (!projectStore.rootPath) return;

  await initializeServer();
  if (!cssServerTransport || !cssServerInitialized) return;

  const uri = pathToUri(filepath);
  const existing = openDocuments.get(filepath);

  if (existing) {
    if (existing.content !== content) {
      existing.version++;
      existing.content = content;
      await cssServerTransport.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: content }]
      });
    }
  } else {
    openDocuments.set(filepath, { version: 1, content });
    await cssServerTransport.sendNotification('textDocument/didOpen', {
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
export async function notifyCssDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isCssFile(filepath)) return;
  if (!cssServerTransport || !cssServerInitialized) return;

  const existing = openDocuments.get(filepath);
  if (!existing) {
    await notifyCssDocumentOpened(filepath, content);
    return;
  }

  existing.version++;
  existing.content = content;

  await cssServerTransport.sendNotification('textDocument/didChange', {
    textDocument: { uri: pathToUri(filepath), version: existing.version },
    contentChanges: [{ text: content }]
  });
}

/**
 * Notify the server that a document was closed
 */
export async function notifyCssDocumentClosed(filepath: string): Promise<void> {
  if (!cssServerTransport || !cssServerInitialized) return;
  if (!openDocuments.has(filepath)) return;

  openDocuments.delete(filepath);
  await cssServerTransport.sendNotification('textDocument/didClose', {
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
export async function getCssHover(
  filepath: string,
  line: number,
  character: number
): Promise<{ contents: unknown; range?: unknown } | null> {
  if (!isCssFile(filepath)) return null;
  if (!cssServerTransport || !cssServerInitialized) return null;

  try {
    const result = await cssServerTransport.sendRequest('textDocument/hover', {
      textDocument: { uri: pathToUri(filepath) },
      position: { line, character }
    });
    return result as { contents: unknown; range?: unknown } | null;
  } catch (error) {
    console.error('[CSS LSP] Hover error:', error);
    return null;
  }
}

/**
 * Request definition location (for CSS variables, mixins, etc.)
 */
export async function getCssDefinition(
  filepath: string,
  line: number,
  character: number
): Promise<Location[] | null> {
  if (!isCssFile(filepath)) return null;
  if (!cssServerTransport || !cssServerInitialized) return null;

  try {
    const result = await cssServerTransport.sendRequest<Location | Location[] | null>(
      'textDocument/definition',
      {
        textDocument: { uri: pathToUri(filepath) },
        position: { line, character }
      }
    );
    if (!result) return null;
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    console.error('[CSS LSP] Definition error:', error);
    return null;
  }
}

/**
 * Request references (for CSS variables, classes, etc.)
 */
export async function getCssReferences(
  filepath: string,
  line: number,
  character: number,
  includeDeclaration = true
): Promise<Location[] | null> {
  if (!isCssFile(filepath)) return null;
  if (!cssServerTransport || !cssServerInitialized) return null;

  try {
    const result = await cssServerTransport.sendRequest<Location[] | null>(
      'textDocument/references',
      {
        textDocument: { uri: pathToUri(filepath) },
        position: { line, character },
        context: { includeDeclaration }
      }
    );
    return result;
  } catch (error) {
    console.error('[CSS LSP] References error:', error);
    return null;
  }
}

/**
 * Check if CSS LSP is initialized
 */
export function isCssLspInitialized(): boolean {
  return cssServerInitialized;
}

/**
 * Check if CSS LSP is connected
 */
export function isCssLspConnected(): boolean {
  return cssServerTransport !== null && cssServerInitialized;
}

/**
 * Ensure CSS LSP is started
 */
export async function ensureCssLspStarted(): Promise<void> {
  if (!cssServerInitialized) {
    await initializeServer();
  }
}

/**
 * Stop the CSS LSP server
 */
export async function stopCssLsp(): Promise<void> {
  if (!cssServerTransport) return;

  try {
    await cssServerTransport.sendRequest('shutdown', null);
    await cssServerTransport.sendNotification('exit', null);
  } catch {
    // Ignore errors during shutdown
  }

  cssServerTransport = null;
  cssServerInitialized = false;
  initializationPromise = null;
  openDocuments.clear();
}
