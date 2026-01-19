/**
 * LSP Tool Handlers - Expose Language Server capabilities to AI
 * 
 * These tools give the AI semantic code intelligence:
 * - lsp_go_to_definition: Jump to where a symbol is defined
 * - lsp_find_references: Find all usages of a symbol
 * - lsp_get_hover: Get type info and documentation
 * - lsp_rename_symbol: Safely rename a symbol across all files
 * 
 * SUPPORTED LANGUAGES:
 * - TypeScript/JavaScript (.ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs) - Full support
 * - Svelte (.svelte) - Definition, references, hover
 * - HTML (.html, .htm) - Definition, references, hover
 * - CSS/SCSS/LESS (.css, .scss, .sass, .less) - Definition, references, hover
 * - JSON (.json, .jsonc) - Hover only (schema info)
 * - Dart (.dart) - Full support (definition, references, hover, rename, code actions)
 * - YAML (.yaml, .yml, pubspec.yaml) - Hover, completions, formatting
 * - XML (.xml, .plist, AndroidManifest.xml, .xsd) - Hover, completions, formatting
 * - Tailwind CSS (hover for class utilities in any file)
 * 
 * ADVANTAGE over text search:
 * - Semantic understanding (knows imports, aliases, etc.)
 * - No false positives (won't match in strings/comments)
 * - Atomic operations (rename updates all correctly)
 */

import { invoke } from '@tauri-apps/api/core';
import { projectStore } from '$lib/stores/project.svelte';
import { resolvePath, extractErrorMessage, type ToolResult } from '../utils';

// TypeScript/JavaScript LSP
import {
  getDefinition as getTsDefinition,
  getReferences as getTsReferences,
  getHover as getTsHover,
  executeRename,
  prepareRename,
  isTsLspConnected,
  ensureTsLspStarted,
  notifyDocumentOpened as notifyTsDocumentOpened,
  isTsJsFile,
  type Location,
  type WorkspaceEdit
} from '$lib/services/lsp/typescript-sidecar';

// Svelte LSP
import {
  isSvelteFile,
  isSvelteLspConnected,
  ensureSvelteLspStarted,
  getSvelteDefinition,
  getSvelteReferences,
  getSvelteHover,
  notifySvelteDocumentOpened
} from '$lib/services/lsp/svelte-sidecar';

// HTML LSP
import {
  isHtmlFile,
  isHtmlLspConnected,
  ensureHtmlLspStarted,
  getHtmlDefinition,
  getHtmlReferences,
  getHtmlHover,
  notifyHtmlDocumentOpened
} from '$lib/services/lsp/html-sidecar';

// CSS LSP
import {
  isCssFile,
  isCssLspConnected,
  ensureCssLspStarted,
  getCssDefinition,
  getCssReferences,
  getCssHover,
  notifyCssDocumentOpened
} from '$lib/services/lsp/css-sidecar';

// JSON LSP
import {
  isJsonFile,
  isJsonLspConnected,
  ensureJsonLspStarted,
  getJsonHover,
  notifyJsonDocumentOpened
} from '$lib/services/lsp/json-sidecar';

// Dart LSP
import {
  isDartFile,
  isDartLspRunning,
  goToDefinition as getDartDefinition,
  findReferences as getDartReferences,
  getHover as getDartHover,
  renameSymbol as renameDartSymbol,
  getCodeActions as getDartCodeActions,
  formatDocument as formatDartDocument,
  notifyDocumentOpened as notifyDartDocumentOpened,
  checkDartSdkAvailable
} from '$lib/services/lsp/dart-sidecar';

// ESLint LSP (code actions for linting fixes)
import {
  isEslintFile,
  getEslintCodeActions,
  executeEslintFixAll,
  notifyEslintDocumentOpened,
  type CodeAction,
  type WorkspaceEdit as EslintWorkspaceEdit,
  type TextEdit as EslintTextEdit
} from '$lib/services/lsp/eslint-sidecar';

// Tailwind LSP (hover only for CSS utilities)
import {
  isTailwindFile,
  isTailwindLspConnected,
  getTailwindHover,
  notifyTailwindDocumentOpened
} from '$lib/services/lsp/tailwind-sidecar';

// YAML LSP
import {
  isYamlFile,
  isYamlLspRunning,
  getHover as getYamlHover,
  getCompletions as getYamlCompletions,
  formatDocument as formatYamlDocument,
  notifyDocumentOpened as notifyYamlDocumentOpened
} from '$lib/services/lsp/yaml-sidecar';

// XML LSP (LemMinX)
import {
  isXmlFile,
  isXmlLspRunning,
  getHover as getXmlHover,
  getCompletions as getXmlCompletions,
  formatDocument as formatXmlDocument,
  notifyDocumentOpened as notifyXmlDocumentOpened
} from '$lib/services/lsp/xml-sidecar';

// Re-export Location type for other modules
export type { Location };

/**
 * Convert file path to URI (for LSP)
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
    return uri; // Return as is for package:, dart:, etc. relativePath and read_file will handle it
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
 * Normalize LSP location results to an array
 */
