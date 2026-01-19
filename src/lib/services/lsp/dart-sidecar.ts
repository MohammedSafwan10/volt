/**
 * Dart LSP Sidecar Service
 * 
 * Provides full-project Dart/Flutter intelligence using the Dart Analysis Server
 * in LSP mode (dart language-server).
 * 
 * Features:
 * - Project-wide diagnostics (respects analysis_options.yaml)
 * - Go-to-definition
 * - Hover information
 * - Completions
 * - Find references
 * - Code actions (quick fixes, refactors)
 * - Formatting
 * 
 * Strategy:
 * - Start server when opening a Dart file in a project
 * - Workspace root = projectStore.rootPath
 * - Requires Dart SDK installed on user's system
 */

import { getLspRegistry, type LspTransport, type JsonRpcMessage } from './sidecar';
import { problemsStore, type Problem, type ProblemSeverity } from '$lib/stores/problems.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { detectDartSdk, isDartAvailable, type DartSdkInfo } from './dart-sdk';

// Server instance tracking
let dartServerTransport: LspTransport | null = null;
let dartServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializedRootPath: string | null = null;
let dartSdkInfo: DartSdkInfo | null = null;
let isAnalyzing = false;

// Document tracking
const openDocuments = new Map<string, { version: number; content: string }>();

// Debounce timers
const diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_DEBOUNCE_MS = 150;

/**
 * Check if a file is a Dart file
 */
export function isDartFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ext === 'dart';
}

/**
 * Check if a file is a Dart project config file (analyzed by Dart LSP)
 * Dart Analysis Server provides validation for pubspec.yaml and analysis_options.yaml
 */
export function isDartProjectFile(filepath: string): boolean {
  const filename = filepath.split(/[\/\\]/).pop()?.toLowerCase() || '';
  return filename === 'pubspec.yaml' || filename === 'analysis_options.yaml';
}

/**
 * Check if file should be handled by Dart LSP (either .dart or project config)
 */
export function isDartLspFile(filepath: string): boolean {
  return isDartFile(filepath) || isDartProjectFile(filepath);
}

/**
 * Get the language ID for LSP
 */
function getLanguageId(filepath: string): string {
  if (isDartProjectFile(filepath)) return 'yaml';
  return 'dart';
}

/**
 * Convert file path to URI
 */
function pathToUri(filepath: string): string {
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
  if (!uri.startsWith('file://')) {
    return uri; // Return as is for package:, dart:, etc.
  }
  let path = uri.replace('file://', '');
  if (path.match(/^\/[a-zA-Z]:/)) {
    path = path.slice(1);
  }
  // Normalize drive letter to lowercase for consistency
  if (path.match(/^[a-zA-Z]:/)) {
    path = path[0].toLowerCase() + path.slice(1);
  }
  return decodeURIComponent(path).replace(/\\/g, '/');
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
      // Respond with default configurations to unblock the server
      const items = (message.params as any)?.items || [];
      const result = items.map(() => ({}));
      dartServerTransport?.sendResponse(id, result);
    } else {
      // Respond with null for other requests to avoid blocking the server's state machine
      dartServerTransport?.sendResponse(id, null);
    }
    return;
  }

  // Handle server notifications (no id)
  if ('method' in message && !('id' in message)) {
    if (message.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(message.params as PublishDiagnosticsParams);
    } else if (message.method === 'window/logMessage') {
      const params = message.params as { type: number; message: string };
      console.log(`[Dart LSP] ${params.message}`);
    } else if (message.method === 'dart/textDocument/publishClosingLabels') {
      // Dart-specific: closing labels for widgets
    } else if (message.method === 'dart/textDocument/publishFlutterOutline') {
      // Dart-specific: Flutter widget outline
    } else if (message.method === '$/analyzerStatus') {
      isAnalyzing = (message.params as any)?.isAnalyzing || false;
      console.log(`[Dart LSP] Analysis status: ${isAnalyzing ? 'Analyzing...' : 'Ready'}`);
    } else if (message.method === '$/progress') {
      // Progress support
      const params = message.params as any;
      if (params.value?.kind === 'begin') isAnalyzing = true;
      if (params.value?.kind === 'end') isAnalyzing = false;
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
    line: diag.range.start.line + 1,
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    severity: mapSeverity(diag.severity ?? 1),
    source: diag.source || 'dart',
    code: diag.code?.toString()
  }));

  problemsStore.setProblemsForFile(filePath, problems, 'dart');
}

/**
 * Check if Dart SDK is available
 */
export async function checkDartSdkAvailable(): Promise<boolean> {
  return isDartAvailable();
}

/**
 * Get Dart SDK info
 */
export async function getDartSdkInfo(): Promise<DartSdkInfo | null> {
  if (!dartSdkInfo) {
    dartSdkInfo = await detectDartSdk();
  }
  return dartSdkInfo;
}

/**
 * Check if the Dart LSP is ready (initialized and finished initial analysis)
 */
