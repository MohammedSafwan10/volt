/**
 * ESLint LSP Sidecar Service
 * 
 * Provides real ESLint diagnostics for JS/TS/React projects using the
 * vscode-eslint-language-server (from vscode-langservers-extracted).
 * 
 * Features:
 * - Respects .eslintrc* / eslint.config.* configuration files
 * - Common React rules (hooks/exhaustive-deps, unused-vars, etc.)
 * - Debounced diagnostics to avoid UI freezes
 * 
 * Strategy:
 * - Start server when opening a JS/TS file in a project
 * - Workspace root = projectStore.rootPath
 * - Must respect workspace ESLint configuration
 */

import {
  getLspRegistry,
  createLspRecoveryController,
  type LspTransport,
  type JsonRpcMessage,
} from './sidecar';
import { projectStore } from '$shared/stores/project.svelte';
import { invoke } from '@tauri-apps/api/core';
import { readFileQuiet } from '$core/services/file-system';
import { getAllFiles } from '$core/services/file-index';

/**
 * Get the detected package manager from projectStore
 * Detection happens when a project is opened (checks for lock files)
 */
function getPackageManager(): 'npm' | 'yarn' | 'pnpm' {
  return projectStore.packageManager;
}

function normalizeFilePath(filepath: string): string {
  return filepath.replace(/\\/g, '/');
}

function prioritizeProjectFiles<T extends { path: string }>(
  files: T[],
  active: Set<string>,
): T[] {
  return [...files].sort((a, b) => {
    const aActive = active.has(normalizeFilePath(a.path)) ? 0 : 1;
    const bActive = active.has(normalizeFilePath(b.path)) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return normalizeFilePath(a.path).localeCompare(normalizeFilePath(b.path));
  });
}

// Server instance tracking
let eslintServerTransport: LspTransport | null = null;
let eslintServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
const eslintRecovery = createLspRecoveryController({
  source: 'eslint',
  restart: async () => {
    await recoverEslintLspAfterExit();
  },
});

interface LspStartErrorLike {
  type?: string;
}

function isServerAlreadyRunningError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as LspStartErrorLike).type === 'ServerAlreadyRunning'
  );
}

let transportHandlersAttached = false;

function attachTransportHandlers(transport: LspTransport): void {
  if (transportHandlersAttached) return;
  transportHandlersAttached = true;

  transport.onMessage(handleLspMessage);

  transport.onError((error) => {
    console.error('[ESLint LSP] Server error:', error);
  });

  transport.onExit(() => {
    console.log('[ESLint LSP] Server exited');
    eslintServerTransport = null;
    eslintServerInitialized = false;
    initializationPromise = null;
    transportHandlersAttached = false;
    eslintRecovery.schedule('transport exit');
  });
}

// Debounce timers
const diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_DEBOUNCE_MS = 150; // Faster debounce for full diagnostics mode
const PROJECT_ANALYSIS_BATCH_SIZE = 10;
const PROJECT_ANALYSIS_BATCH_DELAY_MS = 20;
let projectAnalysisRunId = 0;

async function getTrackedDocumentPaths(): Promise<Set<string>> {
  if (!eslintServerTransport || !eslintServerInitialized) {
    return new Set();
  }

  const tracked = await eslintServerTransport.listTrackedDocuments();
  return new Set(tracked.map((document) => normalizeFilePath(document.filePath)));
}

/**
 * File extensions that ESLint can lint
 */
const ESLINT_FILE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'
];

/**
 * Check if a file can be linted by ESLint
 */
export function isEslintFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ESLINT_FILE_EXTENSIONS.includes(ext);
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
      return 'javascript';
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
 * Handle incoming LSP messages
 */
