/**
 * TypeScript LSP Sidecar Service
 * 
 * Provides full-project TypeScript/JavaScript intelligence using the real
 * typescript-language-server (backed by tsserver).
 * 
 * Features:
 * - Project-wide diagnostics (respects tsconfig.json)
 * - Go-to-definition
 * - Hover information
 * - Completions
 * - Find references
 * 
 * Strategy:
 * - Start server when opening a TS/JS file in a project
 * - Workspace root = projectStore.rootPath
 * - Must respect workspace tsconfig.json (paths/baseUrl) for Next.js
 */

import { getLspRegistry, type LspTransport, type JsonRpcMessage } from './sidecar';
import { problemsStore, type Problem, type ProblemSeverity } from '$lib/stores/problems.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { registerTsMonacoProviders, disposeTsMonacoProviders } from './typescript-monaco-providers';

// Server instance tracking
let tsServerTransport: LspTransport | null = null;
let tsServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializedRootPath: string | null = null;

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

// Debounce timers
const diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_DEBOUNCE_MS = 75;

// Pending open operations (to prevent race conditions)
const openingDocuments = new Map<string, Promise<void>>();

// Note: messageId is managed by the transport layer

/**
 * Check if a file is a TypeScript/JavaScript file
 */
export function isTsJsFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext);
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
    default:
      return 'typescript';
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

  // Decode URI components (fixes encoded drive letters like %3A)
  try {
    path = decodeURIComponent(path);
  } catch (e) {
    console.warn('[TS LSP] Failed to decode URI component:', path);
  }

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
    if (message.method === 'workspace/configuration' || message.method === 'client/registerCapability') {
      const items = (message.params as any)?.items || [];
      const result = items.map((item: any) => {
        // Return default configurations for common TS/JS settings
        if (item.section === 'typescript' || item.section === 'javascript') {
          return { format: { enable: true }, suggest: { enabled: true } };
        }
        return {};
      });
      tsServerTransport?.sendResponse(id, result || [{}]);
    } else {
      tsServerTransport?.sendResponse(id, null);
    }
    return;
  }

  // Handle notifications
  if ('method' in message && !('id' in message)) {
    if (message.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(message.params as PublishDiagnosticsParams);
    } else if (message.method === 'window/logMessage') {
      const params = message.params as { type: number; message: string };
      console.log(`[TS LSP] ${params.message}`);
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
    id: `${filePath}:${diag.range.start.line}:${diag.range.start.character}:${index}`,
    file: filePath,
    fileName,
    line: diag.range.start.line + 1, // LSP is 0-based, we use 1-based
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    severity: mapSeverity(diag.severity ?? 1),
    source: diag.source || 'typescript',
    code: diag.code?.toString()
  }));

  problemsStore.setProblemsForFile(filePath, problems, 'typescript');
}

/**
 * Initialize the TypeScript language server
 */
async function initializeServer(): Promise<void> {
  if (!projectStore.rootPath) return;

  // If the workspace root changed, the server will reject new documents.
  // Restart to re-bind to the new root.
  if (tsServerInitialized && initializedRootPath && projectStore.rootPath !== initializedRootPath) {
    await stopTsLsp();
  }

  if (tsServerInitialized) return;

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      const registry = getLspRegistry();

      // Start the TypeScript server
      tsServerTransport = await registry.startServer('typescript', {
        serverId: 'typescript-main',
        cwd: projectStore.rootPath ?? undefined
      });

      // Set up message handler
      tsServerTransport.onMessage(handleLspMessage);

      // Set up error handler
      tsServerTransport.onError((error) => {
        console.error('[TS LSP] Server error:', error);
      });

      // Set up exit handler
      tsServerTransport.onExit(() => {
        console.log('[TS LSP] Server exited');
        tsServerTransport = null;
        tsServerInitialized = false;
        initializationPromise = null;
        initializedRootPath = null;
        openDocuments.clear();
      });

      // Send initialize request
      const rootUri = pathToUri(projectStore.rootPath!);

      const initResult = await tsServerTransport.sendRequest('initialize', {
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
          preferences: {
            includeInlayParameterNameHints: 'all',
            includeInlayParameterNameHintsWhenArgumentMatchesName: false,
            includeInlayFunctionParameterTypeHints: true,
            includeInlayVariableTypeHints: true,
            includeInlayPropertyDeclarationTypeHints: true,
            includeInlayFunctionLikeReturnTypeHints: true,
            includeInlayEnumMemberValueHints: true
          }
        }
      });

      console.log('[TS LSP] Server initialized:', initResult);

      // Send initialized notification
      await tsServerTransport.sendNotification('initialized', {});

      tsServerInitialized = true;
      initializedRootPath = projectStore.rootPath ?? null;

      // Register Monaco providers to use the sidecar for completions/hover/definition
      registerTsMonacoProviders();
    } catch (error) {
      console.error('[TS LSP] Failed to initialize server:', error);
      tsServerTransport = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}


