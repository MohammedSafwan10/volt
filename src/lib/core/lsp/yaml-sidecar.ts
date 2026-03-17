/**
 * YAML LSP Sidecar Service
 * 
 * Provides YAML intelligence using yaml-language-server.
 * Supports:
 * - All YAML files (.yaml, .yml)
 * - Schema validation (from SchemaStore.org)
 * - Kubernetes manifest validation
 * - GitHub Actions workflows
 * - Docker Compose files
 * - CI/CD configs (CircleCI, GitLab, etc.)
 * 
 * Usage:
 * - Install: npm install -g yaml-language-server
 * - Server starts when opening a YAML file
 */

import { getLspRegistry } from './sidecar/register';
import { LspTransport } from './sidecar/transport';
import {
  rehydrateTrackedDocuments,
  sendDidSaveForTrackedDocument,
} from './sidecar/document-lifecycle';
import {
  clearSourceProblemsForFile,
  markSourceSessionReady,
  markSourceSessionStale,
  setSourceProblemsForFile,
  startSourceSession,
  createLspRecoveryController,
} from './sidecar';
import { type Problem, type ProblemSeverity } from '$shared/stores/problems.svelte';
import { projectStore } from '$shared/stores/project.svelte';
import { detectYamlLsp, isYamlLspAvailable, type YamlLspInfo } from './yaml-sdk';

let yamlServerTransport: LspTransport | null = null;
let yamlServerInitialized = false;
let yamlSessionGeneration = 0;
const yamlRecovery = createLspRecoveryController({
  source: 'yaml',
  restart: async () => {
    await recoverYamlLspAfterExit();
  },
});

// Track open documents
const openDocuments = new Map<string, { version: number; content: string }>();

async function rehydrateOpenDocuments(): Promise<void> {
  await rehydrateTrackedDocuments(openDocuments, notifyDocumentOpened);
}

// Debounce diagnostics
const diagnosticDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Check if a file is a YAML file
 */
export function isYamlFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ext === 'yaml' || ext === 'yml';
}

/**
 * Get the language ID for LSP
 */
