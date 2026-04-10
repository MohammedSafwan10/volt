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

import {
  getLspRegistry,
  type LspTransport,
  type JsonRpcMessage,
} from './sidecar';
import { projectStore } from '$shared/stores/project.svelte';
import {
  detectDartSdk,
  getLastDartSdkDetectionIssue,
  isDartAvailable,
  clearDartSdkCache,
  type DartSdkInfo,
} from './dart-sdk';
import { readFileQuiet } from '$core/services/file-system';
import { getAllFiles } from '$core/services/file-index';
import { waitForProjectDiagnosticsDelay } from '$core/services/project-diagnostics-timing';
import { settingsStore } from '$shared/stores/settings.svelte';
import { showToast } from '$shared/stores/toast.svelte';

// Server instance tracking
let dartServerTransport: LspTransport | null = null;
let dartServerInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializedRootPath: string | null = null;
let dartSdkInfo: DartSdkInfo | null = null;
let isAnalyzing = false;
let lastDartStartupIssue: string | null = null;

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
  const filename = filepath.split(/[/\\]/).pop()?.toLowerCase() || '';
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
 * Handle incoming LSP messages
 */
interface WorkspaceConfigurationParams {
  items?: unknown[];
}

interface AnalyzerStatusParams {
  isAnalyzing?: boolean;
}

interface ProgressParams {
  value?: {
    kind?: 'begin' | 'report' | 'end' | string;
  };
}

function handleLspMessage(message: JsonRpcMessage): void {
  // Handle server requests that require a response
  if ('id' in message && 'method' in message && message.id !== null) {
    const id = message.id;
    if (message.method === 'workspace/configuration') {
      // Respond with default configurations to unblock the server
      const items = (message.params as WorkspaceConfigurationParams | undefined)?.items || [];
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
    if (message.method === 'window/logMessage') {
      const params = message.params as { type: number; message: string };
      console.log(`[Dart LSP] ${params.message}`);
    } else if (message.method === 'dart/textDocument/publishClosingLabels') {
      // Dart-specific: closing labels for widgets
    } else if (message.method === 'dart/textDocument/publishFlutterOutline') {
      // Dart-specific: Flutter widget outline
    } else if (message.method === '$/analyzerStatus') {
      isAnalyzing = (message.params as AnalyzerStatusParams | undefined)?.isAnalyzing || false;
      console.log(`[Dart LSP] Analysis status: ${isAnalyzing ? 'Analyzing...' : 'Ready'}`);
    } else if (message.method === '$/progress') {
      // Progress support
      const params = message.params as ProgressParams | undefined;
      if (params?.value?.kind === 'begin') isAnalyzing = true;
      if (params?.value?.kind === 'end') isAnalyzing = false;
    }
  }
}

/**
 * Check if Dart SDK is available
 */
export async function checkDartSdkAvailable(): Promise<boolean> {
  return isDartAvailable({
    flutterSdkRoot: settingsStore.flutterSdkPath,
    dartSdkRoot: settingsStore.dartSdkPath,
  });
}

/**
 * Get Dart SDK info
 */
export async function getDartSdkInfo(): Promise<DartSdkInfo | null> {
  if (!dartSdkInfo) {
    dartSdkInfo = await detectDartSdk({
      flutterSdkRoot: settingsStore.flutterSdkPath,
      dartSdkRoot: settingsStore.dartSdkPath,
    });
  }
  return dartSdkInfo;
}

/**
 * Check if the Dart LSP is ready (initialized and finished initial analysis)
 */
export function isDartLspReady(): boolean {
  return dartServerInitialized && !isAnalyzing;
}

export function getDartLspStatus(): {
  running: boolean;
  ready: boolean;
  analyzing: boolean;
  initializedRootPath: string | null;
  sdkInfo: DartSdkInfo | null;
  lastIssue: string | null;
} {
  return {
    running: dartServerInitialized && dartServerTransport !== null,
    ready: isDartLspReady(),
    analyzing: isAnalyzing,
    initializedRootPath,
    sdkInfo: dartSdkInfo,
    lastIssue: lastDartStartupIssue ?? getLastDartSdkDetectionIssue(),
  };
}

/**
 * Initialize the Dart language server
 */
async function initializeServer(): Promise<void> {
  if (!projectStore.rootPath) return;

  // Check if Dart SDK is available
  dartSdkInfo = await detectDartSdk({
    flutterSdkRoot: settingsStore.flutterSdkPath,
    dartSdkRoot: settingsStore.dartSdkPath,
  });
  if (!dartSdkInfo) {
    lastDartStartupIssue =
      getLastDartSdkDetectionIssue() ??
      'Dart SDK not found. Install Flutter or Dart SDK to enable Dart support.';
    console.warn(`[Dart LSP] ${lastDartStartupIssue}`);
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
        cwd: projectStore.rootPath ?? undefined,
        restartPolicy: {
          enabled: true,
          baseDelayMs: 1000,
          maxDelayMs: 12_000,
          maxAttempts: 4,
          windowMs: 120_000,
        },
        command: dartSdkInfo.dartPath,
        args: ['language-server', '--client-id', 'volt-ide', '--client-version', '1.0.0']
      });
      dartServerTransport.configureHealth({ autoRestart: true });

      // Set up message handler
      dartServerTransport.onMessage(handleLspMessage);

      // Set up error handler
      dartServerTransport.onError((error) => {
        console.error('[Dart LSP] Server error:', error);
      });

      // Set up exit handler
      dartServerTransport.onExit(() => {
        console.log('[Dart LSP] Server exited');
        dartServerInitialized = false;
        initializationPromise = null;
      });
      dartServerTransport.onRestart(() => {
        console.log('[Dart LSP] Server restarted');
        dartServerInitialized = true;
        initializedRootPath = projectStore.rootPath ?? initializedRootPath;
        lastDartStartupIssue = null;
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
      lastDartStartupIssue = null;

      console.log('[Dart LSP] Using Dart SDK:', dartSdkInfo);
    } catch (error) {
      lastDartStartupIssue = error instanceof Error ? error.message : String(error);
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

  if (!dartServerTransport || !dartServerInitialized) return;

  const languageId = getLanguageId(filepath);
  await dartServerTransport.syncDocument(filepath, languageId, content);
}

/**
 * Notify the server that a document was changed
 */
export async function notifyDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isDartLspFile(filepath)) return;
  if (!dartServerTransport || !dartServerInitialized) return;

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

      await dartServerTransport.syncDocument(filepath, getLanguageId(filepath), content);
    }, DIAGNOSTIC_DEBOUNCE_MS)
  );
}

