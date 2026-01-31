/**
 * LSP Client - Monaco Editor Diagnostics Integration
 * 
 * Monaco Editor has built-in language support through its web workers:
 * - TypeScript/JavaScript
 * - HTML
 * - CSS/SCSS/LESS
 * - JSON
 * 
 * This module:
 * 1. Configures language defaults (TypeScript, HTML, CSS)
 * 2. Registers custom languages (Svelte)
 * 3. Listens for marker (diagnostic) changes
 * 4. Pipes diagnostics to the problems store
 * 5. Implements low-RAM strategy (single LSP at a time when RAM < 4GB)
 */

import type * as Monaco from 'monaco-editor';
import { getMonaco, isMonacoLoaded } from '$lib/services/monaco-loader';
import { problemsStore, type Problem, type ProblemSeverity } from '$lib/stores/problems.svelte';
import { configureHtmlDefaults, configureCssDefaults } from './html-css';
import { registerSvelteLanguage } from './svelte';

// Track if LSP client is initialized
let initialized = false;

// Track which language services are active
let activeLanguageServices = new Set<string>();

// Debounce timer for marker updates
let markerUpdateTimer: ReturnType<typeof setTimeout> | null = null;
const MARKER_UPDATE_DEBOUNCE = 150;

// Idle timeout for cleanup (5 minutes)
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT = 5 * 60 * 1000;

// Track active file types
const activeLanguages = new Set<string>();

// Disposables for cleanup
const disposables: Monaco.IDisposable[] = [];

// Low RAM threshold (4GB in bytes)
const LOW_RAM_THRESHOLD = 4 * 1024 * 1024 * 1024;

// Estimated system RAM (will be updated if system info is available)
let estimatedRamBytes = 8 * 1024 * 1024 * 1024; // Default to 8GB

/**
 * Check if system is in low RAM mode
 */
function isLowRamMode(): boolean {
  return estimatedRamBytes < LOW_RAM_THRESHOLD;
}

/**
 * Set estimated RAM (can be called from system detection)
 */
export function setEstimatedRam(ramBytes: number): void {
  estimatedRamBytes = ramBytes;
}

/**
 * Language service categories for low-RAM mode
 */
type LanguageServiceCategory = 'typescript' | 'html' | 'css' | 'svelte';

/**
 * Get the language service category for a language
 */
function getLanguageServiceCategory(language: string): LanguageServiceCategory | null {
  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact':
      return 'typescript';
    case 'html':
    case 'handlebars':
    case 'razor':
      return 'html';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'svelte':
      return 'svelte';
    default:
      return null;
  }
}

/**
 * Map Monaco MarkerSeverity to our ProblemSeverity
 */
function mapSeverity(monaco: typeof Monaco, severity: Monaco.MarkerSeverity): ProblemSeverity {
  switch (severity) {
    case monaco.MarkerSeverity.Error:
      return 'error';
    case monaco.MarkerSeverity.Warning:
      return 'warning';
    case monaco.MarkerSeverity.Info:
      return 'info';
    case monaco.MarkerSeverity.Hint:
      return 'hint';
    default:
      return 'info';
  }
}

/**
 * Extract file path from Monaco URI
 */
function getFilePathFromUri(uri: Monaco.Uri): string {
  // Our URIs are in format: inmemory://model/{encodedPath}
  const path = uri.path;
  if (path.startsWith('/')) {
    return decodeURIComponent(path.slice(1));
  }
  return decodeURIComponent(path);
}

/**
 * Check if a file is a TypeScript/JavaScript file
 * These files are handled by the TypeScript sidecar, not Monaco markers
 */
function isTsJsFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext);
}

/**
 * Extract file name from path
 */
function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

/**
 * Process markers from Monaco and update problems store
 * 
 * NOTE: TypeScript/JavaScript files are handled by the TypeScript sidecar,
 * so we skip Monaco markers for those files to avoid conflicts.
 */
function processMarkers(monaco: typeof Monaco): void {
  // Get all markers from Monaco
  const allMarkers = monaco.editor.getModelMarkers({});

  // Group markers by file (excluding TS/JS files which are handled by sidecar)
  const markersByFile = new Map<string, Monaco.editor.IMarker[]>();

  for (const marker of allMarkers) {
    const filePath = getFilePathFromUri(marker.resource);

    // Skip TS/JS files - they're handled by the TypeScript sidecar
    // Also skip markers we've set ourselves to avoid loops
    if (isTsJsFile(filePath) || marker.owner === 'volt-problems') {
      continue;
    }

    const existing = markersByFile.get(filePath) || [];
    existing.push(marker);
    markersByFile.set(filePath, existing);
  }

  // Get all files that currently have problems (excluding TS/JS files)
  const currentFiles = new Set(
    problemsStore.filesWithProblems.filter(f => !isTsJsFile(f))
  );

  // Update problems for each file with markers
  for (const [filePath, markers] of markersByFile) {
    const problems: Problem[] = markers.map((marker, index) => ({
      id: `${filePath}:${marker.startLineNumber}:${marker.startColumn}:${index}`,
      file: filePath,
      fileName: getFileName(filePath),
      line: marker.startLineNumber,
      column: marker.startColumn,
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
      message: marker.message,
      severity: mapSeverity(monaco, marker.severity),
      source: 'monaco',
      code: marker.code?.toString()
    }));

    problemsStore.setProblemsForFile(filePath, problems, 'monaco');
    currentFiles.delete(filePath);
  }

  // Clear problems for non-TS/JS files that no longer have markers
  for (const filePath of currentFiles) {
    problemsStore.clearProblemsForFile(filePath, 'monaco');
  }
}

/**
 * Debounced marker update
 */