function getLanguageId(): string {
  return 'yaml';
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
 * Check if YAML LSP SDK is available
 */
export async function checkYamlLspAvailable(): Promise<boolean> {
  return await isYamlLspAvailable();
}

/**
 * Check if YAML LSP is running
 */
export function isYamlLspRunning(): boolean {
  return yamlServerTransport !== null && yamlServerInitialized;
}

/**
 * Initialize the YAML Language Server
 */
export async function initializeServer(): Promise<boolean> {
  if (yamlServerInitialized && yamlServerTransport) {
    return true;
  }

  const rootPath = projectStore.rootPath;
  if (!rootPath) {
    console.warn('[YAML LSP] No project root path');
    return false;
  }

  // Detect YAML LSP
  const lspInfo = await detectYamlLsp();
  if (!lspInfo) {
    console.warn('[YAML LSP] yaml-language-server not found. Install via: npm i -g yaml-language-server');
    return false;
  }

  try {
    console.log('[YAML LSP] Starting server with:', lspInfo.serverPath);

    // Start the server via registry
    const registry = getLspRegistry();
    yamlServerTransport = await registry.startServer('yaml', {
      cwd: rootPath,
      restartPolicy: {
        enabled: true,
        baseDelayMs: 1000,
        maxDelayMs: 12_000,
        maxAttempts: 4,
        windowMs: 120_000,
      },
    });
    yamlServerTransport.configureHealth({ autoRestart: true });
    yamlSessionGeneration = startSourceSession('yaml');

    if (!yamlServerTransport) {
      console.error('[YAML LSP] Failed to start server');
      return false;
    }

    // Set up message handler
    yamlServerTransport.onMessage(handleServerMessage);
    yamlServerTransport.onExit(() => {
      console.log('[YAML LSP] Server exited');
      yamlSessionGeneration = markSourceSessionStale('yaml');
      yamlRecovery.schedule('transport exit');
      yamlServerTransport = null;
      yamlServerInitialized = false;
      openDocuments.clear();
    });
    yamlServerTransport.onRestart(async () => {
      yamlSessionGeneration = startSourceSession('yaml');
      markSourceSessionReady('yaml', yamlSessionGeneration);
      await rehydrateOpenDocuments();
    });

    // Send initialize request
    const initResult = await yamlServerTransport.sendRequest('initialize', {
      processId: null,
      rootUri: pathToUri(rootPath),
      rootPath: rootPath,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },
          },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          hover: {
            contentFormat: ['markdown', 'plaintext'],
          },
          definition: {
            linkSupport: true,
          },
          formatting: {
            dynamicRegistration: true,
          },
          synchronization: {
            didSave: true,
            willSave: true,
            willSaveWaitUntil: true,
          },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          didChangeConfiguration: {
            dynamicRegistration: true,
          },
        },
      },
      workspaceFolders: [
        {
          uri: pathToUri(rootPath),
          name: rootPath.split(/[\\/]/).pop() || 'project',
        },
      ],
    });

    console.log('[YAML LSP] Initialize result:', initResult);

    // Send initialized notification
    await yamlServerTransport.sendNotification('initialized', {});

    // Configure YAML settings with schema store enabled
    await yamlServerTransport.sendNotification('workspace/didChangeConfiguration', {
      settings: {
        yaml: {
          validate: true,
          hover: true,
          completion: true,
          format: { enable: true },
          schemaStore: { enable: true },
          schemas: {
            // Common Flutter/mobile development YAML files
            'https://json.schemastore.org/pubspec': ['**/pubspec.yaml'],
            'https://json.schemastore.org/github-workflow': ['.github/workflows/*.yaml', '.github/workflows/*.yml'],
            'https://json.schemastore.org/github-action': ['**/action.yaml', '**/action.yml'],
            'https://json.schemastore.org/docker-compose': ['**/docker-compose*.yaml', '**/docker-compose*.yml', '**/compose*.yaml', '**/compose*.yml'],
            'https://json.schemastore.org/circleciconfig': ['.circleci/config.yml'],
            'https://json.schemastore.org/gitlab-ci': ['.gitlab-ci.yml'],
            'https://json.schemastore.org/dependabot-2.0': ['.github/dependabot.yml'],
            'https://json.schemastore.org/renovate': ['renovate.json', '.renovaterc', '.renovaterc.json'],
          },
        },
      },
    });

    yamlServerInitialized = true;
    markSourceSessionReady('yaml', yamlSessionGeneration);
    yamlRecovery.reset();
    console.log('[YAML LSP] Server initialized successfully');
    return true;
  } catch (error) {
    console.error('[YAML LSP] Initialization failed:', error);
    yamlServerTransport = null;
    yamlServerInitialized = false;
    return false;
  }
}

/**
 * Handle messages from the server
 */
function handleServerMessage(message: any): void {
  // Handle server requests that require a response
  if ('id' in message && 'method' in message && message.id !== null) {
    const id = message.id;
    if (message.method === 'workspace/configuration') {
      const items = (message.params as any)?.items || [];
      const result = items.map(() => ({}));
      yamlServerTransport?.sendResponse(id, result);
    } else {
      yamlServerTransport?.sendResponse(id, null);
    }
    return;
  }

  // Handle notifications
  if ('method' in message && !('id' in message)) {
    if (message.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(message.params as { uri: string; diagnostics: unknown[] });
    }
  }
}

/**
 * Handle diagnostics from the server
 */
function handleDiagnostics(params: { uri: string; diagnostics: unknown[] }): void {
  const filepath = uriToPath(params.uri);
  const fileName = filepath.split(/[\\/]/).pop() || filepath;

  // Map LSP diagnostics to our Problem format
  const problems: Problem[] = params.diagnostics.map((diag: unknown, index: number) => {
    const d = diag as {
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      message: string;
      severity?: number;
      code?: string | number;
      source?: string;
    };

    const severityMap: Record<number, ProblemSeverity> = {
      1: 'error',
      2: 'warning',
      3: 'info',
      4: 'hint',
    };

    return {
      id: `yaml-${filepath}-${d.range.start.line}-${d.range.start.character}-${index}`,
      file: filepath,
      fileName,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      severity: severityMap[d.severity || 1] || 'error',
      source: d.source || 'yaml-language-server',
      code: d.code?.toString(),
    };
  });

  // Update problems store
  setSourceProblemsForFile({
    source: 'yaml',
    generation: yamlSessionGeneration,
    filePath: filepath,
    problems,
  });
}

/**
 * Notify the server that a document was opened
 */
