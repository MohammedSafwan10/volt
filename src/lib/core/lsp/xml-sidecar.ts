/**
 * XML LSP Sidecar Service (LemMinX)
 * 
 * Provides XML intelligence using Eclipse LemMinX.
 * Supports:
 * - All XML files (.xml)
 * - Android manifest (AndroidManifest.xml)
 * - iOS plist files (Info.plist)
 * - Maven POM files (pom.xml)
 * - XSD/DTD validation
 * - XML formatting
 * 
 * Usage:
 * - Install VS Code XML extension (includes binary)
 * - Or download LemMinX binary manually
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
import { detectXmlLsp, isXmlLspAvailable, type XmlLspInfo } from './xml-sdk';

let xmlServerTransport: LspTransport | null = null;
let xmlServerInitialized = false;
let xmlSessionGeneration = 0;
const xmlRecovery = createLspRecoveryController({
  source: 'xml',
  restart: async () => {
    await recoverXmlLspAfterExit();
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
 * Check if a file is an XML file
 */
export function isXmlFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  const filename = filepath.split(/[\\/]/).pop()?.toLowerCase() || '';

  // Standard XML extensions
  if (ext === 'xml' || ext === 'xsd' || ext === 'xsl' || ext === 'xslt' || ext === 'svg') {
    return true;
  }

  // iOS plist files
  if (ext === 'plist') {
    return true;
  }

  // Android specific files
  if (filename === 'androidmanifest.xml' || filename.endsWith('.xml')) {
    return ext === 'xml';
  }

  return false;
}

/**
 * Get the language ID for LSP
 */
function getLanguageId(filepath: string): string {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'plist') return 'plist';
  if (ext === 'xsd') return 'xsd';
  if (ext === 'xsl' || ext === 'xslt') return 'xsl';
  if (ext === 'svg') return 'svg';
  return 'xml';
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
 * Check if XML LSP is available
 */
export async function checkXmlLspAvailable(): Promise<boolean> {
  return await isXmlLspAvailable();
}

/**
 * Check if XML LSP is running
 */
export function isXmlLspRunning(): boolean {
  return xmlServerTransport !== null && xmlServerInitialized;
}

/**
 * Initialize the XML Language Server
 */