function handleLspMessage(message: JsonRpcMessage): void {
  // Handle server requests that require a response
  if ('id' in message && 'method' in message && message.id !== null) {
    const id = message.id;
    if (message.method === 'workspace/configuration') {
      const items = (message.params as any)?.items || [];
      const result = items.map(() => ({}));
      eslintServerTransport?.sendResponse(id, result);
    } else {
      eslintServerTransport?.sendResponse(id, null);
    }
    return;
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
  codeDescription?: {
    href: string;
  };
}

/**
 * Initialize the ESLint language server
 */
async function initializeServer(): Promise<void> {
  if (eslintServerInitialized || !projectStore.rootPath) {
    return;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      const registry = getLspRegistry();

      // Start the ESLint server
      try {
        eslintServerTransport = await registry.startServer('eslint', {
          serverId: 'eslint-main',
          cwd: projectStore.rootPath ?? undefined,
          restartPolicy: {
            enabled: true,
            baseDelayMs: 750,
            maxDelayMs: 10_000,
            maxAttempts: 4,
            windowMs: 120_000,
          },
        });
        eslintServerTransport.configureHealth({ autoRestart: false });
        attachTransportHandlers(eslintServerTransport);
      } catch (error) {
        if (isServerAlreadyRunningError(error)) {
          console.warn('[ESLint LSP] Recovering from stale server state (ServerAlreadyRunning)');
          await invoke('lsp_stop_server', { serverId: 'eslint-main' });
          eslintServerTransport = await registry.startServer('eslint', {
            serverId: 'eslint-main',
            cwd: projectStore.rootPath ?? undefined,
            restartPolicy: {
              enabled: true,
              baseDelayMs: 750,
              maxDelayMs: 10_000,
              maxAttempts: 4,
              windowMs: 120_000,
            },
          });
          eslintServerTransport.configureHealth({ autoRestart: false });
          attachTransportHandlers(eslintServerTransport);
        } else {
          throw error;
        }
      }


      // Send initialize request
      const rootUri = pathToUri(projectStore.rootPath!);

      const initResult = await eslintServerTransport.sendRequest('initialize', {
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
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: {
                valueSet: [1, 2] // Unnecessary, Deprecated
              },
              codeDescriptionSupport: true
            },
            codeAction: {
              dynamicRegistration: true,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    'quickfix',
                    'source',
                    'source.fixAll',
                    'source.fixAll.eslint'
                  ]
                }
              }
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
          // ESLint-specific settings
          settings: {
            validate: 'on',
            packageManager: getPackageManager(),
            useESLintClass: false,
            experimental: {
              useFlatConfig: true // Support for eslint.config.* (flat config)
            },
            codeAction: {
              disableRuleComment: {
                enable: true,
                location: 'separateLine'
              },
              showDocumentation: {
                enable: true
              }
            },
            codeActionOnSave: {
              enable: false,
              mode: 'all'
            },
            format: false,
            quiet: false,
            onIgnoredFiles: 'off',
            options: {},
            run: 'onType',
            nodePath: null,
            workingDirectory: { mode: 'auto' }
          }
        }
      });

      // Send initialized notification
      await eslintServerTransport.sendNotification('initialized', {});

      // Send workspace configuration
      await eslintServerTransport.sendNotification('workspace/didChangeConfiguration', {
        settings: {
          validate: 'on',
          packageManager: getPackageManager(),
          useESLintClass: false,
          experimental: {
            useFlatConfig: true
          },
          codeAction: {
            disableRuleComment: {
              enable: true,
              location: 'separateLine'
            },
            showDocumentation: {
              enable: true
            }
          },
          codeActionOnSave: {
            enable: false,
            mode: 'all'
          },
          format: false,
          quiet: false,
          onIgnoredFiles: 'off',
          options: {},
          run: 'onType',
          nodePath: null,
          workingDirectory: { mode: 'auto' }
        }
      });

      eslintServerInitialized = true;
      eslintRecovery.reset();
    } catch (error) {
      console.error('[ESLint LSP] Failed to initialize server:', error);
      eslintServerTransport = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Notify the server that a document was opened
 */
export async function notifyEslintDocumentOpened(filepath: string, content: string): Promise<void> {
  const normalizedPath = normalizeFilePath(filepath);
  if (!isEslintFile(normalizedPath)) return;
  if (!projectStore.rootPath) return;

  // Initialize server if needed
  await initializeServer();

  if (!eslintServerTransport || !eslintServerInitialized) return;

  const languageId = getLanguageId(normalizedPath);
  await eslintServerTransport.syncDocument(normalizedPath, languageId, content);
}

/**
 * Notify the server that a document was changed
 */
export async function notifyEslintDocumentChanged(filepath: string, content: string): Promise<void> {
  const normalizedPath = normalizeFilePath(filepath);
  if (!isEslintFile(normalizedPath)) return;
  if (!eslintServerTransport || !eslintServerInitialized) return;

  // Debounce the change notification
  const existingTimer = diagnosticDebounceTimers.get(normalizedPath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  diagnosticDebounceTimers.set(normalizedPath, setTimeout(async () => {
    diagnosticDebounceTimers.delete(normalizedPath);

    if (!eslintServerTransport || !eslintServerInitialized) return;

    await eslintServerTransport.syncDocument(normalizedPath, getLanguageId(normalizedPath), content);
  }, DIAGNOSTIC_DEBOUNCE_MS));
}

/**
 * Notify the server that a document was saved
 */
export async function notifyEslintDocumentSaved(filepath: string, content: string): Promise<void> {
  const normalizedPath = normalizeFilePath(filepath);
  if (!isEslintFile(normalizedPath)) return;
  if (!eslintServerTransport || !eslintServerInitialized) return;

  const uri = pathToUri(normalizedPath);
  await eslintServerTransport.syncDocument(normalizedPath, getLanguageId(normalizedPath), content);

  await eslintServerTransport.sendNotification('textDocument/didSave', {
    textDocument: { uri },
    text: content
  });
}

/**
 * Notify the server that a document was closed
 */
export async function notifyEslintDocumentClosed(filepath: string): Promise<void> {
  const normalizedPath = normalizeFilePath(filepath);
  if (!isEslintFile(normalizedPath)) return;
  if (!eslintServerTransport || !eslintServerInitialized) return;

  await eslintServerTransport.closeDocument(normalizedPath);
}

/**
 * Request code actions (quick fixes) from ESLint
 */
export async function getEslintCodeActions(
  filepath: string,
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  diagnostics: Diagnostic[] = []
): Promise<CodeAction[] | null> {
  const normalizedPath = normalizeFilePath(filepath);
  if (!isEslintFile(normalizedPath)) return null;
  if (!eslintServerTransport || !eslintServerInitialized) return null;

  const uri = pathToUri(normalizedPath);

  try {
    const result = await eslintServerTransport.sendRequest<CodeAction[] | null>(
      'textDocument/codeAction',
      {
        textDocument: { uri },
        range: {
          start: { line: startLine, character: startCharacter },
          end: { line: endLine, character: endCharacter }
        },
        context: {
          diagnostics,
          only: ['quickfix', 'source.fixAll.eslint']
        }
      }
    );

    return result;
  } catch (error) {
    console.error('[ESLint LSP] Code action error:', error);
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

export interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

/**
 * Execute "Fix All" for ESLint issues in a document
 */
export async function executeEslintFixAll(filepath: string): Promise<WorkspaceEdit | null> {
  const normalizedPath = normalizeFilePath(filepath);
  if (!isEslintFile(normalizedPath)) return null;
  if (!eslintServerTransport || !eslintServerInitialized) return null;

  const uri = pathToUri(normalizedPath);

  try {
    // Request source.fixAll.eslint code action
    const actions = await eslintServerTransport.sendRequest<CodeAction[] | null>(
      'textDocument/codeAction',
      {
        textDocument: { uri },
        range: {
          start: { line: 0, character: 0 },
          end: { line: Number.MAX_SAFE_INTEGER, character: 0 }
        },
        context: {
          diagnostics: [],
          only: ['source.fixAll.eslint']
        }
      }
    );

    if (actions && actions.length > 0) {
      const fixAllAction = actions.find(a => a.kind === 'source.fixAll.eslint');
      if (fixAllAction?.edit) {
        return fixAllAction.edit;
      }
    }

    return null;
  } catch (error) {
    console.error('[ESLint LSP] Fix all error:', error);
    return null;
  }
}

/**
 * Check if the ESLint LSP is initialized
 */
export function isEslintLspInitialized(): boolean {
  return eslintServerInitialized;
}

/**
 * Check if the ESLint LSP is connected
 */
export function isEslintLspConnected(): boolean {
  return eslintServerTransport?.connected ?? false;
}

/**
 * Stop the ESLint LSP server
 */
export async function stopEslintLsp(): Promise<void> {
  if (eslintServerTransport) {
    try {
      // Send shutdown request
      await eslintServerTransport.sendRequest('shutdown', null);
      // Send exit notification
      await eslintServerTransport.sendNotification('exit', null);
    } catch {
      // Ignore errors during shutdown
    }

    await eslintServerTransport.stop();
    eslintServerTransport = null;
  }

  eslintServerInitialized = false;
  initializationPromise = null;
  eslintRecovery.reset();

  // Clear all diagnostic timers
  for (const timer of diagnosticDebounceTimers.values()) {
    clearTimeout(timer);
  }
  diagnosticDebounceTimers.clear();
}

/**
 * Restart the ESLint LSP server
 */
export async function restartEslintLsp(): Promise<void> {
  await stopEslintLsp();

  // Re-initialize if there's a project open
  if (projectStore.rootPath) {
    await initializeServer();
  }
}

async function recoverEslintLspAfterExit(): Promise<void> {
  if (!projectStore.rootPath || eslintServerTransport || initializationPromise) {
    return;
  }
  await initializeServer();
}

/**
 * Push updated configuration to the running ESLint server
 * Call this when packageManager changes (e.g., after npm/yarn/pnpm install)
 * This avoids a full server restart while updating the configuration
 */
export async function pushEslintConfig(): Promise<void> {
  if (!eslintServerTransport || !eslintServerInitialized) {
    console.log('[ESLint LSP] Server not running, skipping config push');
    return;
  }

  const packageManager = getPackageManager();

  try {
    await eslintServerTransport.sendNotification('workspace/didChangeConfiguration', {
      settings: {
        validate: 'on',
        packageManager,
        useESLintClass: false,
        experimental: {
          useFlatConfig: true
        },
        codeAction: {
          disableRuleComment: {
            enable: true,
            location: 'separateLine'
          },
          showDocumentation: {
            enable: true
          }
        },
        codeActionOnSave: {
          enable: false,
          mode: 'all'
        },
        format: false,
        quiet: false,
        onIgnoredFiles: 'off',
        options: {},
        run: 'onType',
        nodePath: null,
        workingDirectory: { mode: 'auto' }
      }
    });
    console.log('[ESLint LSP] Config pushed successfully');

    // Trigger a re-lint for currently open documents so the updated config takes effect quickly.
    const trackedDocumentPaths = await getTrackedDocumentPaths();
    for (const filepath of trackedDocumentPaths) {
      const content = await readFileQuiet(filepath);
      if (content !== null) {
        void notifyEslintDocumentChanged(filepath, content);
      }
    }
  } catch (error) {
    console.error('[ESLint LSP] Failed to push config:', error);
  }
}

/**
 * Perform background analysis of all JS/TS files in the project
 * Opens files in the LSP to trigger diagnostics for the entire project
 */
export async function startProjectWideAnalysis(): Promise<void> {
  if (!projectStore.rootPath) return;

  const runId = ++projectAnalysisRunId;
  const trackedDocumentPaths = await getTrackedDocumentPaths();

  const allFiles = getAllFiles();
  const eslintFiles = prioritizeProjectFiles(
    allFiles.filter((f) => isEslintFile(f.path)),
    trackedDocumentPaths,
  );

  if (eslintFiles.length === 0) {
    console.log('[ESLint LSP] No JS/TS files found for background analysis.');
    return;
  }

  console.log(`[ESLint LSP] Starting project-wide analysis of ${eslintFiles.length} files...`);

  let processedSinceYield = 0;

  for (const file of eslintFiles) {
    if (runId !== projectAnalysisRunId) {
      return;
    }

    const normalizedPath = normalizeFilePath(file.path);

    // Skip if already open
    if (trackedDocumentPaths.has(normalizedPath)) continue;

    const content = await readFileQuiet(file.path);
    if (runId !== projectAnalysisRunId) {
      return;
    }

    if (content) {
      await notifyEslintDocumentOpened(normalizedPath, content);
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