// Helper to normalize paths for consistency (map keys)
function normalizePath(filepath: string): string {
  let normalized = filepath.replace(/\\/g, '/');
  if (normalized.match(/^[a-zA-Z]:/)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

/**
 * Notify the server that a document was opened
 */
export async function notifyDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isTsJsFile(filepath)) return;
  if (!projectStore.rootPath) return;

  const normalizedPath = normalizePath(filepath);

  // Check if update/open is already in progress to prevent races
  if (openingDocuments.has(normalizedPath)) {
    return openingDocuments.get(normalizedPath);
  }

  const promise = (async () => {
    // Initialize server if needed
    await initializeServer();

    if (!tsServerTransport || !tsServerInitialized) return;

    // Re-check if already open (might have been opened while we waited for init)
    const existing = openDocuments.get(normalizedPath);
    const uri = pathToUri(normalizedPath);

    if (existing) {
      if (existing.content === content) return;

      // If it's already open but content changed, send didChange instead
      openDocuments.set(normalizedPath, { version: existing.version + 1, content });

      await tsServerTransport.sendNotification('textDocument/didChange', {
        textDocument: {
          uri,
          version: existing.version + 1
        },
        contentChanges: [{ text: content }]
      });
      return;
    }

    const languageId = getLanguageId(normalizedPath);

    // Track document
    openDocuments.set(normalizedPath, { version: 1, content });

    // Send didOpen notification
    await tsServerTransport.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content
      }
    });
  })();

  openingDocuments.set(normalizedPath, promise);
  try {
    await promise;
  } finally {
    openingDocuments.delete(normalizedPath);
  }
}

/**
 * Notify the server that a document was changed
 */
export async function notifyDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isTsJsFile(filepath)) return;
  if (!tsServerTransport || !tsServerInitialized) return;

  const normalizedPath = normalizePath(filepath);
  const doc = openDocuments.get(normalizedPath);
  if (!doc) {
    // Document wasn't opened, open it now
    await notifyDocumentOpened(normalizedPath, content);
    return;
  }

  // Update version
  doc.version++;
  doc.content = content;

  const uri = pathToUri(normalizedPath);

  // Debounce the change notification
  const existingTimer = diagnosticDebounceTimers.get(normalizedPath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  diagnosticDebounceTimers.set(normalizedPath, setTimeout(async () => {
    diagnosticDebounceTimers.delete(normalizedPath);

    if (!tsServerTransport || !tsServerInitialized) return;

    // Send didChange notification with full content
    await tsServerTransport.sendNotification('textDocument/didChange', {
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
export async function notifyDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isTsJsFile(filepath)) return;
  if (!tsServerTransport || !tsServerInitialized) return;

  const normalizedPath = normalizePath(filepath);
  const uri = pathToUri(normalizedPath);

  await tsServerTransport.sendNotification('textDocument/didSave', {
    textDocument: { uri },
    text: content
  });
}

/**
 * Notify the server that a document was closed
 */
export async function notifyDocumentClosed(filepath: string): Promise<void> {
  if (!isTsJsFile(filepath)) return;
  if (!tsServerTransport || !tsServerInitialized) return;

  const normalizedPath = normalizePath(filepath);
  openDocuments.delete(normalizedPath);

  const uri = pathToUri(normalizedPath);

  await tsServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri }
  });

  // Clear TypeScript problems for this file
  problemsStore.clearProblemsForFile(normalizedPath, 'typescript');
}

/**
 * Perform background analysis of all TS/JS files in the project
 */
export async function startProjectWideAnalysis(): Promise<void> {
  if (!projectStore.rootPath) return;

  // Use dynamic import for fileIndex to avoid circular deps if any
  const { getAllFiles } = await import('$lib/services/file-index');
  const { readFileQuiet } = await import('$lib/services/file-system');

  const allFiles = getAllFiles();
  const tsJsFiles = allFiles.filter(f => isTsJsFile(f.path));

  if (tsJsFiles.length === 0) {
    console.log('[TS LSP] No JS/TS files found for background analysis.');
    return;
  }

  console.log(`[TS LSP] Starting project-wide analysis of ${tsJsFiles.length} files...`);

  // Process singly with delay to avoid blocking LSP server
  for (const file of tsJsFiles) {
    // console.log(`[TS LSP] Background analyzing: ${file.path}`);
    const normalizedPath = normalizePath(file.path);

    // Only open if not already open (prevent double-counting)
    if (openDocuments.has(normalizedPath)) continue;

    const content = await readFileQuiet(file.path);
    if (content) {
      // This will automatically initialize server if needed
      await notifyDocumentOpened(normalizedPath, content);

      // Intentional delay to let the server breathe and process other requests (Code Actions, etc.)
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

/**
 * Request completions at a position
 */
export async function getCompletions(
  filepath: string,
  line: number,
  character: number
): Promise<CompletionItem[] | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<CompletionList | CompletionItem[] | null>(
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
    console.error('[TS LSP] Completion error:', error);
    return null;
  }
}

interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
}

interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

/**
 * Request hover information at a position
 */
export async function getHover(
  filepath: string,
  line: number,
  character: number
): Promise<HoverResult | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<HoverResult | null>(
      'textDocument/hover',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    return result;
  } catch (error) {
    console.error('[TS LSP] Hover error:', error);
    return null;
  }
}

interface HoverResult {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Request definition location
 */
export async function getDefinition(
  filepath: string,
  line: number,
  character: number
): Promise<Location[] | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<Location | Location[] | null>(
      'textDocument/definition',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    if (!result) return null;
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    console.error('[TS LSP] Definition error:', error);
    return null;
  }
}

interface Location {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Request references
 */
export async function getReferences(
  filepath: string,
  line: number,
  character: number,
  includeDeclaration = true
): Promise<Location[] | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<Location[] | null>(
      'textDocument/references',
      {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration }
      }
    );

    return result;
  } catch (error) {
    console.error('[TS LSP] References error:', error);
    return null;
  }
}

