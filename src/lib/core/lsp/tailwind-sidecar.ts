/**
 * Tailwind CSS LSP Sidecar Service
 * 
 * Provides Tailwind IntelliSense using the real @tailwindcss/language-server:
 * - Class completions in className attributes
 * - Hover shows generated CSS
 * - Diagnostics for invalid classes
 * 
 * Strategy:
 * - Start server when opening files that commonly contain Tailwind classes:
 *   .tsx/.jsx/.ts/.js, .css/.scss, .svelte, .html
 * - Must read workspace tailwind.config.*
 */

import { getLspRegistry, type LspTransport, type JsonRpcMessage } from './sidecar';
import { problemsStore, type Problem, type ProblemSeverity } from '$shared/stores/problems.svelte';
import { projectStore } from '$shared/stores/project.svelte';
import { registerTailwindMonacoProviders, disposeTailwindMonacoProviders } from './tailwind-monaco-providers';

// Server instance tracking
let tailwindServerTransport: LspTransport | null = null;
let tailwindServerInitialized = false;
let initializationPromise: Promise<void> | null = null;

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

async function rehydrateOpenDocuments(): Promise<void> {
  if (!tailwindServerTransport || !tailwindServerInitialized) return;
  const docs = Array.from(openDocuments.entries());
  openDocuments.clear();
  for (const [filepath, doc] of docs) {
    await notifyTailwindDocumentOpened(filepath, doc.content);
  }
}

// Debounce timers
const diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_DEBOUNCE_MS = 150;

/**
 * File extensions that commonly contain Tailwind classes
 */
const TAILWIND_FILE_EXTENSIONS = [
  'tsx', 'jsx', 'ts', 'js', 'mts', 'cts', 'mjs', 'cjs',
  'css', 'scss', 'less',
  'svelte',
  'html', 'vue'
];

/**
 * Check if a file may contain Tailwind classes
 */
export function isTailwindFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return TAILWIND_FILE_EXTENSIONS.includes(ext);
}

/**
 * Get the language ID for LSP
 */