export async function initializeServer(): Promise<boolean> {
  if (xmlServerInitialized && xmlServerTransport) {
    return true;
  }

  const rootPath = projectStore.rootPath;
  if (!rootPath) {
    console.warn('[XML LSP] No project root path');
    return false;
  }

  // Detect XML LSP
  const lspInfo = await detectXmlLsp();
  if (!lspInfo) {
    console.warn('[XML LSP] LemMinX not found. See installation instructions.');
    return false;
  }

  try {
    console.log('[XML LSP] Starting server:', lspInfo);

    // Start the server via registry
    const registry = getLspRegistry();
    xmlServerTransport = await registry.startServer('xml', {
      cwd: rootPath,
      restartPolicy: {
        enabled: true,
        baseDelayMs: 1000,
        maxDelayMs: 12_000,
        maxAttempts: 4,
        windowMs: 120_000,
      },
    });
    xmlServerTransport.configureHealth({ autoRestart: true });
    xmlSessionGeneration = startSourceSession('xml');

    if (!xmlServerTransport) {
      console.error('[XML LSP] Failed to start server');
      return false;
    }

    // Set up message handler
    xmlServerTransport.onMessage(handleServerMessage);
    xmlServerTransport.onExit(() => {
      console.log('[XML LSP] Server exited');
      xmlSessionGeneration = markSourceSessionStale('xml');
      xmlRecovery.schedule('transport exit');
      xmlServerTransport = null;
      xmlServerInitialized = false;
      openDocuments.clear();
    });
    xmlServerTransport.onRestart(async () => {
      xmlSessionGeneration = startSourceSession('xml');
      markSourceSessionReady('xml', xmlSessionGeneration);
      await rehydrateOpenDocuments();
    });

    // Send initialize request
    const initResult = await xmlServerTransport.sendRequest('initialize', {
      processId: null,
      rootUri: pathToUri(rootPath),
      rootPath: rootPath,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
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
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ['quickfix', 'refactor', 'source'],
              },
            },
          },
          rename: {
            prepareSupport: true,
          },
          synchronization: {
            didSave: true,
          },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
        },
      },
      workspaceFolders: [
        {
          uri: pathToUri(rootPath),
          name: rootPath.split(/[\\/]/).pop() || 'project',
        },
      ],
    });

    console.log('[XML LSP] Initialize result:', initResult);

    // Send initialized notification
    await xmlServerTransport.sendNotification('initialized', {});

    // Configure XML settings
    await xmlServerTransport.sendNotification('workspace/didChangeConfiguration', {
      settings: {
        xml: {
          validation: {
            enabled: true,
            schema: { enabled: 'always' },
            namespaces: { enabled: 'always' },
          },
          format: {
            enabled: true,
            splitAttributes: false,
            joinCDATALines: false,
            joinContentLines: false,
            preserveEmptyContent: false,
            spaceBeforeEmptyCloseTag: true,
          },
          completion: {
            autoCloseTags: true,
          },
          codeLens: {
            enabled: false,
          },
          downloadExternalResources: {
            enabled: true,
          },
          fileAssociations: [
            // Android
            { pattern: '**/AndroidManifest.xml', systemId: 'https://raw.githubusercontent.com/nickcoutsos/android-manifest-xsd/master/android-manifest.xsd' },
            // iOS plist
            { pattern: '**/*.plist', systemId: 'https://raw.githubusercontent.com/nickcoutsos/plist-dtd/master/PropertyList-1.0.dtd' },
          ],
        },
      },
    });

    xmlServerInitialized = true;
    markSourceSessionReady('xml', xmlSessionGeneration);
    xmlRecovery.reset();
    console.log('[XML LSP] Server initialized successfully');
    return true;
  } catch (error) {
    console.error('[XML LSP] Initialization failed:', error);
    xmlServerTransport = null;
    xmlServerInitialized = false;
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
    if (message.method === 'workspace/configuration' || message.method === 'client/registerCapability') {
      const items = (message.params as any)?.items || [];
      const result = items.map(() => ({}));
      xmlServerTransport?.sendResponse(id, result);
    } else {
      xmlServerTransport?.sendResponse(id, null);
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
      id: `xml-${filepath}-${d.range.start.line}-${d.range.start.character}-${index}`,
      file: filepath,
      fileName,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      severity: severityMap[d.severity || 1] || 'error',
      source: d.source || 'lemminx',
      code: d.code?.toString(),
    };
  });

  setSourceProblemsForFile({
    source: 'xml',
    generation: xmlSessionGeneration,
    filePath: filepath,
    problems,
  });
}

/**
 * Notify the server that a document was opened
 */
