/**
 * Svelte LSP Sidecar Service
 * 
 * Provides full Svelte language intelligence using the real svelte-language-server:
 * - Diagnostics (errors, warnings)
 * - Completions (components, props, runes)
 * - Hover information
 * - Go to definition
 * - Find references
 * 
 * Strategy:
 * - Start server when opening a .svelte file in a project
 * - Workspace root = projectStore.rootPath
 * - Must respect workspace svelte.config.js
 */

import { getLspRegistry, type LspTransport, type JsonRpcMessage } from './sidecar';
import { problemsStore, type Problem, type ProblemSeverity } from '$lib/stores/problems.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { registerSvelteMonacoProviders, disposeSvelteMonacoProviders } from './svelte-monaco-providers';

// Server instance tracking
let svelteServerTransport: LspTransport | null = null;
let svelteServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializedRootPath: string | null = null;

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

// Debounce timers
const diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_DEBOUNCE_MS = 150;

/**
 * Check if a file is a Svelte file
 */
export function isSvelteFile(filepath: string): boolean {
  return filepath.toLowerCase().endsWith('.svelte');
}

/**
 * Get the language ID for LSP
 */
function getLanguageId(_filepath: string): string {
  return 'svelte';
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
      svelteServerTransport?.sendResponse(id, result);
    } else {
      svelteServerTransport?.sendResponse(id, null);
    }
    return;
  }

  // Handle notifications
  if ('method' in message && !('id' in message)) {
    if (message.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(message.params as PublishDiagnosticsParams);
    } else if (message.method === 'window/logMessage') {
      const params = message.params as { type: number; message: string };
      console.log(`[Svelte LSP] ${params.message}`);
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
    id: `svelte:${filePath}:${diag.range.start.line}:${diag.range.start.character}:${index}`,
    file: filePath,
    fileName,
    line: diag.range.start.line + 1, // LSP is 0-based, we use 1-based
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    severity: mapSeverity(diag.severity ?? 1),
    source: diag.source || 'svelte',
    code: diag.code?.toString()
  }));

  problemsStore.setProblemsForFile(filePath, problems, 'svelte');
}

/**
 * Initialize the Svelte language server
 */
async function initializeServer(): Promise<void> {
  if (!projectStore.rootPath) return;

  // If the workspace root changed, the server will reject new documents.
  // Restart to re-bind to the new root.
  if (svelteServerInitialized && initializedRootPath && projectStore.rootPath !== initializedRootPath) {
    await stopSvelteLsp();
  }

  if (svelteServerInitialized) return;

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      const registry = getLspRegistry();

      // Start the Svelte server
      svelteServerTransport = await registry.startServer('svelte', {
        serverId: 'svelte-main',
        cwd: projectStore.rootPath ?? undefined
      });

      // Set up message handler
      svelteServerTransport.onMessage(handleLspMessage);

      // Set up error handler
      svelteServerTransport.onError((error) => {
        console.error('[Svelte LSP] Server error:', error);
      });

      // Set up exit handler
      svelteServerTransport.onExit(() => {
        console.log('[Svelte LSP] Server exited');
        svelteServerTransport = null;
        svelteServerInitialized = false;
        initializationPromise = null;
        initializedRootPath = null;
        openDocuments.clear();
      });

      // Send initialize request
      const rootUri = pathToUri(projectStore.rootPath!);

      const initResult = await svelteServerTransport.sendRequest('initialize', {
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
            signatureHelp: {
              dynamicRegistration: true,
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: {
                  labelOffsetSupport: true
                }
              }
            },
            definition: {
              dynamicRegistration: true,
              linkSupport: true
            },
            references: {
              dynamicRegistration: true
            },
            documentHighlight: {
              dynamicRegistration: true
            },
            documentSymbol: {
              dynamicRegistration: true,
              hierarchicalDocumentSymbolSupport: true
            },
            codeAction: {
              dynamicRegistration: true,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    'quickfix',
                    'refactor',
                    'refactor.extract',
                    'refactor.inline',
                    'refactor.rewrite',
                    'source',
                    'source.organizeImports'
                  ]
                }
              }
            },
            formatting: {
              dynamicRegistration: true
            },
            rangeFormatting: {
              dynamicRegistration: true
            },
            rename: {
              dynamicRegistration: true,
              prepareSupport: true
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: {
                valueSet: [1, 2]
              },
              codeDescriptionSupport: true
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
            symbol: {
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
          configuration: {
            svelte: {
              plugin: {
                svelte: {
                  compilerWarnings: {},
                  format: { enable: true }
                },
                css: { enable: true },
                html: { enable: true }
              }
            }
          }
        }
      });

      console.log('[Svelte LSP] Server initialized:', initResult);

      // Send initialized notification
      await svelteServerTransport.sendNotification('initialized', {});

      svelteServerInitialized = true;
      initializedRootPath = projectStore.rootPath ?? null;

      // Register Monaco providers
      registerSvelteMonacoProviders();
    } catch (error) {
      console.error('[Svelte LSP] Failed to initialize server:', error);
      svelteServerTransport = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Notify the server that a document was opened
 */
export async function notifySvelteDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isSvelteFile(filepath)) return;
  if (!projectStore.rootPath) return;

  // Initialize server if needed
  await initializeServer();

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(filepath);
  if (existing && existing.content === content) return;

  if (!svelteServerTransport || !svelteServerInitialized) return;

  const uri = pathToUri(filepath);
  const languageId = getLanguageId(filepath);

  // Track document
  openDocuments.set(filepath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await svelteServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await svelteServerTransport.sendNotification('textDocument/didOpen', {
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
export async function notifySvelteDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isSvelteFile(filepath)) return;
  if (!svelteServerTransport || !svelteServerInitialized) return;

  const doc = openDocuments.get(filepath);
  if (!doc) {
    // Document wasn't opened, open it now
    await notifySvelteDocumentOpened(filepath, content);
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

    if (!svelteServerTransport || !svelteServerInitialized) return;

    // Send didChange notification with full content
    await svelteServerTransport.sendNotification('textDocument/didChange', {
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
export async function notifySvelteDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isSvelteFile(filepath)) return;
  if (!svelteServerTransport || !svelteServerInitialized) return;

  const uri = pathToUri(filepath);

  await svelteServerTransport.sendNotification('textDocument/didSave', {
    textDocument: { uri },
    text: content
  });
}

/**
 * Notify the server that a document was closed
 */
export async function notifySvelteDocumentClosed(filepath: string): Promise<void> {
  if (!isSvelteFile(filepath)) return;
  if (!svelteServerTransport || !svelteServerInitialized) return;

  openDocuments.delete(filepath);

  const uri = pathToUri(filepath);

  await svelteServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri }
  });

  // Clear Svelte problems for this file
  problemsStore.clearProblemsForFile(filepath, 'svelte');
}