function normalizeLocations(result: any): Location[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    // Handle Location[] or LocationLink[]
    return result.map(loc => {
      if ('uri' in loc) return loc as Location;
      if ('targetUri' in loc) return { uri: (loc as any).targetUri, range: (loc as any).targetRange } as Location;
      return loc as Location;
    });
  }
  // Handle single Location
  return [result as Location];
}

/**
 * Execute a promise with a timeout
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timeoutId: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Ensure LSP is started for the given file type
 * Returns which LSP type is active
 */
type LspType = 'typescript' | 'svelte' | 'html' | 'css' | 'json' | 'dart' | 'tailwind' | 'yaml' | 'xml' | null;

async function ensureLspForFile(filepath: string): Promise<LspType> {
  // Priority: Svelte files use Svelte LSP
  if (isSvelteFile(filepath)) {
    if (!isSvelteLspConnected()) {
      await ensureSvelteLspStarted();
    }
    return isSvelteLspConnected() ? 'svelte' : null;
  }

  // TypeScript/JavaScript files use TS LSP
  if (isTsJsFile(filepath)) {
    if (!isTsLspConnected()) {
      await ensureTsLspStarted();
    }
    return isTsLspConnected() ? 'typescript' : null;
  }

  // Dart files use Dart LSP
  if (isDartFile(filepath)) {
    // Check if Dart SDK is available
    const dartAvailable = await checkDartSdkAvailable();
    if (!dartAvailable) {
      console.warn('[LSP] Dart SDK not found. Install Flutter or Dart SDK.');
      return null;
    }
    // Dart LSP starts on-demand when document is opened
    return 'dart';
  }

  // HTML files use HTML LSP
  if (isHtmlFile(filepath)) {
    if (!isHtmlLspConnected()) {
      await ensureHtmlLspStarted();
    }
    return isHtmlLspConnected() ? 'html' : null;
  }

  // CSS/SCSS/LESS files use CSS LSP
  if (isCssFile(filepath)) {
    if (!isCssLspConnected()) {
      await ensureCssLspStarted();
    }
    return isCssLspConnected() ? 'css' : null;
  }

  // JSON files use JSON LSP
  if (isJsonFile(filepath)) {
    if (!isJsonLspConnected()) {
      await ensureJsonLspStarted();
    }
    return isJsonLspConnected() ? 'json' : null;
  }

  // For hover on files with Tailwind classes (fallback)
  if (isTailwindFile(filepath)) {
    if (isTailwindLspConnected()) {
      return 'tailwind';
    }
  }

  // YAML files use YAML LSP
  if (isYamlFile(filepath)) {
    return isYamlLspRunning() ? 'yaml' : null;
  }

  // XML/plist files use XML LSP (LemMinX)
  if (isXmlFile(filepath)) {
    return isXmlLspRunning() ? 'xml' : null;
  }

  return null;
}

/**
 * Read file content and notify appropriate LSP
 */
async function ensureDocumentOpen(filepath: string, lspType: LspType): Promise<string | null> {
  try {
    const content = await invoke<string>('read_file', { path: filepath });

    if (lspType === 'typescript') {
      await notifyTsDocumentOpened(filepath, content);
    } else if (lspType === 'svelte') {
      await notifySvelteDocumentOpened(filepath, content);
    } else if (lspType === 'html') {
      await notifyHtmlDocumentOpened(filepath, content);
    } else if (lspType === 'css') {
      await notifyCssDocumentOpened(filepath, content);
    } else if (lspType === 'json') {
      await notifyJsonDocumentOpened(filepath, content);
    } else if (lspType === 'dart') {
      await notifyDartDocumentOpened(filepath, content);
    } else if (lspType === 'tailwind') {
      await notifyTailwindDocumentOpened(filepath, content);
    } else if (lspType === 'yaml') {
      await notifyYamlDocumentOpened(filepath, content);
    } else if (lspType === 'xml') {
      await notifyXmlDocumentOpened(filepath, content);
    }

    return content;
  } catch {
    return null;
  }
}

/**
 * Get definition using the appropriate LSP
 */
async function getDefinition(filepath: string, line: number, character: number, lspType: LspType): Promise<Location[] | null> {
  let result: any = null;
  if (lspType === 'typescript') {
    result = await getTsDefinition(filepath, line, character);
  } else if (lspType === 'svelte') {
    result = await getSvelteDefinition(filepath, line, character);
  } else if (lspType === 'html') {
    result = await getHtmlDefinition(filepath, line, character);
  } else if (lspType === 'css') {
    result = await getCssDefinition(filepath, line, character);
  } else if (lspType === 'dart') {
    result = await getDartDefinition(filepath, line, character);
  }
  return normalizeLocations(result);
}

/**
 * Get references using the appropriate LSP
 */
async function getReferences(filepath: string, line: number, character: number, includeDeclaration: boolean, lspType: LspType): Promise<Location[] | null> {
  let result: any = null;
  if (lspType === 'typescript') {
    result = await getTsReferences(filepath, line, character, includeDeclaration);
  } else if (lspType === 'svelte') {
    result = await getSvelteReferences(filepath, line, character, includeDeclaration);
  } else if (lspType === 'html') {
    result = await getHtmlReferences(filepath, line, character, includeDeclaration);
  } else if (lspType === 'css') {
    result = await getCssReferences(filepath, line, character, includeDeclaration);
  } else if (lspType === 'dart') {
    result = await getDartReferences(filepath, line, character);
  }
  return normalizeLocations(result);
}