export async function notifyDocumentOpened(filepath: string, content: string): Promise<void> {
  if (!isXmlFile(filepath)) return;
  if (!projectStore.rootPath) return;

  await initializeServer();

  // Don't reopen if already open and content is the same
  const existing = openDocuments.get(filepath);
  if (existing && existing.content === content) return;

  if (!xmlServerTransport || !xmlServerInitialized) return;

  const uri = pathToUri(filepath);
  const languageId = getLanguageId(filepath);

  // Track document
  openDocuments.set(filepath, { version: existing ? existing.version + 1 : 1, content });

  if (existing) {
    // If it's already open but content changed, send didChange instead
    await xmlServerTransport.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: existing.version + 1
      },
      contentChanges: [{ text: content }]
    });
    return;
  }

  // Send didOpen notification
  await xmlServerTransport.sendNotification('textDocument/didOpen', {
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
  if (!isXmlFile(filepath)) return;
  if (!xmlServerTransport || !xmlServerInitialized) return;

  const doc = openDocuments.get(filepath);
  if (!doc) {
    await notifyDocumentOpened(filepath, content);
    return;
  }

  doc.version++;
  doc.content = content;

  const uri = pathToUri(filepath);

  const existingTimer = diagnosticDebounceTimers.get(filepath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  diagnosticDebounceTimers.set(
    filepath,
    setTimeout(async () => {
      diagnosticDebounceTimers.delete(filepath);

      if (!xmlServerTransport || !xmlServerInitialized) return;

      await xmlServerTransport.sendNotification('textDocument/didChange', {
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
  if (!isXmlFile(filepath)) return;
  if (!xmlServerTransport || !xmlServerInitialized) return;

  openDocuments.delete(filepath);

  const timer = diagnosticDebounceTimers.get(filepath);
  if (timer) {
    clearTimeout(timer);
    diagnosticDebounceTimers.delete(filepath);
  }

  const uri = pathToUri(filepath);
  await xmlServerTransport.sendNotification('textDocument/didClose', {
    textDocument: { uri },
  });

  clearSourceProblemsForFile({
    source: 'xml',
    generation: xmlSessionGeneration,
    filePath: filepath,
  });
}

export async function notifyDocumentSaved(filepath: string, content: string): Promise<void> {
  if (!isXmlFile(filepath)) return;
  await sendDidSaveForTrackedDocument({
    filepath,
    content,
    openDocuments,
    transport: xmlServerTransport,
    initialized: xmlServerInitialized,
    ensureOpen: notifyDocumentOpened,
    pathToUri,
  });
}

/**
 * Get hover information
 */
export async function getHover(filepath: string, line: number, character: number): Promise<unknown> {
  if (!xmlServerTransport || !xmlServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    return await xmlServerTransport.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });
  } catch (error) {
    console.error('[XML LSP] Hover error:', error);
    return null;
  }
}

/**
 * Get completions
 */
export async function getCompletions(filepath: string, line: number, character: number): Promise<unknown> {
  if (!xmlServerTransport || !xmlServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    return await xmlServerTransport.sendRequest('textDocument/completion', {
      textDocument: { uri },
      position: { line, character },
    });
  } catch (error) {
    console.error('[XML LSP] Completion error:', error);
    return null;
  }
}

/**
 * Format document
 */
export async function formatDocument(filepath: string): Promise<unknown> {
  if (!xmlServerTransport || !xmlServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    return await xmlServerTransport.sendRequest('textDocument/formatting', {
      textDocument: { uri },
      options: {
        tabSize: 2,
        insertSpaces: true,
      },
    });
  } catch (error) {
    console.error('[XML LSP] Format error:', error);
    return null;
  }
}

/**
 * Rename symbol
 */
export async function renameSymbol(filepath: string, line: number, character: number, newName: string): Promise<unknown> {
  if (!xmlServerTransport || !xmlServerInitialized) return null;

  const uri = pathToUri(filepath);

  try {
    return await xmlServerTransport.sendRequest('textDocument/rename', {
      textDocument: { uri },
      position: { line, character },
      newName,
    });
  } catch (error) {
    console.error('[XML LSP] Rename error:', error);
    return null;
  }
}

/**
 * Stop the XML LSP server
 */
async function recoverXmlLspAfterExit(): Promise<void> {
  if (!projectStore.rootPath || xmlServerTransport) {
    return;
  }

  const initialized = await initializeServer();
  if (!initialized) {
    throw new Error('XML LSP restart failed');
  }
}

export async function stopXmlLsp(): Promise<void> {
  if (!xmlServerTransport) return;

  try {
    for (const timer of diagnosticDebounceTimers.values()) {
      clearTimeout(timer);
    }
    diagnosticDebounceTimers.clear();

    await xmlServerTransport.sendRequest('shutdown', null);
    await xmlServerTransport.sendNotification('exit', null);
  } catch (error) {
    console.error('[XML LSP] Shutdown error:', error);
  } finally {
    const registry = getLspRegistry();
    void registry.stopServer('xml');
    xmlServerTransport = null;
    xmlServerInitialized = false;
    openDocuments.clear();
    xmlSessionGeneration = markSourceSessionStale('xml');
    xmlRecovery.reset();
  }
}