function getLanguageId(filepath: string): string {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'typescriptreact';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascriptreact';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    case 'svelte':
      return 'svelte';
    case 'html':
      return 'html';
    case 'vue':
      return 'vue';
    default:
      return 'plaintext';
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
 * Convert URI to file path (normalized with forward slashes)
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
      tailwindServerTransport?.sendResponse(id, result);
    } else {
      tailwindServerTransport?.sendResponse(id, null);
    }
    return;
  }

  // Handle notifications
  if ('method' in message && !('id' in message)) {
    if (message.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(message.params as PublishDiagnosticsParams);
    } else if (message.method === 'window/logMessage') {
      const params = message.params as { type: number; message: string };
      console.log(`[Tailwind LSP] ${params.message}`);
    }
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
 * Handle diagnostics from the LSP server
 */
function handleDiagnostics(params: PublishDiagnosticsParams): void {
  const filePath = uriToPath(params.uri);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  const problems: Problem[] = params.diagnostics.map((diag, index) => ({
    id: `tailwind:${filePath}:${diag.range.start.line}:${diag.range.start.character}:${index}`,
    file: filePath,
    fileName,
    line: diag.range.start.line + 1, // LSP is 0-based, we use 1-based
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    severity: mapSeverity(diag.severity ?? 2), // Default to warning for Tailwind
    source: diag.source || 'tailwindcss',
    code: diag.code?.toString()
  }));

  // Merge with existing problems (don't overwrite TS problems)
  problemsStore.setProblemsForFile(filePath, problems, 'tailwindcss');
}


/**
 * Initialize the Tailwind CSS language server
 */
async function initializeServer(): Promise<void> {
  if (tailwindServerInitialized || !projectStore.rootPath) {
    return;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      const registry = getLspRegistry();

      // Start the Tailwind server
      tailwindServerTransport = await registry.startServer('tailwind', {
        serverId: 'tailwind-main',
        cwd: projectStore.rootPath ?? undefined
      });

      // Set up message handler
      tailwindServerTransport.onMessage(handleLspMessage);

      // Set up error handler
      tailwindServerTransport.onError((error) => {
        console.error('[Tailwind LSP] Server error:', error);
      });

      // Set up exit handler
      tailwindServerTransport.onExit(() => {
        console.log('[Tailwind LSP] Server exited');
        problemsStore.markSourceStale('tailwindcss');
        tailwindServerTransport = null;
        tailwindServerInitialized = false;
        initializationPromise = null;
        openDocuments.clear();
      });
      tailwindServerTransport.onRestart(async () => {
        problemsStore.markSourceFresh('tailwindcss');
        await rehydrateOpenDocuments();
      });

      // Send initialize request
      const rootUri = pathToUri(projectStore.rootPath!);

      const initResult = await tailwindServerTransport.sendRequest('initialize', {
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
                commitCharactersSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                deprecatedSupport: true,
                preselectSupport: true,
                insertReplaceSupport: true,
                labelDetailsSupport: true,
                resolveSupport: {
                  properties: ['documentation', 'detail', 'additionalTextEdits']
                }
              },
              contextSupport: true
            },
            hover: {
              dynamicRegistration: true,
              contentFormat: ['markdown', 'plaintext']
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: {
                valueSet: [1, 2]
              },
              codeDescriptionSupport: true
            },
            codeAction: {
              dynamicRegistration: true,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: ['quickfix']
                }
              }
            },
            colorProvider: {
              dynamicRegistration: true
            }
          },
          workspace: {
            applyEdit: true,
            workspaceEdit: {
              documentChanges: true
            },
            didChangeConfiguration: {
              dynamicRegistration: true
            },
            didChangeWatchedFiles: {
              dynamicRegistration: true
            },
            configuration: true,
            workspaceFolders: true
          }
        },
        workspaceFolders: [
          {
            uri: rootUri,
            name: projectStore.projectName
          }
        ],
        initializationOptions: {
          // Tailwind-specific settings
          userLanguages: {
            // Map file extensions to language IDs for Tailwind
            'javascript': 'javascript',
            'javascriptreact': 'javascriptreact',
            'typescript': 'typescript',
            'typescriptreact': 'typescriptreact',
            'svelte': 'html',
            'vue': 'html'
          }
        }
      });

      console.log('[Tailwind LSP] Server initialized:', initResult);

      // Send initialized notification
      await tailwindServerTransport.sendNotification('initialized', {});

      tailwindServerInitialized = true;

      // Register Monaco providers
      registerTailwindMonacoProviders();
    } catch (error) {
      console.error('[Tailwind LSP] Failed to initialize server:', error);
      tailwindServerTransport = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}


/**
 * Notify the server that a document was opened
 */
export async function notifyTailwindDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isTailwindFile(filepath)) return;
  if (!projectStore.rootPath) return;

  // Initialize server if needed
  await initializeServer();

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(filepath);
  if (existing && existing.content === content) return;

  if (!tailwindServerTransport || !tailwindServerInitialized) return;

  const uri = pathToUri(filepath);
  const languageId = getLanguageId(filepath);

  // Track document
  openDocuments.set(filepath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await tailwindServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await tailwindServerTransport.sendNotification('textDocument/didOpen', {
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
export async function notifyTailwindDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isTailwindFile(filepath)) return;
  if (!tailwindServerTransport || !tailwindServerInitialized) return;

  const doc = openDocuments.get(filepath);
  if (!doc) {
    // Document wasn't opened, open it now
    await notifyTailwindDocumentOpened(filepath, content);
    return;
  }

  // Update version
  doc.version++;
  doc.content = content;

  const uri = pathToUri(filepath);

  // Debounce the change notification
  const existingTimer = diagnosticDebounceTimers.get(filepath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  diagnosticDebounceTimers.set(filepath, setTimeout(async () => {
    diagnosticDebounceTimers.delete(filepath);

    if (!tailwindServerTransport || !tailwindServerInitialized) return;

    // Send didChange notification with full content
    await tailwindServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: doc.version
      },
      contentChanges: [{ text: content }]
    });
  }, DIAGNOSTIC_DEBOUNCE_MS));
}

/**
 * Notify the server that a document was saved
 */
export async function notifyTailwindDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isTailwindFile(filepath)) return;
  if (!tailwindServerTransport || !tailwindServerInitialized) return;

  const uri = pathToUri(filepath);

  await tailwindServerTransport.sendNotification('textDocument/didSave', {
    textDocument: { uri },
    text: content
  });
}

/**
 * Notify the server that a document was closed
 */
