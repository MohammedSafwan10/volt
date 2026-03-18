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

import {
  getLspRegistry,
  sendDidSaveForTrackedDocument,
  createLspRecoveryController,
  type LspTransport,
  type JsonRpcMessage,
} from './sidecar';
import { projectStore } from '$shared/stores/project.svelte';
import { readFileQuiet } from '$core/services/file-system';
import { getAllFiles } from '$core/services/file-index';

// Server instance tracking
let cssServerTransport: LspTransport | null = null;
let cssServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
const cssRecovery = createLspRecoveryController({
  source: 'css',
  restart: async () => {
    await recoverCssLspAfterExit();
  },
});

const PROJECT_ANALYSIS_BATCH_SIZE = 10;
const PROJECT_ANALYSIS_BATCH_DELAY_MS = 20;
let projectAnalysisRunId = 0;

function normalizeCssFilePath(filepath: string): string {
  return filepath.replace(/\\/g, '/');
}

function prioritizeProjectFiles<T extends { path: string }>(files: T[], active: Set<string>): T[] {
  return [...files].sort((a, b) => {
    const aActive = active.has(normalizeCssFilePath(a.path)) ? 0 : 1;
    const bActive = active.has(normalizeCssFilePath(b.path)) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return normalizeCssFilePath(a.path).localeCompare(normalizeCssFilePath(b.path));
  });
}

async function getTrackedDocumentPaths(): Promise<Set<string>> {
  if (!cssServerTransport || !cssServerInitialized) {
    return new Set();
  }

  const tracked = await cssServerTransport.listTrackedDocuments();
  return new Set(tracked.map((document) => normalizeCssFilePath(document.filePath)));
}

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
      cssServerTransport?.sendResponse(id, result);
    } else {
      cssServerTransport?.sendResponse(id, null);
    }
    return;
  }

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
        cwd: projectStore.rootPath ?? undefined,
        restartPolicy: {
          enabled: true,
          baseDelayMs: 1000,
          maxDelayMs: 12_000,
          maxAttempts: 4,
          windowMs: 120_000,
        },
      });
      cssServerTransport.configureHealth({ autoRestart: true });

      cssServerTransport.onMessage(handleLspMessage);
      cssServerTransport.onError((error) => {
        console.error('[CSS LSP] Server error:', error);
      });
      cssServerTransport.onExit(() => {
        console.log('[CSS LSP] Server exited');
        cssRecovery.schedule('transport exit');
        cssServerTransport = null;
        cssServerInitialized = false;
        initializationPromise = null;
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
      cssRecovery.reset();
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

  // Initialize server if needed
  await initializeServer();

  if (!cssServerTransport || !cssServerInitialized) return;

  const languageId = getLanguageId(filepath);
  await cssServerTransport.syncDocument(filepath, languageId, content);
}

/**
 * Notify the server that a document was changed
 */
export async function notifyCssDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isCssFile(filepath)) return;
  if (!cssServerTransport || !cssServerInitialized) return;

  await cssServerTransport.syncDocument(filepath, getLanguageId(filepath), content);
}

/**
 * Notify the server that a document was closed
 */
export async function notifyCssDocumentClosed(filepath: string): Promise<void> {
  if (!cssServerTransport || !cssServerInitialized) return;
  await cssServerTransport.closeDocument(filepath);
}

export async function notifyCssDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isCssFile(filepath)) return;
  await sendDidSaveForTrackedDocument({
    filepath,
    content,
    transport: cssServerTransport,
    initialized: cssServerInitialized,
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
async function recoverCssLspAfterExit(): Promise<void> {
  if (!projectStore.rootPath || cssServerTransport || initializationPromise) {
    return;
  }
  await initializeServer();
}

export async function stopCssLsp(): Promise<void> {
  if (!cssServerTransport) return;

  const transport = cssServerTransport;

  try {
    await transport.sendRequest('shutdown', null);
    await transport.sendNotification('exit', null);
  } catch {
    // Ignore errors during shutdown
  }

  await transport.stop();

  cssServerTransport = null;
  cssServerInitialized = false;
  initializationPromise = null;
  cssRecovery.reset();
}

/**
 * Perform background analysis of all CSS files in the project
 */
export async function startProjectWideAnalysis(): Promise<void> {
  if (!projectStore.rootPath) return;

  const runId = ++projectAnalysisRunId;
  const trackedDocumentPaths = await getTrackedDocumentPaths();

  const allFiles = getAllFiles();
  const cssFiles = prioritizeProjectFiles(
    allFiles.filter((f) => isCssFile(f.path)),
    trackedDocumentPaths,
  );

  if (cssFiles.length === 0) {
    console.log('[CSS LSP] No CSS/SCSS files found for background analysis.');
    return;
  }

  console.log(`[CSS LSP] Starting project-wide analysis of ${cssFiles.length} files...`);

  let processedSinceYield = 0;

  for (const file of cssFiles) {
    if (runId !== projectAnalysisRunId) {
      return;
    }

    const normalizedPath = normalizeCssFilePath(file.path);

    // Only open if not already open (prevent double-counting)
    if (trackedDocumentPaths.has(normalizedPath)) continue;

    const content = await readFileQuiet(file.path);
    if (runId !== projectAnalysisRunId) {
      return;
    }

    if (content) {
      // This will automatically initialize server if needed
      await notifyCssDocumentOpened(normalizedPath, content);
      trackedDocumentPaths.add(normalizedPath);
      processedSinceYield += 1;

      if (processedSinceYield >= PROJECT_ANALYSIS_BATCH_SIZE) {
        processedSinceYield = 0;
        await new Promise(r => setTimeout(r, PROJECT_ANALYSIS_BATCH_DELAY_MS));
        if (runId !== projectAnalysisRunId) {
          return;
        }
      }
    }
  }
}