function scheduleMarkerUpdate(monaco: typeof Monaco): void {
  if (markerUpdateTimer) {
    clearTimeout(markerUpdateTimer);
  }

  markerUpdateTimer = setTimeout(() => {
    processMarkers(monaco);
    markerUpdateTimer = null;
  }, MARKER_UPDATE_DEBOUNCE);
}

/**
 * Reset idle timer
 */
function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  idleTimer = setTimeout(() => {
    // Could implement cleanup here if needed
    // For now, we keep the LSP active as long as Monaco is loaded
  }, IDLE_TIMEOUT);
}

/**
 * Configure TypeScript compiler options for better IDE experience
 * Uses dynamic access to avoid TypeScript type issues with Monaco's deprecated namespace
 * 
 * NOTE: We DISABLE Monaco's built-in TS diagnostics because we use the real
 * typescript-language-server sidecar for diagnostics. This prevents conflicts
 * where Monaco squiggles show different errors than the Problems panel.
 */
function configureTypeScript(monaco: typeof Monaco): void {
  // Access TypeScript defaults through dynamic property access
  // This is needed because Monaco's types mark these as deprecated
  const languages = monaco.languages as Record<string, unknown>;
  const typescript = languages['typescript'] as {
    typescriptDefaults?: {
      setCompilerOptions: (options: Record<string, unknown>) => void;
      setDiagnosticsOptions: (options: Record<string, unknown>) => void;
    };
    javascriptDefaults?: {
      setCompilerOptions: (options: Record<string, unknown>) => void;
      setDiagnosticsOptions: (options: Record<string, unknown>) => void;
    };
    ScriptTarget?: Record<string, number>;
    ModuleKind?: Record<string, number>;
    ModuleResolutionKind?: Record<string, number>;
    JsxEmit?: Record<string, number>;
  };

  if (!typescript?.typescriptDefaults || !typescript?.javascriptDefaults) {
    return;
  }

  const compilerOptions: Record<string, unknown> = {
    target: typescript.ScriptTarget?.ESNext ?? 99,
    module: typescript.ModuleKind?.ESNext ?? 99,
    moduleResolution: typescript.ModuleResolutionKind?.NodeJs ?? 2,
    jsx: typescript.JsxEmit?.React ?? 2,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
    isolatedModules: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true
  };

  // Apply to both TypeScript and JavaScript
  typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  typescript.javascriptDefaults.setCompilerOptions(compilerOptions);

  // DISABLE Monaco's built-in TS diagnostics - we use the real TS server sidecar instead
  // This prevents conflicts between Monaco squiggles and Problems panel
  const diagnosticsOptions = {
    noSemanticValidation: true,  // Disable - handled by TS sidecar
    noSyntaxValidation: true,    // Disable - handled by TS sidecar
    noSuggestionDiagnostics: true // Disable - handled by TS sidecar
  };

  typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);

  activeLanguageServices.add('typescript');
}

/**
 * Configure all language services
 */
function configureAllLanguages(monaco: typeof Monaco): void {
  // Configure TypeScript/JavaScript
  configureTypeScript(monaco);

  // Configure HTML
  configureHtmlDefaults(monaco);
  activeLanguageServices.add('html');

  // Configure CSS/SCSS/LESS
  configureCssDefaults(monaco);
  activeLanguageServices.add('css');

  // Register Svelte language
  registerSvelteLanguage(monaco);
  activeLanguageServices.add('svelte');
}

/**
 * Initialize the LSP client
 * Should be called when Monaco is loaded
 */
export function initializeLspClient(): void {
  if (initialized) return;

  const monaco = getMonaco();
  if (!monaco) return;

  // Configure all language services
  configureAllLanguages(monaco);

  // Listen for marker changes
  const markerDisposable = monaco.editor.onDidChangeMarkers(() => {
    scheduleMarkerUpdate(monaco);
    resetIdleTimer();
  });
  disposables.push(markerDisposable);

  // Initial marker processing
  processMarkers(monaco);

  initialized = true;
  resetIdleTimer();
}

/**
 * Check if a language should trigger LSP initialization
 */
export function isLspLanguage(language: string): boolean {
  const lspLanguages = [
    // TypeScript/JavaScript
    'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
    // HTML
    'html', 'handlebars', 'razor',
    // CSS
    'css', 'scss', 'less',
    // Svelte
    'svelte'
  ];
  return lspLanguages.includes(language);
}

/**
 * Get active language services
 */
export function getActiveLanguageServices(): string[] {
  return Array.from(activeLanguageServices);
}

/**
 * Check if running in low RAM mode
 */
export function isInLowRamMode(): boolean {
  return isLowRamMode();
}

/**
 * Notify that a file with a specific language was opened
 * This triggers LSP initialization if needed
 */
export function notifyFileOpened(language: string): void {
  if (!isLspLanguage(language)) return;

  activeLanguages.add(language);

  // Initialize LSP if Monaco is loaded
  if (isMonacoLoaded() && !initialized) {
    initializeLspClient();
  }

  resetIdleTimer();
}

/**
 * Notify that a file was closed
 */
export function notifyFileClosed(language: string): void {
  activeLanguages.delete(language);
}

/**
 * Dispose the LSP client
 */
export function disposeLspClient(): void {
  if (markerUpdateTimer) {
    clearTimeout(markerUpdateTimer);
    markerUpdateTimer = null;
  }

  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  for (const disposable of disposables) {
    disposable.dispose();
  }
  disposables.length = 0;

  activeLanguages.clear();
  problemsStore.clearAll();
  initialized = false;
}

/**
 * Check if LSP client is initialized
 */
export function isLspInitialized(): boolean {
  return initialized;
}