export async function notifyDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isYamlFile(filepath)) return;
  if (!projectStore.rootPath) return;

  // Initialize server if needed
  await initializeServer();

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(filepath);
  if (existing && existing.content === content) return;

  if (!yamlServerTransport || !yamlServerInitialized) return;

  const uri = pathToUri(filepath);
  const languageId = getLanguageId();

  // Track document
  openDocuments.set(filepath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await yamlServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await yamlServerTransport.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId,
      version: 1,
      text: content,
    },
  });
}

/**
 * Notify the server that a document was changed
 */
export async function notifyDocumentChanged(filepath: string, content: string): Promise<void> {
  if (!isYamlFile(filepath)) return;
  if (!yamlServerTransport || !yamlServerInitialized) return;

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

      if (!yamlServerTransport || !yamlServerInitialized) return;

      await yamlServerTransport.sendNotification('textDocument/didChange', {
        textDocument: {
          uri,
          version: doc.version,
        },
        contentChanges: [{ text: content }],
      });
    }, 200)
  );
}

/**
 * Notify the server that a document was closed
 */
export async function notifyDocumentClosed(filepath: string): Promise<void> {
  if (!isYamlFile(filepath)) return;
  if (!yamlServerTransport || !yamlServerInitialized) return;

  openDocuments.delete(filepath);

  const timer = diagnosticDebounceTimers.get(filepath);
  if (timer) {
    clearTimeout(timer);
    diagnosticDebounceTimers.delete(filepath);
  }

  const uri = pathToUri(filepath);
  await yamlServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri },
  });

  // Clear diagnostics for this file
  clearSourceProblemsForFile({
    source: 'yaml',
    generation: yamlSessionGeneration,
    filePath: filepath,
  });
}

export async function notifyDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isYamlFile(filepath)) return;
  await sendDidSaveForTrackedDocument({
    filepath,
    content,
    openDocuments,
    transport: yamlServerTransport,
    initialized: yamlServerInitialized,
    ensureOpen: notifyDocumentOpened,
    pathToUri,
  });
}

/**
 * Get hover information
 */
export async function getHover(filepath: string, line: number, character: number): Promise<unknown> {
  if (!yamlServerTransport || !yamlServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await yamlServerTransport.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });
    return result;
  } catch (error) {
    console.error('[YAML LSP] Hover error:', error);
    return null;
  }
}

/**
 * Get completions
 */
export async function getCompletions(filepath: string, line: number, character: number): Promise<unknown> {
  if (!yamlServerTransport || !yamlServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await yamlServerTransport.sendRequest('textDocument/completion', {
      textDocument: { uri },
      position: { line, character },
    });
    return result;
  } catch (error) {
    console.error('[YAML LSP] Completion error:', error);
    return null;
  }
}

/**
 * Format document
 */
export async function formatDocument(filepath: string): Promise<unknown> {
  if (!yamlServerTransport || !yamlServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    const result = await yamlServerTransport.sendRequest('textDocument/formatting', {
      textDocument: { uri },
      options: {
        tabSize: 2,
        insertSpaces: true,
      },
    });
    return result;
  } catch (error) {
    console.error('[YAML LSP] Format error:', error);
    return null;
  }
}

/**
 * Stop the YAML LSP server
 */
async function recoverYamlLspAfterExit(): Promise<void> {
  if (!projectStore.rootPath || yamlServerTransport) {
    return;
  }

  const initialized = await initializeServer();
  if (!initialized) {
    throw new Error('YAML LSP restart failed');
  }
}

export async function stopYamlLsp(): Promise<void> {
  if (!yamlServerTransport) return;

  try {
    // Clear all debounce timers
    for (const timer of diagnosticDebounceTimers.values()) {
      clearTimeout(timer);
    }
    diagnosticDebounceTimers.clear();

    // Send shutdown request
    await yamlServerTransport.sendRequest('shutdown', null);
    await yamlServerTransport.sendNotification('exit', null);
  } catch (error) {
    console.error('[YAML LSP] Shutdown error:', error);
  } finally {
    const registry = getLspRegistry();
    void registry.stopServer('yaml');
    yamlServerTransport = null;
    yamlServerInitialized = false;
    openDocuments.clear();
    yamlSessionGeneration = markSourceSessionStale('yaml');
    yamlRecovery.reset();
  }
}