/**
 * Notify the server that a document was closed
 */
export async function notifyDocumentClosed(filepath: string): Promise<void> {
  if (!isDartLspFile(filepath)) return;
  if (!dartServerTransport || !dartServerInitialized) return;

  const timer = diagnosticDebounceTimers.get(filepath);
  if (timer) {
    clearTimeout(timer);
    diagnosticDebounceTimers.delete(filepath);
  }

  await dartServerTransport.closeDocument(filepath);
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
export async function getWorkspaceSymbols(query: string): Promise<unknown> {
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
  lastDartStartupIssue = null;

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

export async function rescanDartSdk(): Promise<void> {
  clearDartSdkCache();
  dartSdkInfo = null;
  lastDartStartupIssue = null;

  if (projectStore.rootPath) {
    await restartDartLsp();
  } else {
    dartSdkInfo = await detectDartSdk({
      flutterSdkRoot: settingsStore.flutterSdkPath,
      dartSdkRoot: settingsStore.dartSdkPath,
    });
    lastDartStartupIssue = getLastDartSdkDetectionIssue();
  }

  if (dartSdkInfo?.flutterSdkRoot && !settingsStore.flutterSdkPath.trim()) {
    settingsStore.setFlutterSdkPath(dartSdkInfo.flutterSdkRoot);
  }

  showToast({
    message: dartSdkInfo
      ? `Dart SDK detected via ${dartSdkInfo.detectionSource}`
      : (lastDartStartupIssue ?? 'Dart SDK scan completed with no valid SDK found.'),
    type: dartSdkInfo ? 'success' : 'warning',
  });
}

/**
 * Check if the Dart LSP is running
 */
export function isDartLspRunning(): boolean {
  return dartServerInitialized && dartServerTransport !== null;
}

/**
 * Start the Dart LSP server for a project
 * Called when opening a project to enable project-wide diagnostics
 */
export async function startDartLsp(rootPath: string): Promise<void> {
  if (!rootPath) return;
  if (projectStore.rootPath !== rootPath) {
    console.log(
      '[Dart LSP] Skipping start for stale root:',
      rootPath,
      'current root is',
      projectStore.rootPath,
    );
    return;
  }
  console.log('[Dart LSP] Requested startup for root:', rootPath);
  // initializeServer already checks for rootPath and SDK availability
  await initializeServer();
}

/**
 * Get the Dart server transport (for advanced use)
 */
export function getDartTransport(): LspTransport | null {
  return dartServerTransport;
}

/**
 * Perform background analysis of all Dart files in the project
 * Opens files in the LSP to trigger diagnostics for the entire project
 */
export async function startProjectWideAnalysis(): Promise<void> {
  if (!projectStore.rootPath) return;
  if (!dartServerTransport || !dartServerInitialized) {
    console.log('[Dart LSP] Server not initialized, skipping project-wide analysis');
    return;
  }

  const allFiles = getAllFiles();
  const dartFiles = allFiles.filter(f => isDartLspFile(f.path));

  if (dartFiles.length === 0) {
    console.log('[Dart LSP] No Dart files found for background analysis.');
    return;
  }

  console.log(`[Dart LSP] Starting project-wide analysis of ${dartFiles.length} files...`);
  const trackedDocumentPaths = new Set(
    (await dartServerTransport.listTrackedDocuments()).map((document) =>
      document.filePath.replace(/\\/g, '/'),
    ),
  );

  const analysisFn = startProjectWideAnalysis as typeof startProjectWideAnalysis & { _runId?: number };
  const runId = (analysisFn._runId ?? 0) + 1;
  analysisFn._runId = runId;

  let processedSinceYield = 0;

  for (const file of dartFiles) {
    if (analysisFn._runId !== runId) {
      return;
    }

    const normalizedPath = file.path.replace(/\\/g, '/');

    // Skip if already open
    if (trackedDocumentPaths.has(normalizedPath)) continue;

    const content = await readFileQuiet(file.path);
    if (analysisFn._runId !== runId) {
      return;
    }

    if (content) {
      await notifyDocumentOpened(normalizedPath, content);
      trackedDocumentPaths.add(normalizedPath);
      processedSinceYield += 1;

      if (processedSinceYield >= 10) {
        processedSinceYield = 0;
        await waitForProjectDiagnosticsDelay(20);
        if (analysisFn._runId !== runId) {
          return;
        }
      }
    }
  }

  console.log('[Dart LSP] Project-wide analysis complete.');
}