/**
 * Get hover using the appropriate LSP
 */
async function getHover(filepath: string, line: number, character: number, lspType: LspType): Promise<HoverResult | null> {
  if (lspType === 'typescript') {
    return getTsHover(filepath, line, character);
  } else if (lspType === 'svelte') {
    return getSvelteHover(filepath, line, character);
  } else if (lspType === 'html') {
    return getHtmlHover(filepath, line, character) as Promise<HoverResult | null>;
  } else if (lspType === 'css') {
    return getCssHover(filepath, line, character) as Promise<HoverResult | null>;
  } else if (lspType === 'json') {
    return getJsonHover(filepath, line, character) as Promise<HoverResult | null>;
  } else if (lspType === 'dart') {
    const result = await getDartHover(filepath, line, character);
    return result as HoverResult | null;
  } else if (lspType === 'tailwind') {
    return getTailwindHover(filepath, line, character);
  } else if (lspType === 'yaml') {
    const result = await getYamlHover(filepath, line, character);
    return result as HoverResult | null;
  } else if (lspType === 'xml') {
    const result = await getXmlHover(filepath, line, character);
    return result as HoverResult | null;
  }
  return null;
}

// Hover result type
interface HoverResult {
  contents: string | { language?: string; value: string } | Array<string | { language?: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Get relative path from workspace root
 */
function getRelativePath(absolutePath: string): string {
  const root = projectStore.rootPath;
  if (!root) return absolutePath;
  const normalizedPath = absolutePath.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/');
  if (normalizedPath.startsWith(normalizedRoot)) {
    return normalizedPath.slice(normalizedRoot.length).replace(/^\//, '');
  }
  return absolutePath;
}

/**
 * Format location for AI output
 */
function formatLocation(loc: Location): string {
  const path = getRelativePath(uriToPath(loc.uri));
  const line = loc.range.start.line + 1; // LSP is 0-based
  const col = loc.range.start.character + 1;
  return `${path}:${line}:${col}`;
}

/**
 * Find a symbol in a file by name - returns the first occurrence's line and column
 * This allows AI to use symbol name instead of needing exact line/column
 */
async function findSymbolInFile(filepath: string, symbolName: string): Promise<{ line: number; column: number } | null> {
  try {
    const content = await invoke<string>('read_file', { path: filepath });
    const lines = content.split('\n');

    // Create regex that matches the symbol as a whole word
    // This avoids matching "userId" when searching for "user"
    const symbolRegex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);

    for (let i = 0; i < lines.length; i++) {
      const match = symbolRegex.exec(lines[i]);
      if (match) {
        return {
          line: i + 1, // 1-based
          column: match.index + 1 // 1-based
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// TOOL: lsp_go_to_definition
// ============================================================================

export async function handleLspGoToDefinition(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path ? String(args.path) : null;
  let line = typeof args.line === 'number' ? args.line : null;
  let column = typeof args.column === 'number' ? args.column : null;
  const symbol = args.symbol ? String(args.symbol) : null;

  if (!path) {
    return { success: false, error: 'path is required' };
  }

  const absolutePath = resolvePath(path);

  // If no line/column but symbol provided, try to find it in the file
  if ((line === null || column === null) && symbol) {
    const found = await findSymbolInFile(absolutePath, symbol);
    if (found) {
      line = found.line;
      column = found.column;
    } else {
      return {
        success: false,
        error: `Could not find symbol "${symbol}" in ${path}. Provide line and column, or check the symbol name.`
      };
    }
  }

  if (line === null || column === null) {
    return { success: false, error: 'Either (line + column) or symbol is required' };
  }

  // Ensure LSP is running
  const lspType = await ensureLspForFile(absolutePath);
  if (!lspType) {
    return { success: false, error: `LSP not available for ${path}. Supported extensions: .ts, .tsx, .js, .jsx, .svelte, .html, .css, .scss, .json, .dart, .yaml, .xml` };
  }

  // Ensure document is open in LSP
  await ensureDocumentOpen(absolutePath, lspType);

  // Get definition (LSP uses 0-based lines/columns)
  const definitions = await withTimeout(
    getDefinition(absolutePath, line - 1, column - 1, lspType),
    30000,
    'Definition lookup timed out. The language server may still be indexing the project.'
  );

  if (!definitions || definitions.length === 0) {
    return {
      success: true,
      output: symbol
        ? `No definition found for "${symbol}" at ${path}:${line}:${column}`
        : `No definition found at ${path}:${line}:${column}`
    };
  }

  // Format results
  const lines: string[] = [];
  lines.push(`Found ${definitions.length} definition${definitions.length > 1 ? 's' : ''}:`);
  lines.push('');

  for (const def of definitions) {
    const defPath = uriToPath(def.uri);
    const relativePath = getRelativePath(defPath);
    const defLine = def.range.start.line + 1;
    const defCol = def.range.start.character + 1;

    lines.push(`📍 ${relativePath}:${defLine}:${defCol}`);

    // Try to read the definition context (show 3 lines)
    try {
      const content = await invoke<string>('read_file', { path: defPath });
      const fileLines = content.split('\n');
      const startLine = Math.max(0, def.range.start.line - 1);
      const endLine = Math.min(fileLines.length - 1, def.range.start.line + 2);

      for (let i = startLine; i <= endLine; i++) {
        const lineNum = String(i + 1).padStart(4, ' ');
        const marker = i === def.range.start.line ? ' ◀──' : '';
        lines.push(`${lineNum} │ ${fileLines[i]}${marker}`);
      }
      lines.push('');
    } catch {
      // Skip context if file can't be read
    }
  }

  return { success: true, output: lines.join('\n') };
}

// ============================================================================
// TOOL: lsp_find_references
// ============================================================================

export async function handleLspFindReferences(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path ? String(args.path) : null;
  let line = typeof args.line === 'number' ? args.line : null;
  let column = typeof args.column === 'number' ? args.column : null;
  const symbol = args.symbol ? String(args.symbol) : null;
  const includeDeclaration = args.include_declaration !== false;

  if (!path) {
    return { success: false, error: 'path is required' };
  }

  const absolutePath = resolvePath(path);

  // If no line/column but symbol provided, try to find it in the file
  if ((line === null || column === null) && symbol) {
    const found = await findSymbolInFile(absolutePath, symbol);
    if (found) {
      line = found.line;
      column = found.column;
    } else {
      return {
        success: false,
        error: `Could not find symbol "${symbol}" in ${path}. Provide line and column, or check the symbol name.`
      };
    }
  }

  if (line === null || column === null) {
    return { success: false, error: 'Either (line + column) or symbol is required' };
  }

  // Ensure LSP is running
  const lspType = await ensureLspForFile(absolutePath);
  if (!lspType) {
    return { success: false, error: `LSP not available for ${path}. Supported extensions: .ts, .tsx, .js, .jsx, .svelte, .html, .css, .scss, .json, .dart, .yaml, .xml` };
  }

  // Ensure document is open in LSP
  await ensureDocumentOpen(absolutePath, lspType);

  // Get references (LSP uses 0-based)
  const references = await withTimeout(
    getReferences(absolutePath, line - 1, column - 1, includeDeclaration, lspType),
    30000,
    'References lookup timed out. Finding references in large projects can take time.'
  );

  if (!references || references.length === 0) {
    return {
      success: true,
      output: symbol
        ? `No references found for "${symbol}" at ${path}:${line}:${column}`
        : `No references found at ${path}:${line}:${column}`
    };
  }

  // Group by file
  const byFile = new Map<string, Location[]>();
  for (const ref of references) {
    const filePath = uriToPath(ref.uri);
    const existing = byFile.get(filePath) || [];
    existing.push(ref);
    byFile.set(filePath, existing);
  }

  // Format results
  const lines: string[] = [];
  lines.push(`Found ${references.length} reference${references.length > 1 ? 's' : ''} in ${byFile.size} file${byFile.size > 1 ? 's' : ''}:`);
  lines.push('');

  // Limit output to prevent context overflow
  let shownRefs = 0;
  const maxRefs = 30;

  for (const [filePath, refs] of byFile) {
    if (shownRefs >= maxRefs) {
      lines.push(`... and ${references.length - shownRefs} more references (use includePattern to narrow search)`);
      break;
    }

    const relativePath = getRelativePath(filePath);
    lines.push(`── ${relativePath} (${refs.length} reference${refs.length > 1 ? 's' : ''}) ──`);

    // Read file to show context
    let fileLines: string[] = [];
    try {
      const content = await invoke<string>('read_file', { path: filePath });
      fileLines = content.split('\n');
    } catch {
      // Continue without context
    }

    for (const ref of refs.slice(0, 5)) {
      if (shownRefs >= maxRefs) break;

      const refLine = ref.range.start.line + 1;
      const refCol = ref.range.start.character + 1;

      if (fileLines.length > 0 && ref.range.start.line < fileLines.length) {
        const lineContent = fileLines[ref.range.start.line];
        const truncated = lineContent.length > 100 ? lineContent.slice(0, 100) + '...' : lineContent;
        lines.push(`  ${String(refLine).padStart(4, ' ')}:${refCol} │ ${truncated}`);
      } else {
        lines.push(`  ${relativePath}:${refLine}:${refCol}`);
      }

      shownRefs++;
    }

    if (refs.length > 5) {
      const remaining = refs.length - 5;
      lines.push(`  ... +${remaining} more in this file`);
      shownRefs += remaining;
    }

    lines.push('');
  }

  return { success: true, output: lines.join('\n') };
}

// ============================================================================
// TOOL: lsp_get_hover
// ============================================================================

export async function handleLspGetHover(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path ? String(args.path) : null;
  let line = typeof args.line === 'number' ? args.line : null;
  let column = typeof args.column === 'number' ? args.column : null;
  const symbol = args.symbol ? String(args.symbol) : null;

  if (!path) {
    return { success: false, error: 'path is required' };
  }

  const absolutePath = resolvePath(path);

  // If no line/column but symbol provided, try to find it in the file
  if ((line === null || column === null) && symbol) {
    const found = await findSymbolInFile(absolutePath, symbol);
    if (found) {
      line = found.line;
      column = found.column;
    } else {
      return {
        success: false,
        error: `Could not find symbol "${symbol}" in ${path}. Provide line and column, or check the symbol name.`
      };
    }
  }

  if (line === null || column === null) {
    return { success: false, error: 'Either (line + column) or symbol is required' };
  }

  // Ensure LSP is running
  const lspType = await ensureLspForFile(absolutePath);
  if (!lspType) {
    return { success: false, error: `LSP not available for ${path}. Supported extensions: .ts, .tsx, .js, .jsx, .svelte, .html, .css, .scss, .json, .dart, .yaml, .xml` };
  }

  // Ensure document is open in LSP
  await ensureDocumentOpen(absolutePath, lspType);

  // Get hover info (LSP uses 0-based)
  const hover = await withTimeout(
    getHover(absolutePath, line - 1, column - 1, lspType),
    20000,
    'Hover lookup timed out'
  );

  if (!hover) {
    return { success: true, output: `No type information available at ${path}:${line}:${column}` };
  }

  // Extract hover content
  let content = '';
  if (typeof hover.contents === 'string') {
    content = hover.contents;
  } else if (Array.isArray(hover.contents)) {
    content = hover.contents.map(c => typeof c === 'string' ? c : c.value).join('\n\n');
  } else if (hover.contents && typeof hover.contents === 'object' && 'value' in hover.contents) {
    content = hover.contents.value;
  }

  if (!content) {
    return { success: true, output: `No type information available at ${path}:${line}:${column}` };
  }

  const lines: string[] = [];
  lines.push(`Type info at ${path}:${line}:${column}:`);
  lines.push('');
  lines.push(content);

  return { success: true, output: lines.join('\n') };
}

// ============================================================================
// TOOL: lsp_rename_symbol
// ============================================================================

export async function handleLspRenameSymbol(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path ? String(args.path) : null;
  let line = typeof args.line === 'number' ? args.line : null;
  let column = typeof args.column === 'number' ? args.column : null;
  const newName = args.new_name ? String(args.new_name) : null;
  const oldName = args.old_name ? String(args.old_name) : null;

  if (!path) {
    return { success: false, error: 'path is required' };
  }

  if (!newName) {
    return { success: false, error: 'new_name is required' };
  }

  const absolutePath = resolvePath(path);

  // If no line/column but old_name provided, try to find it in the file
  if ((line === null || column === null) && oldName) {
    const found = await findSymbolInFile(absolutePath, oldName);
    if (found) {
      line = found.line;
      column = found.column;
    } else {
      return {
        success: false,
        error: `Could not find symbol "${oldName}" in ${path}. Provide line and column, or check the symbol name.`
      };
    }
  }

  if (line === null || column === null) {
    return { success: false, error: 'Either (line + column) or old_name is required' };
  }

  // Ensure LSP is running (rename only supported for TypeScript/JavaScript and Dart)
  const lspType = await ensureLspForFile(absolutePath);
  if (!lspType) {
    return { success: false, error: `LSP not available for ${path}. Supported extensions: .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs, .dart` };
  }

  if (lspType !== 'typescript' && lspType !== 'dart') {
    return { success: false, error: `Rename is only supported for TypeScript/JavaScript and Dart files. Current file type uses ${lspType} LSP.` };
  }

  // Ensure document is open in LSP
  await ensureDocumentOpen(absolutePath, lspType);

  // For Dart, use Dart rename
  if (lspType === 'dart') {
    const workspaceEdit = await withTimeout(
      renameDartSymbol(absolutePath, line - 1, column - 1, newName),
      20000,
      'Rename operation timed out'
    );

    if (!workspaceEdit) {
      return { success: false, error: `Rename failed for symbol at ${path}:${line}:${column} → "${newName}"` };
    }

    // Apply the workspace edit (same format as TypeScript)
    const appliedFiles: string[] = [];
    const errors: string[] = [];
    const changes = (workspaceEdit as WorkspaceEdit).changes || {};

    for (const [uri, edits] of Object.entries(changes)) {
      const filePath = uriToPath(uri);
      try {
        const content = await invoke<string>('read_file', { path: filePath });
        const lines = content.split('\n');

        // Sort edits in reverse order (bottom to top) to preserve line numbers
        const sortedEdits = [...edits].sort((a, b) => {
          if (a.range.start.line !== b.range.start.line) {
            return b.range.start.line - a.range.start.line;
          }
          return b.range.start.character - a.range.start.character;
        });

        // Apply each edit
        for (const edit of sortedEdits) {
          const startLine = edit.range.start.line;
          const startChar = edit.range.start.character;
          const endLine = edit.range.end.line;
          const endChar = edit.range.end.character;

          if (startLine === endLine) {
            const lineContent = lines[startLine] || '';
            lines[startLine] = lineContent.slice(0, startChar) + edit.newText + lineContent.slice(endChar);
          } else {
            const startLineContent = lines[startLine] || '';
            const endLineContent = lines[endLine] || '';
            const newContent = startLineContent.slice(0, startChar) + edit.newText + endLineContent.slice(endChar);
            lines.splice(startLine, endLine - startLine + 1, newContent);
          }
        }

        const newContent = lines.join('\n');
        await invoke('write_file', { path: filePath, contents: newContent });
        appliedFiles.push(getRelativePath(filePath));
      } catch (e) {
        errors.push(`Failed to update ${filePath}: ${extractErrorMessage(e)}`);
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        error: `Partial rename completed with errors:\n${errors.join('\n')}`
      };
    }

    return {
      success: true,
      data: {
        renamedTo: newName,
        filesModified: appliedFiles.length,
        files: appliedFiles
      }
    };
  }

  // TypeScript rename flow
  // Check if rename is possible at this location
  const prepareResult = await prepareRename(absolutePath, line - 1, column - 1);
  if (!prepareResult) {
    return { success: false, error: `Cannot rename symbol at ${path}:${line}:${column}. Make sure cursor is on a renameable symbol.` };
  }

  const actualOldName = prepareResult.placeholder;

  // Execute rename
  const workspaceEdit = await withTimeout(
    executeRename(absolutePath, line - 1, column - 1, newName),
    20000,
    'Rename operation timed out'
  );

  if (!workspaceEdit) {
    return { success: false, error: `Rename failed for "${actualOldName}" → "${newName}"` };
  }

  // Apply the workspace edit
  const appliedFiles: string[] = [];
  const errors: string[] = [];

  // Handle both formats: changes and documentChanges
  const changes = workspaceEdit.changes || {};

  // Convert documentChanges to changes format if present
  if (workspaceEdit.documentChanges) {
    for (const docChange of workspaceEdit.documentChanges) {
      if ('textDocument' in docChange && 'edits' in docChange) {
        const uri = docChange.textDocument.uri;
        if (!changes[uri]) {
          changes[uri] = [];
        }
        changes[uri].push(...docChange.edits);
      }
    }
  }

  // Apply edits to each file
  for (const [uri, edits] of Object.entries(changes)) {
    const filePath = uriToPath(uri);

    try {
      // Read current content
      const content = await invoke<string>('read_file', { path: filePath });
      const lines = content.split('\n');

      // Sort edits in reverse order (bottom to top) to preserve line numbers
      const sortedEdits = [...edits].sort((a, b) => {
        if (a.range.start.line !== b.range.start.line) {
          return b.range.start.line - a.range.start.line;
        }
        return b.range.start.character - a.range.start.character;
      });

      // Apply each edit
      for (const edit of sortedEdits) {
        const startLine = edit.range.start.line;
        const startChar = edit.range.start.character;
        const endLine = edit.range.end.line;
        const endChar = edit.range.end.character;

        if (startLine === endLine) {
          // Single line edit
          const line = lines[startLine] || '';
          lines[startLine] = line.slice(0, startChar) + edit.newText + line.slice(endChar);
        } else {
          // Multi-line edit
          const startLineContent = lines[startLine] || '';
          const endLineContent = lines[endLine] || '';
          const newContent = startLineContent.slice(0, startChar) + edit.newText + endLineContent.slice(endChar);
          lines.splice(startLine, endLine - startLine + 1, newContent);
        }
      }

      // Write back
      const newContent = lines.join('\n');
      await invoke('write_file', { path: filePath, content: newContent });
      appliedFiles.push(getRelativePath(filePath));

    } catch (err) {
      errors.push(`Failed to update ${getRelativePath(filePath)}: ${extractErrorMessage(err)}`);
    }
  }

  // Format result
  const resultLines: string[] = [];
  resultLines.push(`✅ Renamed "${actualOldName}" → "${newName}"`);
  resultLines.push('');
  resultLines.push(`Updated ${appliedFiles.length} file${appliedFiles.length > 1 ? 's' : ''}:`);
  for (const file of appliedFiles) {
    resultLines.push(`  • ${file}`);
  }

  if (errors.length > 0) {
    resultLines.push('');
    resultLines.push('⚠️ Errors:');
    for (const err of errors) {
      resultLines.push(`  • ${err}`);
    }
  }

  return { success: true, output: resultLines.join('\n') };
}

// ============================================================================
// TOOL: lsp_prepare_rename (helper to check if rename is valid)
// ============================================================================

export async function handleLspPrepareRename(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path ? String(args.path) : null;
  const line = typeof args.line === 'number' ? args.line : null;
  const column = typeof args.column === 'number' ? args.column : null;

  if (!path) {
    return { success: false, error: 'path is required' };
  }

  if (line === null || column === null) {
    return { success: false, error: 'line and column are required (1-based)' };
  }

  const absolutePath = resolvePath(path);

  // Ensure LSP is running (prepare_rename only for TypeScript)
  const lspType = await ensureLspForFile(absolutePath);
  if (!lspType || lspType !== 'typescript') {
    return { success: false, error: `LSP rename only available for TypeScript/JavaScript files` };
  }

  await ensureDocumentOpen(absolutePath, lspType);

  const result = await prepareRename(absolutePath, line - 1, column - 1);

  if (!result) {
    return {
      success: true,
      output: `Cannot rename at ${path}:${line}:${column}. Position is not on a renameable symbol.`
    };
  }

  return {
    success: true,
    output: `Symbol "${result.placeholder}" at ${path}:${line}:${column} can be renamed.`
  };
}

// ============================================================================
// TOOL: lsp_get_code_actions - Get ESLint code actions (quick fixes)
// ============================================================================

export async function handleLspGetCodeActions(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path ? String(args.path) : null;
  const line = typeof args.line === 'number' ? args.line : null;
  const endLine = typeof args.end_line === 'number' ? args.end_line : line;
  const fixAll = args.fix_all === true;

  if (!path) {
    return { success: false, error: 'path is required' };
  }

  const absolutePath = resolvePath(path);
  const relativePath = getRelativePath(absolutePath);

  // Determine if it's a Dart file or ESLint file
  const isDart = isDartFile(absolutePath);
  const isEslint = isEslintFile(absolutePath);

  if (!isDart && !isEslint) {
    return {
      success: false,
      error: `Code actions only available for Dart (.dart) and JS/TS (.ts, .js, etc.) files. Got: ${relativePath}`
    };
  }

  // Handle Dart code actions
  if (isDart) {
    // Ensure document is open in Dart LSP
    await ensureDocumentOpen(absolutePath, 'dart');

    // Get code actions for a specific line or range
    const startLine = line !== null ? line - 1 : 0;
    const endL = endLine !== null ? endLine - 1 : startLine;

    const actions = (await withTimeout(
      getDartCodeActions(absolutePath, startLine, 0, endL, 0),
      20000,
      'Code actions lookup timed out'
    )) as any[];


    if (!actions || actions.length === 0) {
      const rangeInfo = line ? ` at line ${line}${endLine !== line ? `-${endLine}` : ''}` : '';
      return {
        success: true,
        output: `No code actions available for ${relativePath}${rangeInfo}`
      };
    }

    // Format the code actions for the AI
    const resultLines: string[] = [];
    resultLines.push(`Dart code actions for ${relativePath}:`);
    resultLines.push('');

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      resultLines.push(`${i + 1}. ${action.title}`);
      if (action.kind) {
        resultLines.push(`   Kind: ${action.kind}`);
      }
    }

    resultLines.push('');
    resultLines.push('To apply a fix, use lsp_apply_code_action with the action index.');

    return { success: true, output: resultLines.join('\n') };
  }

  // Handle ESLint code actions
  // Open document in ESLint LSP
  try {
    const content = await invoke<string>('read_file', { path: absolutePath });
    await notifyEslintDocumentOpened(absolutePath, content);

    // Small delay to let ESLint analyze the file
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (err) {
    return { success: false, error: `Failed to read file: ${extractErrorMessage(err)}` };
  }

  // If fix_all is requested, execute ESLint fix all
  if (fixAll) {
    const edit = await executeEslintFixAll(absolutePath);

    if (!edit) {
      return {
        success: true,
        output: `No ESLint fixes available for ${relativePath}`
      };
    }

    // Apply the edits
    try {
      const filesUpdated = await applyWorkspaceEdit(edit);
      return {
        success: true,
        output: `✅ Applied ESLint fixes to ${filesUpdated} file${filesUpdated > 1 ? 's' : ''}`
      };
    } catch (err) {
      return { success: false, error: `Failed to apply fixes: ${extractErrorMessage(err)}` };
    }
  }

  // Get code actions for a specific line or range
  const startLine = line !== null ? line - 1 : 0;
  const startChar = 0;
  const endL = endLine !== null ? endLine - 1 : startLine;
  const endChar = Number.MAX_SAFE_INTEGER;

  const actions = await getEslintCodeActions(absolutePath, startLine, startChar, endL, endChar, []);

  if (!actions || actions.length === 0) {
    const rangeInfo = line ? ` at line ${line}${endLine !== line ? `-${endLine}` : ''}` : '';
    return {
      success: true,
      output: `No ESLint code actions available for ${relativePath}${rangeInfo}`
    };
  }

  // Format the code actions for the AI
  const resultLines: string[] = [];
  resultLines.push(`ESLint code actions for ${relativePath}:`);
  resultLines.push('');

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    resultLines.push(`${i + 1}. ${action.title}`);
    if (action.kind) {
      resultLines.push(`   Kind: ${action.kind}`);
    }
    if (action.isPreferred) {
      resultLines.push(`   ⭐ Preferred fix`);
    }
  }

  resultLines.push('');
  resultLines.push('To apply a fix, use lsp_apply_code_action with the action index.');
  resultLines.push('To fix all ESLint issues at once, use lsp_get_code_actions with fix_all: true');

  return { success: true, output: resultLines.join('\n') };
}

// ============================================================================
// TOOL: lsp_apply_code_action - Apply a specific ESLint code action
// ============================================================================

export async function handleLspApplyCodeAction(args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path ? String(args.path) : null;
  const actionIndex = typeof args.action_index === 'number' ? args.action_index : null;
  const line = typeof args.line === 'number' ? args.line : null;
  const endLine = typeof args.end_line === 'number' ? args.end_line : line;

  if (!path) {
    return { success: false, error: 'path is required' };
  }

  if (actionIndex === null || actionIndex < 1) {
    return { success: false, error: 'action_index is required (1-based index from lsp_get_code_actions)' };
  }

  const absolutePath = resolvePath(path);
  const relativePath = getRelativePath(absolutePath);

  const isDart = isDartFile(absolutePath);
  const isEslint = isEslintFile(absolutePath);

  if (!isDart && !isEslint) {
    return {
      success: false,
      error: `Code actions only available for Dart (.dart) and JS/TS (.ts, .js, etc.) files`
    };
  }

  // Handle Dart
  if (isDart) {
    await ensureDocumentOpen(absolutePath, 'dart');
    const startLine = line !== null ? line - 1 : 0;
    const endL = endLine !== null ? endLine - 1 : startLine;

    const actions = (await getDartCodeActions(absolutePath, startLine, 0, endL, 0)) as any[];

    if (!actions || actions.length === 0) {
      return { success: false, error: `No code actions available` };
    }

    if (actionIndex > actions.length) {
      return { success: false, error: `Action index ${actionIndex} out of range. Available: 1-${actions.length}` };
    }

    const action = actions[actionIndex - 1];

    if (!action.edit) {
      return { success: false, error: `Action "${action.title}" has no edit (may require command execution)` };
    }

    try {
      const filesUpdated = await applyWorkspaceEdit(action.edit);
      return {
        success: true,
        output: `✅ Applied Dart action: ${action.title}\nUpdated ${filesUpdated} file${filesUpdated > 1 ? 's' : ''}`
      };
    } catch (err) {
      return { success: false, error: `Failed to apply Dart action: ${extractErrorMessage(err)}` };
    }
  }

  // Handle ESLint
  // Open document
  try {
    const content = await invoke<string>('read_file', { path: absolutePath });
    await notifyEslintDocumentOpened(absolutePath, content);
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (err) {
    return { success: false, error: `Failed to read file: ${extractErrorMessage(err)}` };
  }

  // Get code actions
  const startLine = line !== null ? line - 1 : 0;
  const endL = endLine !== null ? endLine - 1 : (line !== null ? line - 1 : Number.MAX_SAFE_INTEGER);

  const actions = (await getEslintCodeActions(absolutePath, startLine, 0, endL, Number.MAX_SAFE_INTEGER, [])) as any[];

  if (!actions || actions.length === 0) {
    return { success: false, error: `No code actions available` };
  }

  if (actionIndex > actions.length) {
    return {
      success: false,
      error: `Action index ${actionIndex} out of range. Available: 1-${actions.length}`
    };
  }

  const action = actions[actionIndex - 1];

  if (!action.edit) {
    return {
      success: false,
      error: `Action "${action.title}" has no edit (may require command execution)`
    };
  }

  // Apply the edit
  try {
    const filesUpdated = await applyWorkspaceEdit(action.edit);
    return {
      success: true,
      output: `✅ Applied: ${action.title}\nUpdated ${filesUpdated} file${filesUpdated > 1 ? 's' : ''}`
    };
  } catch (err) {
    return { success: false, error: `Failed to apply action: ${extractErrorMessage(err)}` };
  }
}

/**
 * Apply a workspace edit (supports both changes and documentChanges)
 */
async function applyWorkspaceEdit(edit: any): Promise<number> {
  let filesUpdated = 0;

  // Handle changes format
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      await applyTextEditsToUri(uri, edits as any[]);
      filesUpdated++;
    }
  }

  // Handle documentChanges format
  if (edit.documentChanges) {
    for (const change of edit.documentChanges as any[]) {
      if ('textDocument' in change && 'edits' in change) {
        await applyTextEditsToUri(change.textDocument.uri, change.edits);
        filesUpdated++;
      }
    }
  }

  return filesUpdated;
}

/**
 * Apply text edits to a file by URI
 */
async function applyTextEditsToUri(uri: string, edits: EslintTextEdit[]): Promise<void> {
  // Convert URI to file path
  let filePath = uri.replace('file://', '');
  if (filePath.match(/^\/[a-zA-Z]:/)) {
    filePath = filePath.slice(1);
  }
  filePath = filePath.replace(/%20/g, ' ');

  // Read current content
  const content = await invoke<string>('read_file', { path: filePath });
  const lines = content.split('\n');

  // Sort edits in reverse order (bottom to top) to preserve line numbers
  const sortedEdits = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });

  // Apply each edit
  for (const edit of sortedEdits) {
    const startLine = edit.range.start.line;
    const startChar = edit.range.start.character;
    const endLine = edit.range.end.line;
    const endChar = edit.range.end.character;

    if (startLine === endLine) {
      // Single line edit
      const line = lines[startLine] || '';
      lines[startLine] = line.slice(0, startChar) + edit.newText + line.slice(endChar);
    } else {
      // Multi-line edit
      const startLineContent = lines[startLine] || '';
      const endLineContent = lines[endLine] || '';
      const newContent = startLineContent.slice(0, startChar) + edit.newText + endLineContent.slice(endChar);
      lines.splice(startLine, endLine - startLine + 1, newContent);
    }
  }

  // Write back
  const newContent = lines.join('\n');
  await invoke('write_file', { path: filePath, content: newContent });
}