/**
 * Request signature help
 */
export async function getSignatureHelp(
  filepath: string,
  line: number,
  character: number
): Promise<SignatureHelp | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<SignatureHelp | null>(
      'textDocument/signatureHelp',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    return result;
  } catch (error) {
    console.error('[TS LSP] Signature help error:', error);
    return null;
  }
}

interface SignatureHelp {
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
export async function formatDocument(filepath: string): Promise<TextEdit[] | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<TextEdit[] | null>(
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
    console.error('[TS LSP] Format error:', error);
    return null;
  }
}

/**
 * Request code actions (quick fixes)
 */
export async function getCodeActions(
  filepath: string,
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  diagnostics: Diagnostic[] = []
): Promise<CodeAction[] | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<CodeAction[] | null>(
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
    console.error('[TS LSP] Code action error:', error);
    return null;
  }
}

interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
  command?: Command;
}

interface WorkspaceEdit {
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
 * Request rename
 */
export async function prepareRename(
  filepath: string,
  line: number,
  character: number
): Promise<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; placeholder: string } | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; placeholder: string } | null>(
      'textDocument/prepareRename',
      {
        textDocument: { uri },
        position: { line, character }
      }
    );

    return result;
  } catch (error) {
    console.error('[TS LSP] Prepare rename error:', error);
    return null;
  }
}

/**
 * Execute rename
 */
export async function executeRename(
  filepath: string,
  line: number,
  character: number,
  newName: string
): Promise<WorkspaceEdit | null> {
  if (!isTsJsFile(filepath)) return null;
  if (!tsServerTransport || !tsServerInitialized) {
    throw new Error('TypeScript server is not initialized');
  }

  const uri = pathToUri(filepath);

  try {
    const result = await tsServerTransport.sendRequest<WorkspaceEdit | null>(
      'textDocument/rename',
      {
        textDocument: { uri },
        position: { line, character },
        newName
      }
    );

    return result;
  } catch (error) {
    console.error('[TS LSP] Rename error:', error);
    throw error;
  }
}

/**
 * Request workspace symbols
 */
export async function getWorkspaceSymbols(query: string): Promise<any[] | null> {
  if (!tsServerTransport || !tsServerInitialized) return null;

  try {
    const result = await tsServerTransport.sendRequest<any[] | null>(
      'workspace/symbol',
      { query }
    );

    return result;
  } catch (error) {
    console.error('[TS LSP] Workspace symbol error:', error);
    return null;
  }
}

/**
 * Check if the TypeScript LSP is initialized
 */
export function isTsLspInitialized(): boolean {
  return tsServerInitialized;
}

/**
 * Check if the TypeScript LSP is connected
 */
export function isTsLspConnected(): boolean {
  return tsServerTransport?.connected ?? false;
}

/**
 * Ensure the TypeScript LSP is started for the current workspace.
 * Useful for features like Symbol Search that should be able to bootstrap LSP.
 */
export async function ensureTsLspStarted(): Promise<void> {
  if (!projectStore.rootPath) return;
  await initializeServer();
}

/**
 * Stop the TypeScript LSP server
 */
export async function stopTsLsp(): Promise<void> {
  // Dispose Monaco providers first
  disposeTsMonacoProviders();

  if (tsServerTransport) {
    try {
      // Send shutdown request
      await tsServerTransport.sendRequest('shutdown', null);
      // Send exit notification
      await tsServerTransport.sendNotification('exit', null);
    } catch {
      // Ignore errors during shutdown
    }

    await tsServerTransport.stop();
    tsServerTransport = null;
  }

  tsServerInitialized = false;
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
 * Restart the TypeScript LSP server
 */
export async function restartTsLsp(): Promise<void> {
  await stopTsLsp();

  // Re-initialize if there's a project open
  if (projectStore.rootPath) {
    await initializeServer();
  }
}

/**
 * Perform background analysis of all TS/JS files in the project
 */
// Export types for external use
export type {
  CompletionItem,
  CompletionList,
  HoverResult,
  Location,
  SignatureHelp,
  TextEdit,
  CodeAction,
  WorkspaceEdit
};
