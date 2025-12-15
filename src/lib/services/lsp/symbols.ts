// Symbol Search Service
//
// Provides symbol navigation using LSP:
// - textDocument/documentSymbol - symbols in current file
// - workspace/symbol - symbols across workspace
//
// Supports TypeScript/JavaScript and Svelte files.

import { getLspRegistry, type LspTransport } from './sidecar';
import { ensureTsLspStarted, isTsJsFile, isTsLspConnected } from './typescript-sidecar';
import { ensureSvelteLspStarted, isSvelteFile, isSvelteLspConnected } from './svelte-sidecar';
import { projectStore } from '$lib/stores/project.svelte';

// LSP Symbol Kinds (from LSP spec)
export enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

// Symbol kind display names
export const symbolKindNames: Record<number, string> = {
  [SymbolKind.File]: 'File',
  [SymbolKind.Module]: 'Module',
  [SymbolKind.Namespace]: 'Namespace',
  [SymbolKind.Package]: 'Package',
  [SymbolKind.Class]: 'Class',
  [SymbolKind.Method]: 'Method',
  [SymbolKind.Property]: 'Property',
  [SymbolKind.Field]: 'Field',
  [SymbolKind.Constructor]: 'Constructor',
  [SymbolKind.Enum]: 'Enum',
  [SymbolKind.Interface]: 'Interface',
  [SymbolKind.Function]: 'Function',
  [SymbolKind.Variable]: 'Variable',
  [SymbolKind.Constant]: 'Constant',
  [SymbolKind.String]: 'String',
  [SymbolKind.Number]: 'Number',
  [SymbolKind.Boolean]: 'Boolean',
  [SymbolKind.Array]: 'Array',
  [SymbolKind.Object]: 'Object',
  [SymbolKind.Key]: 'Key',
  [SymbolKind.Null]: 'Null',
  [SymbolKind.EnumMember]: 'Enum Member',
  [SymbolKind.Struct]: 'Struct',
  [SymbolKind.Event]: 'Event',
  [SymbolKind.Operator]: 'Operator',
  [SymbolKind.TypeParameter]: 'Type Parameter',
};

// Symbol kind icons (using emoji for simplicity)
export const symbolKindIcons: Record<number, string> = {
  [SymbolKind.File]: '📄',
  [SymbolKind.Module]: '📦',
  [SymbolKind.Namespace]: '📁',
  [SymbolKind.Package]: '📦',
  [SymbolKind.Class]: '🔷',
  [SymbolKind.Method]: '🔹',
  [SymbolKind.Property]: '🔸',
  [SymbolKind.Field]: '🔸',
  [SymbolKind.Constructor]: '🔧',
  [SymbolKind.Enum]: '📋',
  [SymbolKind.Interface]: '🔶',
  [SymbolKind.Function]: '⚡',
  [SymbolKind.Variable]: '📝',
  [SymbolKind.Constant]: '🔒',
  [SymbolKind.String]: '📜',
  [SymbolKind.Number]: '🔢',
  [SymbolKind.Boolean]: '✓',
  [SymbolKind.Array]: '📚',
  [SymbolKind.Object]: '📦',
  [SymbolKind.Key]: '🔑',
  [SymbolKind.Null]: '∅',
  [SymbolKind.EnumMember]: '📋',
  [SymbolKind.Struct]: '🏗️',
  [SymbolKind.Event]: '⚡',
  [SymbolKind.Operator]: '➕',
  [SymbolKind.TypeParameter]: '🔤',
};

/** LSP Position */
interface LspPosition {
  line: number;
  character: number;
}

/** LSP Range */
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** LSP Location */
interface LspLocation {
  uri: string;
  range: LspRange;
}

/** LSP DocumentSymbol (hierarchical) */
interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  deprecated?: boolean;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

/** LSP SymbolInformation (flat) */
interface LspSymbolInformation {
  name: string;
  kind: number;
  tags?: number[];
  deprecated?: boolean;
  location: LspLocation;
  containerName?: string;
}