export function isDartLspReady(): boolean {
  return dartServerInitialized && !isAnalyzing;
}

/**
 * Initialize the Dart language server
 */
async function initializeServer(): Promise<void> {
  if (!projectStore.rootPath) return;

  // Check if Dart SDK is available
  dartSdkInfo = await detectDartSdk();
  if (!dartSdkInfo) {
    console.warn('[Dart LSP] Dart SDK not found. Install Flutter or Dart SDK to enable Dart support.');
    return;
  }

  // If workspace root changed, restart
  if (dartServerInitialized && initializedRootPath && projectStore.rootPath !== initializedRootPath) {
    await stopDartLsp();
  }

  if (dartServerInitialized) return;

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      const registry = getLspRegistry();

      // Start the Dart server (uses external server mechanism)
      dartServerTransport = await registry.startServer('dart', {
        serverId: 'dart-main',
        cwd: projectStore.rootPath ?? undefined
      });

      // Set up message handler
      dartServerTransport.onMessage(handleLspMessage);

      // Set up error handler
      dartServerTransport.onError((error) => {
        console.error('[Dart LSP] Server error:', error);
      });

      // Set up exit handler
      dartServerTransport.onExit(() => {
        console.log('[Dart LSP] Server exited');
        dartServerTransport = null;
        dartServerInitialized = false;
        initializationPromise = null;
        initializedRootPath = null;
        openDocuments.clear();
      });

      // Send initialize request
      const rootUri = pathToUri(projectStore.rootPath!);

      const initResult = await dartServerTransport.sendRequest('initialize', {
        processId: null,
        rootUri,
        rootPath: projectStore.rootPath?.replace(/\\/g, '/') || null,
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
                    'source.organizeImports',
                    'source.fixAll'
                  ]
                }
              },
              resolveSupport: {
                properties: ['edit']
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
            name: projectStore.projectName || 'root'
          }
        ],
        initializationOptions: {
          // Dart-specific initialization options
          closingLabels: true, // Show closing labels for widgets
          flutterOutline: true, // Enable Flutter widget outline
          outline: true,
          suggestFromUnimportedLibraries: true,
          onlyAnalyzeProjectsWithOpenFiles: false,
        }
      });

      console.log('[Dart LSP] Server initialized:', initResult);

      // Send initialized notification
      await dartServerTransport.sendNotification('initialized', {});

      dartServerInitialized = true;
      initializedRootPath = projectStore.rootPath ?? null;

      console.log('[Dart LSP] Using Dart SDK:', dartSdkInfo);
    } catch (error) {
      console.error('[Dart LSP] Failed to initialize server:', error);
      dartServerTransport = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}


/**
 * Notify the server that a document was opened
 */
export async function notifyDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isDartLspFile(filepath)) return;
  if (!projectStore.rootPath) return;

  // Initialize server if needed
  await initializeServer();

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(filepath);
  if (existing && existing.content === content) return;

  if (!dartServerTransport || !dartServerInitialized) return;

  const uri = pathToUri(filepath);
  const languageId = getLanguageId(filepath);

  // Track document
  openDocuments.set(filepath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await dartServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await dartServerTransport.sendNotification('textDocument/didOpen', {
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
export async function notifyDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isDartLspFile(filepath)) return;
  if (!dartServerTransport || !dartServerInitialized) return;

  const doc = openDocuments.get(filepath);
  if (!doc) {
    await notifyDocumentOpened(filepath, content);
    return;
  }

  doc.version++;
  doc.content = content;

  const uri = pathToUri(filepath);

  // Clear existing debounce timer
  const existingTimer = diagnosticDebounceTimers.get(filepath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Debounce the notification
  diagnosticDebounceTimers.set(
    filepath,
    setTimeout(async () => {
      diagnosticDebounceTimers.delete(filepath);

      if (!dartServerTransport || !dartServerInitialized) return;

      await dartServerTransport.sendNotification('textDocument/didChange', {
        textDocument: {
          uri,
          version: doc.version
        },
        contentChanges: [{ text: content }]
      });
    }, DIAGNOSTIC_DEBOUNCE_MS)
  );
}

/**
 * Notify the server that a document was closed
 */
export async function notifyDocumentClosed(filepath: string): Promise<void> {
  if (!isDartLspFile(filepath)) return;
  if (!dartServerTransport || !dartServerInitialized) return;

  openDocuments.delete(filepath);

  const timer = diagnosticDebounceTimers.get(filepath);
  if (timer) {
    clearTimeout(timer);
    diagnosticDebounceTimers.delete(filepath);
  }

  const uri = pathToUri(filepath);
  await dartServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri }
  });

  // Clear diagnostics for this file
  problemsStore.clearProblemsForFile(filepath, 'dart');
}

/**
 * Notify the server that a document was saved
 */
