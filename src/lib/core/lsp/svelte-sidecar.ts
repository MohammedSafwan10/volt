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

import {
  getLspRegistry,
  createLspRecoveryController,
  type LspTransport,
  type JsonRpcMessage,
} from './sidecar';
import { projectStore } from '$shared/stores/project.svelte';
import { readFileQuiet } from '$core/services/file-system';
import { getAllFiles } from '$core/services/file-index';
import { registerSvelteMonacoProviders, disposeSvelteMonacoProviders } from './svelte-monaco-providers';
import {
  getSvelteLanguageId,
  sveltePathToUri,
} from './svelte-sidecar-utils';

// Server instance tracking
let svelteServerTransport: LspTransport | null = null;
let svelteServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializedRootPath: string | null = null;
const svelteRecovery = createLspRecoveryController({
  source: 'svelte',
  restart: async () => {
    await recoverSvelteLspAfterExit();
  },
});

// Debounce timers
const diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_DEBOUNCE_MS = 150;
const PROJECT_ANALYSIS_BATCH_SIZE = 10;
const PROJECT_ANALYSIS_BATCH_DELAY_MS = 20;
let projectAnalysisRunId = 0;

function normalizeSvelteFilePath(filepath: string): string {
  return filepath.replace(/\\/g, '/');
}

function prioritizeProjectFiles<T extends { path: string }>(files: T[], active: Set<string>): T[] {
  return [...files].sort((a, b) => {
    const aActive = active.has(normalizeSvelteFilePath(a.path)) ? 0 : 1;
    const bActive = active.has(normalizeSvelteFilePath(b.path)) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return normalizeSvelteFilePath(a.path).localeCompare(normalizeSvelteFilePath(b.path));
  });
}

async function getTrackedDocumentPaths(): Promise<Set<string>> {
  if (!svelteServerTransport || !svelteServerInitialized) {
    return new Set();
  }

  const tracked = await svelteServerTransport.listTrackedDocuments();
  return new Set(tracked.map((document) => normalizeSvelteFilePath(document.filePath)));
}

/**
 * Check if a file is a Svelte file
 */
export function isSvelteFile(filepath: string): boolean {
  return filepath.toLowerCase().endsWith('.svelte');
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
    if (message.method === 'window/logMessage') {
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
        cwd: projectStore.rootPath ?? undefined,
        restartPolicy: {
          enabled: true,
          baseDelayMs: 750,
          maxDelayMs: 10_000,
          maxAttempts: 4,
          windowMs: 120_000,
        },
      });
      svelteServerTransport.configureHealth({ autoRestart: true });

      // Set up message handler
      svelteServerTransport.onMessage(handleLspMessage);

      // Set up error handler
      svelteServerTransport.onError((error) => {
        console.error('[Svelte LSP] Server error:', error);
      });

      // Set up exit handler
      svelteServerTransport.onExit(() => {
        console.log('[Svelte LSP] Server exited');
        svelteRecovery.schedule('transport exit');
        svelteServerTransport = null;
        svelteServerInitialized = false;
        initializationPromise = null;
        initializedRootPath = null;
      });

      // Send initialize request
      const rootUri = sveltePathToUri(projectStore.rootPath!);

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
      svelteRecovery.reset();

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

  if (!svelteServerTransport || !svelteServerInitialized) return;

  const languageId = getSvelteLanguageId(filepath);
  await svelteServerTransport.syncDocument(filepath, languageId, content);
}

/**
 * Notify the server that a document was changed
 */
export async function notifySvelteDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isSvelteFile(filepath)) return;
  if (!svelteServerTransport || !svelteServerInitialized) return;

  // Debounce the change notification
  const existingTimer = diagnosticDebounceTimers.get(filepath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  diagnosticDebounceTimers.set(filepath, setTimeout(async () => {
    diagnosticDebounceTimers.delete(filepath);

    if (!svelteServerTransport || !svelteServerInitialized) return;

    await svelteServerTransport.syncDocument(filepath, getSvelteLanguageId(filepath), content);
  }, DIAGNOSTIC_DEBOUNCE_MS));
}

/**
 * Notify the server that a document was saved
 */
export async function notifySvelteDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isSvelteFile(filepath)) return;
  if (!svelteServerTransport || !svelteServerInitialized) return;

  await svelteServerTransport.syncDocument(filepath, getSvelteLanguageId(filepath), content);
  const uri = sveltePathToUri(filepath);

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

  await svelteServerTransport.closeDocument(filepath);
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

  const uri = sveltePathToUri(filepath);

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

  const uri = sveltePathToUri(filepath);

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

  const uri = sveltePathToUri(filepath);

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

  const uri = sveltePathToUri(filepath);

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

  const uri = sveltePathToUri(filepath);

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

  const uri = sveltePathToUri(filepath);

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

  const uri = sveltePathToUri(filepath);

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
  svelteRecovery.reset();

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

async function recoverSvelteLspAfterExit(): Promise<void> {
  if (!projectStore.rootPath || svelteServerTransport || initializationPromise) {
    return;
  }
  await initializeServer();
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

  const runId = ++projectAnalysisRunId;
  const trackedDocumentPaths = await getTrackedDocumentPaths();

  const allFiles = getAllFiles();
  const svelteFiles = prioritizeProjectFiles(
    allFiles.filter((f) => isSvelteFile(f.path)),
    trackedDocumentPaths,
  );

  if (svelteFiles.length === 0) return;

  console.log(`[Svelte LSP] Starting project-wide analysis of ${svelteFiles.length} files...`);

  let processedSinceYield = 0;

  for (const file of svelteFiles) {
    if (runId !== projectAnalysisRunId) {
      return;
    }

    const normalizedPath = normalizeSvelteFilePath(file.path);

    // Only open if not already open (prevent double-counting)
    if (trackedDocumentPaths.has(normalizedPath)) continue;

    const content = await readFileQuiet(file.path);
    if (runId !== projectAnalysisRunId) {
      return;
    }

    if (content) {
      // This will automatically initialize server if needed
      await notifySvelteDocumentOpened(normalizedPath, content);
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