/** Unified symbol representation for UI */
export interface Symbol {
  /** Symbol name */
  name: string;
  /** Symbol kind (function, class, etc.) */
  kind: SymbolKind;
  /** Kind display name */
  kindName: string;
  /** Kind icon */
  icon: string;
  /** Container path (e.g., "MyClass.myMethod") */
  containerPath: string;
  /** File path */
  filePath: string;
  /** File name for display */
  fileName: string;
  /** Start line (1-based for Monaco) */
  line: number;
  /** Start column (1-based for Monaco) */
  column: number;
  /** End line (1-based for Monaco) */
  endLine: number;
  /** End column (1-based for Monaco) */
  endColumn: number;
  /** Whether the symbol is deprecated */
  deprecated: boolean;
  /** Optional detail string */
  detail?: string;
}

/** Request cancellation token */
interface CancellationToken {
  cancelled: boolean;
}

// Track active requests for cancellation
let activeDocumentSymbolRequest: CancellationToken | null = null;
let activeWorkspaceSymbolRequest: CancellationToken | null = null;

// Debounce timers
let documentSymbolDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let workspaceSymbolDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 150;

/**
 * Convert file path to URI
 */
function pathToUri(filepath: string): string {
  const normalizedPath = filepath.replace(/\\/g, '/');
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
  if (path.match(/^\/[a-zA-Z]:/)) {
    path = path.slice(1);
  }
  return path.replace(/\\/g, '/');
}

/**
 * Get file name from path
 */
function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

/**
 * Get the appropriate LSP transport for a file
 */
function getTransportForFile(filepath: string): LspTransport | null {
  const registry = getLspRegistry();
  
  if (isTsJsFile(filepath)) {
    return registry.getTransport('typescript-main') ?? null;
  }
  
  if (isSvelteFile(filepath)) {
    return registry.getTransport('svelte-main') ?? null;
  }
  
  return null;
}

/**
 * Check if language services are available for a file type
 */
export function isSymbolSearchAvailable(filepath: string): boolean {
  if (isTsJsFile(filepath)) {
    return isTsLspConnected();
  }
  if (isSvelteFile(filepath)) {
    return isSvelteLspConnected();
  }
  return false;
}

/**
 * Check if workspace symbol search is available
 */
export function isWorkspaceSymbolSearchAvailable(): boolean {
  return isTsLspConnected() || isSvelteLspConnected();
}

/**
 * Flatten hierarchical DocumentSymbol[] to flat Symbol[]
 */
function flattenDocumentSymbols(
  symbols: LspDocumentSymbol[],
  filePath: string,
  parentPath = ''
): Symbol[] {
  const result: Symbol[] = [];
  const fileName = getFileName(filePath);
  
  for (const sym of symbols) {
    const containerPath = parentPath ? `${parentPath}.${sym.name}` : sym.name;
    
    result.push({
      name: sym.name,
      kind: sym.kind as SymbolKind,
      kindName: symbolKindNames[sym.kind] || 'Unknown',
      icon: symbolKindIcons[sym.kind] || '❓',
      containerPath: parentPath,
      filePath,
      fileName,
      // LSP is 0-based, Monaco is 1-based
      line: sym.selectionRange.start.line + 1,
      column: sym.selectionRange.start.character + 1,
      endLine: sym.selectionRange.end.line + 1,
      endColumn: sym.selectionRange.end.character + 1,
      deprecated: sym.deprecated ?? (sym.tags?.includes(1) ?? false),
      detail: sym.detail,
    });
    
    // Recursively flatten children
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenDocumentSymbols(sym.children, filePath, containerPath));
    }
  }
  
  return result;
}

/**
 * Convert SymbolInformation[] to Symbol[]
 */
function convertSymbolInformation(
  symbols: LspSymbolInformation[]
): Symbol[] {
  return symbols.map(sym => {
    const filePath = uriToPath(sym.location.uri);
    return {
      name: sym.name,
      kind: sym.kind as SymbolKind,
      kindName: symbolKindNames[sym.kind] || 'Unknown',
      icon: symbolKindIcons[sym.kind] || '❓',
      containerPath: sym.containerName || '',
      filePath,
      fileName: getFileName(filePath),
      line: sym.location.range.start.line + 1,
      column: sym.location.range.start.character + 1,
      endLine: sym.location.range.end.line + 1,
      endColumn: sym.location.range.end.character + 1,
      deprecated: sym.deprecated ?? (sym.tags?.includes(1) ?? false),
    };
  });
}

