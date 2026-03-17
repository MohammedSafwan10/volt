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
import { readFileQuiet } from '$core/services/file-system';
import { getAllFiles } from '$core/services/file-index';

// Server instance tracking
let cssServerTransport: LspTransport | null = null;
let cssServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
let cssSessionGeneration = 0;
const cssRecovery = createLspRecoveryController({
  source: 'css',
  restart: async () => {
    await recoverCssLspAfterExit();
  },
});

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();
const PROJECT_ANALYSIS_BATCH_SIZE = 10;
const PROJECT_ANALYSIS_BATCH_DELAY_MS = 20;
let projectAnalysisRunId = 0;

function normalizeCssFilePath(filepath: string): string {
  return filepath.replace(/\\/g, '/');
}

function prioritizeProjectFiles<T extends { path: string }>(files: T[]): T[] {
  const active = new Set(
    Array.from(openDocuments.keys()).map((path) => normalizeCssFilePath(path)),
  );

  return [...files].sort((a, b) => {
    const aActive = active.has(normalizeCssFilePath(a.path)) ? 0 : 1;
    const bActive = active.has(normalizeCssFilePath(b.path)) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return normalizeCssFilePath(a.path).localeCompare(normalizeCssFilePath(b.path));
  });
}

async function rehydrateOpenDocuments(): Promise<void> {
  await rehydrateTrackedDocuments(openDocuments, notifyCssDocumentOpened);
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
      cssServerTransport?.sendResponse(id, result);
    } else {
      cssServerTransport?.sendResponse(id, null);
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

  setSourceProblemsForFile({
    source: 'css',
    generation: cssSessionGeneration,
    filePath,
    problems,
  });
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
      cssSessionGeneration = startSourceSession('css');

      cssServerTransport.onMessage(handleLspMessage);
      cssServerTransport.onError((error) => {
        console.error('[CSS LSP] Server error:', error);
      });
      cssServerTransport.onExit(() => {
        console.log('[CSS LSP] Server exited');
        cssSessionGeneration = markSourceSessionStale('css');
        cssRecovery.schedule('transport exit');
        cssServerTransport = null;
        cssServerInitialized = false;
        initializationPromise = null;
        openDocuments.clear();
      });
      cssServerTransport.onRestart(async () => {
        cssSessionGeneration = startSourceSession('css');
        markSourceSessionReady('css', cssSessionGeneration);
        await rehydrateOpenDocuments();
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
      markSourceSessionReady('css', cssSessionGeneration);
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

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(filepath);
  if (existing && existing.content === content) return;

  if (!cssServerTransport || !cssServerInitialized) return;

  const uri = pathToUri(filepath);
  const languageId = getLanguageId(filepath);

  // Track document
  openDocuments.set(filepath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await cssServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await cssServerTransport.sendNotification('textDocument/didOpen', {
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
  clearSourceProblemsForFile({
    source: 'css',
    generation: cssSessionGeneration,
    filePath: filepath,
  });
}

export async function notifyCssDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isCssFile(filepath)) return;
  await sendDidSaveForTrackedDocument({
    filepath,
    content,
    openDocuments,
    transport: cssServerTransport,
    initialized: cssServerInitialized,
    ensureOpen: notifyCssDocumentOpened,
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
  openDocuments.clear();
  cssSessionGeneration = markSourceSessionStale('css');
  cssRecovery.reset();
}

/**
 * Perform background analysis of all CSS files in the project
 */
export async function startProjectWideAnalysis(): Promise<void> {
  if (!projectStore.rootPath) return;

  const runId = ++projectAnalysisRunId;

  const allFiles = getAllFiles();
  const cssFiles = prioritizeProjectFiles(allFiles.filter(f => isCssFile(f.path)));

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
    if (openDocuments.has(normalizedPath)) continue;

    const content = await readFileQuiet(file.path);
    if (runId !== projectAnalysisRunId) {
      return;
    }

    if (content) {
      // This will automatically initialize server if needed
      await notifyCssDocumentOpened(normalizedPath, content);
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