export async function notifyTailwindDocumentClosed(filepath: string): Promise<void> {
  if (!isTailwindFile(filepath)) return;
  if (!tailwindServerTransport || !tailwindServerInitialized) return;

  openDocuments.delete(filepath);

  const uri = pathToUri(filepath);

  await tailwindServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri }
  });

  // Clear Tailwind problems for this file
  problemsStore.clearProblemsForFile(filepath, 'tailwindcss');
}


/**
 * Request completions at a position
 */
export async function getTailwindCompletions(
  filepath: string,
  line: number,
  character: number
): Promise<CompletionItem[] | null> {
  if (!isTailwindFile(filepath)) return null;
  if (!tailwindServerTransport || !tailwindServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tailwindServerTransport.sendRequest<CompletionList | CompletionItem[] | null>(
      'textDocument/completion',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    if (!result) return null;

    // Handle both CompletionList and CompletionItem[] responses
    if (Array.isArray(result)) {
      return result;
    }
    return result.items || [];
  } catch (error) {
    console.error('[Tailwind LSP] Completion error:', error);
    return null;
  }
}

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  sortText?: string;
  filterText?: string;
  data?: unknown;
}

interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

export interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

/**
 * Request hover information at a position
 */
export async function getTailwindHover(
  filepath: string,
  line: number,
  character: number
): Promise<HoverResult | null> {
  if (!isTailwindFile(filepath)) return null;
  if (!tailwindServerTransport || !tailwindServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tailwindServerTransport.sendRequest<HoverResult | null>(
      'textDocument/hover',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    return result;
  } catch (error) {
    console.error('[Tailwind LSP] Hover error:', error);
    return null;
  }
}

export interface HoverResult {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Request document colors (for color swatches)
 */
export async function getTailwindDocumentColors(
  filepath: string
): Promise<ColorInformation[] | null> {
  if (!isTailwindFile(filepath)) return null;
  if (!tailwindServerTransport || !tailwindServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tailwindServerTransport.sendRequest<ColorInformation[] | null>(
      'textDocument/documentColor',
      {
        textDocument: { uri }
      }
    );

    return result;
  } catch (error) {
    console.error('[Tailwind LSP] Document color error:', error);
    return null;
  }
}

export interface ColorInformation {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  color: {
    red: number;
    green: number;
    blue: number;
    alpha: number;
  };
}

/**
 * Request color presentations
 */
export async function getTailwindColorPresentations(
  filepath: string,
  color: { red: number; green: number; blue: number; alpha: number },
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
): Promise<ColorPresentation[] | null> {
  if (!isTailwindFile(filepath)) return null;
  if (!tailwindServerTransport || !tailwindServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tailwindServerTransport.sendRequest<ColorPresentation[] | null>(
      'textDocument/colorPresentation',
      {
        textDocument: { uri },
        color,
        range
      }
    );

    return result;
  } catch (error) {
    console.error('[Tailwind LSP] Color presentation error:', error);
    return null;
  }
}

export interface ColorPresentation {
  label: string;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
}


/**
 * Check if the Tailwind LSP is initialized
 */
export function isTailwindLspInitialized(): boolean {
  return tailwindServerInitialized;
}

/**
 * Check if the Tailwind LSP is connected
 */
export function isTailwindLspConnected(): boolean {
  return tailwindServerTransport?.connected ?? false;
}

/**
 * Stop the Tailwind LSP server
 */
export async function stopTailwindLsp(): Promise<void> {
  // Dispose Monaco providers first
  disposeTailwindMonacoProviders();

  if (tailwindServerTransport) {
    try {
      // Send shutdown request
      await tailwindServerTransport.sendRequest('shutdown', null);
      // Send exit notification
      await tailwindServerTransport.sendNotification('exit', null);
    } catch {
      // Ignore errors during shutdown
    }

    await tailwindServerTransport.stop();
    tailwindServerTransport = null;
  }

  tailwindServerInitialized = false;
  initializationPromise = null;
  openDocuments.clear();

  // Clear all diagnostic timers
  for (const timer of diagnosticDebounceTimers.values()) {
    clearTimeout(timer);
  }
  diagnosticDebounceTimers.clear();
}

/**
 * Restart the Tailwind LSP server
 */
export async function restartTailwindLsp(): Promise<void> {
  await stopTailwindLsp();

  // Re-initialize if there's a project open
  if (projectStore.rootPath) {
    await initializeServer();
  }
}