/**
 * Check if result is DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat)
 */
function isDocumentSymbolArray(
  result: LspDocumentSymbol[] | LspSymbolInformation[]
): result is LspDocumentSymbol[] {
  if (result.length === 0) return true;
  // DocumentSymbol has 'range' and 'selectionRange', SymbolInformation has 'location'
  return 'range' in result[0] && 'selectionRange' in result[0];
}

/**
 * Get document symbols for a file (Go to Symbol in File)
 * 
 * @param filepath - The file path to get symbols for
 * @returns Promise resolving to symbols or null if unavailable
 */
export async function getDocumentSymbols(filepath: string): Promise<Symbol[] | null> {
  // Cancel any previous request
  if (activeDocumentSymbolRequest) {
    activeDocumentSymbolRequest.cancelled = true;
  }
  
  const cancellationToken: CancellationToken = { cancelled: false };
  activeDocumentSymbolRequest = cancellationToken;
  
  // Ensure the right language server is running for this file type.
  if (isTsJsFile(filepath) && !isTsLspConnected()) {
    await ensureTsLspStarted();
  } else if (isSvelteFile(filepath) && !isSvelteLspConnected()) {
    await ensureSvelteLspStarted();
  }

  const transport = getTransportForFile(filepath);
  if (!transport || !transport.connected) {
    return null;
  }
  
  const uri = pathToUri(filepath);
  
  try {
    const result = await transport.sendRequest<LspDocumentSymbol[] | LspSymbolInformation[] | null>(
      'textDocument/documentSymbol',
      {
        textDocument: { uri }
      }
    );
    
    // Check if cancelled
    if (cancellationToken.cancelled) {
      return null;
    }
    
    if (!result || result.length === 0) {
      return [];
    }
    
    // Handle both response types
    if (isDocumentSymbolArray(result)) {
      return flattenDocumentSymbols(result, filepath);
    } else {
      return convertSymbolInformation(result);
    }
  } catch (error) {
    console.error('[Symbol Search] Document symbol error:', error);
    return null;
  } finally {
    if (activeDocumentSymbolRequest === cancellationToken) {
      activeDocumentSymbolRequest = null;
    }
  }
}

/**
 * Get document symbols with debouncing
 */
export function getDocumentSymbolsDebounced(
  filepath: string,
  callback: (symbols: Symbol[] | null) => void
): void {
  // Clear existing timer
  if (documentSymbolDebounceTimer) {
    clearTimeout(documentSymbolDebounceTimer);
  }
  
  documentSymbolDebounceTimer = setTimeout(async () => {
    documentSymbolDebounceTimer = null;
    const symbols = await getDocumentSymbols(filepath);
    callback(symbols);
  }, DEBOUNCE_MS);
}

/**
 * Get workspace symbols matching a query (Go to Symbol in Workspace)
 * 
 * @param query - Search query
 * @returns Promise resolving to symbols or null if unavailable
 */
