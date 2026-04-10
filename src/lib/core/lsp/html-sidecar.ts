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

import {
  getLspRegistry,
  sendDidSaveForTrackedDocument,
  type LspTransport,
  type JsonRpcMessage,
} from './sidecar';
import { projectStore } from '$shared/stores/project.svelte';
import { readFileQuiet } from '$core/services/file-system';
import { getAllFiles } from '$core/services/file-index';
import { waitForProjectDiagnosticsDelay } from '$core/services/project-diagnostics-timing';

// Server instance tracking
let htmlServerTransport: LspTransport | null = null;
let htmlServerInitialized = false;
let initializationPromise: Promise<void> | null = null;

const PROJECT_ANALYSIS_BATCH_SIZE = 10;
const PROJECT_ANALYSIS_BATCH_DELAY_MS = 20;
let projectAnalysisRunId = 0;

function normalizeHtmlFilePath(filepath: string): string {
  return filepath.replace(/\\/g, '/');
}

function prioritizeProjectFiles<T extends { path: string }>(files: T[], active: Set<string>): T[] {
  return [...files].sort((a, b) => {
    const aActive = active.has(normalizeHtmlFilePath(a.path)) ? 0 : 1;
    const bActive = active.has(normalizeHtmlFilePath(b.path)) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return normalizeHtmlFilePath(a.path).localeCompare(normalizeHtmlFilePath(b.path));
  });
}

async function getTrackedDocumentPaths(): Promise<Set<string>> {
  if (!htmlServerTransport || !htmlServerInitialized) {
    return new Set();
  }

  const tracked = await htmlServerTransport.listTrackedDocuments();
  return new Set(tracked.map((document) => normalizeHtmlFilePath(document.filePath)));
}

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
        cwd: projectStore.rootPath ?? undefined,
        restartPolicy: {
          enabled: true,
          baseDelayMs: 1000,
          maxDelayMs: 12_000,
          maxAttempts: 4,
          windowMs: 120_000,
        },
      });

      // Disable health monitoring for HTML server to prevent false positive timeouts
      // HTML server can be slow to respond during initial project load
      htmlServerTransport.configureHealth({ enabled: false });

      htmlServerTransport.onMessage(handleLspMessage);
      htmlServerTransport.onError((error) => {
        console.error('[HTML LSP] Server error:', error);
      });
      htmlServerTransport.onExit(() => {
        console.log('[HTML LSP] Server exited');
        htmlServerInitialized = false;
        initializationPromise = null;
      });
      htmlServerTransport.onRestart(() => {
        console.log('[HTML LSP] Server restarted');
        htmlServerInitialized = true;
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

  if (!htmlServerTransport || !htmlServerInitialized) return;

  const languageId = getLanguageId(filepath);
  await htmlServerTransport.syncDocument(filepath, languageId, content);
}

/**
 * Notify the server that a document was changed
 */
export async function notifyHtmlDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isHtmlFile(filepath)) return;
  if (!htmlServerTransport || !htmlServerInitialized) return;

  await htmlServerTransport.syncDocument(filepath, getLanguageId(filepath), content);
}

/**
 * Notify the server that a document was closed
 */
export async function notifyHtmlDocumentClosed(filepath: string): Promise<void> {
  if (!htmlServerTransport || !htmlServerInitialized) return;
  await htmlServerTransport.closeDocument(filepath);
}

export async function notifyHtmlDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isHtmlFile(filepath)) return;
  await sendDidSaveForTrackedDocument({
    filepath,
    content,
    transport: htmlServerTransport,
    initialized: htmlServerInitialized,
    languageId: getLanguageId(filepath),
    pathToUri,
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

  const transport = htmlServerTransport;

  try {
    await transport.sendRequest('shutdown', null);
    await transport.sendNotification('exit', null);
  } catch {
    // Ignore errors during shutdown
  }

  await transport.stop();

  htmlServerTransport = null;
  htmlServerInitialized = false;
  initializationPromise = null;
}

/**
 * Perform background analysis of all HTML files in the project
 */
export async function startProjectWideAnalysis(): Promise<void> {
  if (!projectStore.rootPath) return;

  const runId = ++projectAnalysisRunId;
  const trackedDocumentPaths = await getTrackedDocumentPaths();

  const allFiles = getAllFiles();
  const htmlFiles = prioritizeProjectFiles(
    allFiles.filter((f) => isHtmlFile(f.path)),
    trackedDocumentPaths,
  );

  if (htmlFiles.length === 0) {
    console.log('[HTML LSP] No HTML files found for background analysis.');
    return;
  }

  console.log(`[HTML LSP] Starting project-wide analysis of ${htmlFiles.length} files...`);

  let processedSinceYield = 0;

  for (const file of htmlFiles) {
    if (runId !== projectAnalysisRunId) {
      return;
    }

    const normalizedPath = normalizeHtmlFilePath(file.path);

    // Only open if not already open (prevent double-counting)
    if (trackedDocumentPaths.has(normalizedPath)) continue;

    const content = await readFileQuiet(file.path);
    if (runId !== projectAnalysisRunId) {
      return;
    }

    if (content) {
      // This will automatically initialize server if needed
      await notifyHtmlDocumentOpened(normalizedPath, content);
      trackedDocumentPaths.add(normalizedPath);
      processedSinceYield += 1;

      if (processedSinceYield >= PROJECT_ANALYSIS_BATCH_SIZE) {
        processedSinceYield = 0;
        await waitForProjectDiagnosticsDelay(PROJECT_ANALYSIS_BATCH_DELAY_MS);
        if (runId !== projectAnalysisRunId) {
          return;
        }
      }
    }
  }
}