/**
 * Request completions at a position
 */
export async function getSvelteCompletions(
  filepath: string,
  line: number,
  character: number
): Promise<CompletionItem[] | null> {
  if (!isSvelteFile(filepath)) return null;
  if (!svelteServerTransport || !svelteServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await svelteServerTransport.sendRequest<CompletionList | CompletionItem[] | null>(
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
    console.error('[Svelte LSP] Completion error:', error);
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
export async function getSvelteHover(
  filepath: string,
  line: number,
  character: number
): Promise<HoverResult | null> {
  if (!isSvelteFile(filepath)) return null;
  if (!svelteServerTransport || !svelteServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await svelteServerTransport.sendRequest<HoverResult | null>(
      'textDocument/hover',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    return result;
  } catch (error) {
    console.error('[Svelte LSP] Hover error:', error);
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
 * Request definition location
 */
export async function getSvelteDefinition(
  filepath: string,
  line: number,
  character: number
): Promise<Location[] | null> {
  if (!isSvelteFile(filepath)) return null;
  if (!svelteServerTransport || !svelteServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await svelteServerTransport.sendRequest<Location | Location[] | null>(
      'textDocument/definition',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    if (!result) return null;
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    console.error('[Svelte LSP] Definition error:', error);
    return null;
  }
}

export interface Location {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Request references
 */
export async function getSvelteReferences(
  filepath: string,
  line: number,
  character: number,
  includeDeclaration = true
): Promise<Location[] | null> {
  if (!isSvelteFile(filepath)) return null;
  if (!svelteServerTransport || !svelteServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await svelteServerTransport.sendRequest<Location[] | null>(
      'textDocument/references',
      {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration }
      }
    );

    return result;
  } catch (error) {
    console.error('[Svelte LSP] References error:', error);
    return null;
  }
}

/**
 * Request signature help
 */
export async function getSvelteSignatureHelp(
  filepath: string,
  line: number,
  character: number
): Promise<SignatureHelp | null> {
  if (!isSvelteFile(filepath)) return null;
  if (!svelteServerTransport || !svelteServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await svelteServerTransport.sendRequest<SignatureHelp | null>(
      'textDocument/signatureHelp',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    return result;
  } catch (error) {
    console.error('[Svelte LSP] Signature help error:', error);
    return null;
  }
}

export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

interface SignatureInformation {
  label: string;
  documentation?: string | { kind: string; value: string };
  parameters?: ParameterInformation[];
}

interface ParameterInformation {
  label: string | [number, number];
  documentation?: string | { kind: string; value: string };
}

/**
 * Request document formatting
 */
export async function formatSvelteDocument(filepath: string): Promise<TextEdit[] | null> {
  if (!isSvelteFile(filepath)) return null;
  if (!svelteServerTransport || !svelteServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await svelteServerTransport.sendRequest<TextEdit[] | null>(
      'textDocument/formatting',
      {
        textDocument: { uri },
        options: {
          tabSize: 2,
          insertSpaces: true,
          trimTrailingWhitespace: true,
          insertFinalNewline: true
        }
      }
    );

    return result;
  } catch (error) {
    console.error('[Svelte LSP] Format error:', error);
    return null;
  }
}

/**
 * Request code actions (quick fixes)
 */
export async function getSvelteCodeActions(
  filepath: string,
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  diagnostics: Diagnostic[] = []
): Promise<CodeAction[] | null> {
  if (!isSvelteFile(filepath)) return null;
  if (!svelteServerTransport || !svelteServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await svelteServerTransport.sendRequest<CodeAction[] | null>(
      'textDocument/codeAction',
      {
        textDocument: { uri },
        range: {
          start: { line: startLine, character: startCharacter },
          end: { line: endLine, character: endCharacter }
        },
        context: {
          diagnostics,
          only: ['quickfix', 'refactor', 'source.organizeImports']
        }
      }
    );

    return result;
  } catch (error) {
    console.error('[Svelte LSP] Code action error:', error);
    return null;
  }
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
  command?: Command;
}

export interface WorkspaceEdit {
  changes?: { [uri: string]: TextEdit[] };
  documentChanges?: DocumentChange[];
}

interface DocumentChange {
  textDocument: { uri: string; version?: number };
  edits: TextEdit[];
}

interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

/**
 * Check if the Svelte LSP is initialized
 */
export function isSvelteLspInitialized(): boolean {
  return svelteServerInitialized;
}

/**
 * Check if the Svelte LSP is connected
 */
export function isSvelteLspConnected(): boolean {
  return svelteServerTransport?.connected ?? false;
}

/**
 * Stop the Svelte LSP server
 */
export async function stopSvelteLsp(): Promise<void> {
  // Dispose Monaco providers first
  disposeSvelteMonacoProviders();

  if (svelteServerTransport) {
    try {
      // Send shutdown request
      await svelteServerTransport.sendRequest('shutdown', null);
      // Send exit notification
      await svelteServerTransport.sendNotification('exit', null);
    } catch {
      // Ignore errors during shutdown
    }

    await svelteServerTransport.stop();
    svelteServerTransport = null;
  }

  svelteServerInitialized = false;
  initializationPromise = null;
  initializedRootPath = null;
  openDocuments.clear();

  // Clear all diagnostic timers
  for (const timer of diagnosticDebounceTimers.values()) {
    clearTimeout(timer);
  }
  diagnosticDebounceTimers.clear();
}

/**
 * Restart the Svelte LSP server
 */
export async function restartSvelteLsp(): Promise<void> {
  await stopSvelteLsp();

  // Re-initialize if there's a project open
  if (projectStore.rootPath) {
    await initializeServer();
  }
}

/**
 * Ensure the Svelte LSP is started for the current workspace.
 * Useful for features like Symbol Search that should be able to bootstrap LSP.
 */
export async function ensureSvelteLspStarted(): Promise<void> {
  if (!projectStore.rootPath) return;
  await initializeServer();
}

/**
 * Perform background analysis of all Svelte files in the project
 */
export async function startProjectWideAnalysis(): Promise<void> {
  if (!projectStore.rootPath) return;

  // Use dynamic import for fileIndex to avoid circular deps if any
  const { getAllFiles } = await import('$lib/services/file-index');
  const { readFileQuiet } = await import('$lib/services/file-system');

  const allFiles = getAllFiles();
  const svelteFiles = allFiles.filter(f => isSvelteFile(f.path));

  if (svelteFiles.length === 0) return;

  console.log(`[Svelte LSP] Starting project-wide analysis of ${svelteFiles.length} files...`);

  // Process in small batches to avoid blocking
  for (const file of svelteFiles) {
    // Only open if not already open (prevent double-counting)
    if (openDocuments.has(file.path)) continue;

    const content = await readFileQuiet(file.path);
    if (content) {
      // This will automatically initialize server if needed
      await notifySvelteDocumentOpened(file.path, content);

      // If we've opened many files, yield to event loop
      if (svelteFiles.indexOf(file) % 5 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }
}

