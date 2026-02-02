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

import { getLspRegistry, type LspTransport, type JsonRpcMessage } from './sidecar';
import { problemsStore, type Problem, type ProblemSeverity } from '$lib/stores/problems.svelte';
import { projectStore } from '$lib/stores/project.svelte';

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

// Server instance tracking
let eslintServerTransport: LspTransport | null = null;
let eslintServerInitialized = false;
let initializationPromise: Promise<void> | null = null;

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

// Debounce timers
const diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_DEBOUNCE_MS = 150; // Faster debounce for full diagnostics mode

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
    default: return 'warning'; // ESLint defaults to warning
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
      eslintServerTransport?.sendResponse(id, result);
    } else {
      eslintServerTransport?.sendResponse(id, null);
    }
    return;
  }

  // Handle notifications
  if ('method' in message && !('id' in message)) {
    if (message.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(message.params as PublishDiagnosticsParams);
    } else if (message.method === 'window/logMessage') {
      const params = message.params as { type: number; message: string };
      console.log(`[ESLint LSP] ${params.message}`);
    } else if (message.method === 'eslint/status') {
      // ESLint server status notification
      const params = message.params as { state: number };
      console.log(`[ESLint LSP] Status: ${params.state === 1 ? 'OK' : 'Error'}`);
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
  codeDescription?: {
    href: string;
  };
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
    id: `eslint:${filePath}:${diag.range.start.line}:${diag.range.start.character}:${index}`,
    file: filePath,
    fileName,
    line: diag.range.start.line + 1, // LSP is 0-based, we use 1-based
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    severity: mapSeverity(diag.severity ?? 2), // Default to warning for ESLint
    source: diag.source || 'eslint',
    code: diag.code?.toString()
  }));

  // Merge with existing problems (don't overwrite TS or Tailwind problems)
  problemsStore.setProblemsForFile(filePath, problems, 'eslint');
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
      eslintServerTransport = await registry.startServer('eslint', {
        serverId: 'eslint-main',
        cwd: projectStore.rootPath ?? undefined
      });

      // Set up message handler
      eslintServerTransport.onMessage(handleLspMessage);

      // Set up error handler
      eslintServerTransport.onError((error) => {
        console.error('[ESLint LSP] Server error:', error);
      });

      // Set up exit handler
      eslintServerTransport.onExit(() => {
        console.log('[ESLint LSP] Server exited');
        eslintServerTransport = null;
        eslintServerInitialized = false;
        initializationPromise = null;
        openDocuments.clear();
      });

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

      console.log('[ESLint LSP] Server initialized:', initResult);

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

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(normalizedPath);
  if (existing && existing.content === content) return;

  if (!eslintServerTransport || !eslintServerInitialized) return;

  const uri = pathToUri(normalizedPath);
  const languageId = getLanguageId(normalizedPath);

  // Track document
  openDocuments.set(normalizedPath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await eslintServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await eslintServerTransport.sendNotification('textDocument/didOpen', {
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
export async function notifyEslintDocumentChanged(filepath: string, content: string): Promise<void> {
  const normalizedPath = normalizeFilePath(filepath);
  if (!isEslintFile(normalizedPath)) return;
  if (!eslintServerTransport || !eslintServerInitialized) return;

  const doc = openDocuments.get(normalizedPath);
  if (!doc) {
    // Document wasn't opened, open it now
    await notifyEslintDocumentOpened(normalizedPath, content);
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

    if (!eslintServerTransport || !eslintServerInitialized) return;

    // Send didChange notification with full content
    await eslintServerTransport.sendNotification('textDocument/didChange', {
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
export async function notifyEslintDocumentSaved(filepath: string, content: string): Promise<void> {
  const normalizedPath = normalizeFilePath(filepath);
  if (!isEslintFile(normalizedPath)) return;
  if (!eslintServerTransport || !eslintServerInitialized) return;

  const uri = pathToUri(normalizedPath);

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

  openDocuments.delete(normalizedPath);

  const uri = pathToUri(normalizedPath);

  await eslintServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri }
  });

  // Clear ESLint problems for this file
  problemsStore.clearProblemsForFile(normalizedPath, 'eslint');
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
  openDocuments.clear();

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
  console.log(`[ESLint LSP] Pushing updated config with packageManager: ${packageManager}`);

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
    for (const [filepath, doc] of openDocuments.entries()) {
      void notifyEslintDocumentChanged(filepath, doc.content);
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

  // Use dynamic import for fileIndex to avoid circular deps
  const { getAllFiles } = await import('$lib/services/file-index');
  const { readFileQuiet } = await import('$lib/services/file-system');

  const allFiles = getAllFiles();
  const eslintFiles = allFiles.filter(f => isEslintFile(f.path));

  if (eslintFiles.length === 0) {
    console.log('[ESLint LSP] No JS/TS files found for background analysis.');
    return;
  }

  console.log(`[ESLint LSP] Starting project-wide analysis of ${eslintFiles.length} files...`);

  // Process files with delay to avoid overwhelming the server
  for (const file of eslintFiles) {
    const normalizedPath = normalizeFilePath(file.path);

    // Skip if already open
    if (openDocuments.has(normalizedPath)) continue;

    const content = await readFileQuiet(file.path);
    if (content) {
      await notifyEslintDocumentOpened(normalizedPath, content);
      // Small delay to let server process
      await new Promise(r => setTimeout(r, 50));
    }
  }

  console.log('[ESLint LSP] Project-wide analysis complete.');
}