export async function getWorkspaceSymbols(query: string): Promise<Symbol[] | null> {
  // Cancel any previous request
  if (activeWorkspaceSymbolRequest) {
    activeWorkspaceSymbolRequest.cancelled = true;
  }
  
  const cancellationToken: CancellationToken = { cancelled: false };
  activeWorkspaceSymbolRequest = cancellationToken;
  
  if (!projectStore.rootPath) {
    return null;
  }

  // Workspace symbol search should be able to bootstrap language services.
  if (!isTsLspConnected()) {
    await ensureTsLspStarted();
  }
  if (!isSvelteLspConnected()) {
    await ensureSvelteLspStarted();
  }
  
  const registry = getLspRegistry();
  const results: Symbol[] = [];
  
  // Query TypeScript LSP
  const tsTransport = registry.getTransport('typescript-main');
  if (tsTransport?.connected) {
    try {
      const tsResult = await tsTransport.sendRequest<LspSymbolInformation[] | null>(
        'workspace/symbol',
        { query }
      );
      
      if (cancellationToken.cancelled) {
        return null;
      }
      
      if (tsResult && tsResult.length > 0) {
        results.push(...convertSymbolInformation(tsResult));
      }
    } catch (error) {
      console.error('[Symbol Search] TypeScript workspace symbol error:', error);
    }
  }
  
  // Query Svelte LSP
  const svelteTransport = registry.getTransport('svelte-main');
  if (svelteTransport?.connected) {
    try {
      const svelteResult = await svelteTransport.sendRequest<LspSymbolInformation[] | null>(
        'workspace/symbol',
        { query }
      );
      
      if (cancellationToken.cancelled) {
        return null;
      }
      
      if (svelteResult && svelteResult.length > 0) {
        results.push(...convertSymbolInformation(svelteResult));
      }
    } catch (error) {
      console.error('[Symbol Search] Svelte workspace symbol error:', error);
    }
  }
  
  // Check if cancelled
  if (cancellationToken.cancelled) {
    return null;
  }
  
  // Sort results by name
  results.sort((a, b) => a.name.localeCompare(b.name));
  
  return results;
}

/**
 * Get workspace symbols with debouncing
 */
export function getWorkspaceSymbolsDebounced(
  query: string,
  callback: (symbols: Symbol[] | null) => void
): void {
  // Clear existing timer
  if (workspaceSymbolDebounceTimer) {
    clearTimeout(workspaceSymbolDebounceTimer);
  }
  
  workspaceSymbolDebounceTimer = setTimeout(async () => {
    workspaceSymbolDebounceTimer = null;
    const symbols = await getWorkspaceSymbols(query);
    callback(symbols);
  }, DEBOUNCE_MS);
}

/**
 * Cancel any pending symbol requests
 */
export function cancelSymbolRequests(): void {
  if (activeDocumentSymbolRequest) {
    activeDocumentSymbolRequest.cancelled = true;
    activeDocumentSymbolRequest = null;
  }
  if (activeWorkspaceSymbolRequest) {
    activeWorkspaceSymbolRequest.cancelled = true;
    activeWorkspaceSymbolRequest = null;
  }
  if (documentSymbolDebounceTimer) {
    clearTimeout(documentSymbolDebounceTimer);
    documentSymbolDebounceTimer = null;
  }
  if (workspaceSymbolDebounceTimer) {
    clearTimeout(workspaceSymbolDebounceTimer);
    workspaceSymbolDebounceTimer = null;
  }
}

/**
 * Simple fuzzy match score
 */
export function fuzzyMatchScore(query: string, text: string): number {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  
  // Exact match
  if (textLower === queryLower) return 1000;
  
  // Starts with
  if (textLower.startsWith(queryLower)) return 500 + (queryLower.length / textLower.length) * 100;
  
  // Contains
  if (textLower.includes(queryLower)) return 200 + (queryLower.length / textLower.length) * 100;
  
  // Fuzzy character matching
  let queryIndex = 0;
  let score = 0;
  let consecutiveBonus = 0;
  
  for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
    if (textLower[i] === queryLower[queryIndex]) {
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5;
      queryIndex++;
    } else {
      consecutiveBonus = 0;
    }
  }
  
  // All query characters must be found
  if (queryIndex < queryLower.length) return -1;
  
  return score;
}

/**
 * Filter and sort symbols by query
 */
export function filterSymbols(symbols: Symbol[], query: string): Symbol[] {
  if (!query.trim()) {
    return symbols;
  }
  
  const scored = symbols
    .map(sym => ({
      symbol: sym,
      score: Math.max(
        fuzzyMatchScore(query, sym.name),
        fuzzyMatchScore(query, sym.containerPath ? `${sym.containerPath}.${sym.name}` : sym.name) * 0.8
      )
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  
  return scored.map(item => item.symbol);
}