export async function notifyDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isDartLspFile(filepath)) return;
  if (!dartServerTransport || !dartServerInitialized) return;

  const uri = pathToUri(filepath);

  await dartServerTransport.sendNotification('textDocument/didSave', {
    textDocument: { uri },
    text: content
  });
}

/**
 * Go to definition
 */
export async function goToDefinition(filepath: string, line: number, character: number): Promise<unknown> {
  if (!dartServerTransport || !dartServerInitialized) return null;

  const uri = pathToUri(filepath);
  return dartServerTransport.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line, character }
  });
}

/**
 * Get hover information
 */
export async function getHover(filepath: string, line: number, character: number): Promise<unknown> {
  if (!dartServerTransport || !dartServerInitialized) return null;

  const uri = pathToUri(filepath);
  return dartServerTransport.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line, character }
  });
}

/**
 * Get completions
 */
export async function getCompletions(filepath: string, line: number, character: number): Promise<unknown> {
  if (!dartServerTransport || !dartServerInitialized) return null;

  const uri = pathToUri(filepath);
  return dartServerTransport.sendRequest('textDocument/completion', {
    textDocument: { uri },
    position: { line, character }
  });
}

/**
 * Find references
 */
export async function findReferences(filepath: string, line: number, character: number): Promise<unknown> {
  if (!dartServerTransport || !dartServerInitialized) return null;

  const uri = pathToUri(filepath);
  return dartServerTransport.sendRequest('textDocument/references', {
    textDocument: { uri },
    position: { line, character },
    context: { includeDeclaration: true }
  });
}

/**
 * Rename symbol
 */
export async function renameSymbol(filepath: string, line: number, character: number, newName: string): Promise<unknown> {
  if (!dartServerTransport || !dartServerInitialized) return null;

  const uri = pathToUri(filepath);
  return dartServerTransport.sendRequest('textDocument/rename', {
    textDocument: { uri },
    position: { line, character },
    newName
  });
}

/**
 * Get code actions (quick fixes, refactors)
 */
export async function getCodeActions(filepath: string, startLine: number, startChar: number, endLine: number, endChar: number): Promise<unknown> {
  if (!dartServerTransport || !dartServerInitialized) return null;

  const uri = pathToUri(filepath);
  return dartServerTransport.sendRequest('textDocument/codeAction', {
    textDocument: { uri },
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar }
    },
    context: {
      diagnostics: [],
      only: ['quickfix', 'refactor', 'source']
    }
  });
}

/**
 * Get workspace symbols
 */
export async function getWorkspaceSymbols(query: string): Promise<any> {
  if (!dartServerTransport || !dartServerInitialized) return null;

  return dartServerTransport.sendRequest('workspace/symbol', {
    query
  });
}

/**
 * Format document
 */
export async function formatDocument(filepath: string): Promise<unknown> {
  if (!dartServerTransport || !dartServerInitialized) return null;

  const uri = pathToUri(filepath);
  return dartServerTransport.sendRequest('textDocument/formatting', {
    textDocument: { uri },
    options: {
      tabSize: 2,
      insertSpaces: true
    }
  });
}

/**
 * Stop the Dart LSP server
 */
export async function stopDartLsp(): Promise<void> {
  if (dartServerTransport) {
    try {
      await dartServerTransport.sendRequest('shutdown', null);
      await dartServerTransport.sendNotification('exit', null);
    } catch {
      // Ignore errors during shutdown
    }
    await dartServerTransport.stop();
  }

  dartServerTransport = null;
  dartServerInitialized = false;
  initializationPromise = null;
  initializedRootPath = null;
  openDocuments.clear();

  for (const timer of diagnosticDebounceTimers.values()) {
    clearTimeout(timer);
  }
  diagnosticDebounceTimers.clear();
}

/**
 * Restart the Dart LSP server
 */
export async function restartDartLsp(): Promise<void> {
  await stopDartLsp();
  if (projectStore.rootPath) {
    await initializeServer();
  }
}

/**
 * Check if the Dart LSP is running
 */
export function isDartLspRunning(): boolean {
  return dartServerInitialized && dartServerTransport !== null;
}

/**
 * Notify the server about file changes on disk (created, changed, deleted)
 * Used by the file watcher to keep the LSP in sync with external changes (e.g. AI edits, git)
 */
export async function notifyFileChanges(events: Array<{ kind: 'create' | 'change' | 'delete', path: string }>): Promise<void> {
  if (!dartServerTransport || !dartServerInitialized) return;

  const changes = events.map(event => {
    let type: 1 | 2 | 3;
    switch (event.kind) {
      case 'create': type = 1; break;
      case 'change': type = 2; break;
      case 'delete': type = 3; break;
      default: type = 2;
    }
    return {
      uri: pathToUri(event.path),
      type
    };
  });

  await dartServerTransport.sendNotification('workspace/didChangeWatchedFiles', {
    changes
  });
}

/**
 * Get the Dart server transport (for advanced use)
 */
export function getDartTransport(): LspTransport | null {
  return dartServerTransport;
}
