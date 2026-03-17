/**
 * Search tool handlers
 *
 * - Result grouping by relevance
 * - Code-aware context (shows surrounding lines)
 * - Deduplication of overlapping matches
 * - file:line format for easy navigation
 */

import { invoke } from '@tauri-apps/api/core';
import { fileService } from '$core/services/file-service';
import { projectStore } from '$shared/stores/project.svelte';
import { truncateOutput, resolvePath, type ToolResult } from '$core/ai/tools/utils';
import { getWorkspaceSymbols as getTsWorkspaceSymbols, isTsLspConnected, ensureTsLspStarted } from '$core/lsp/typescript-sidecar';
import { getWorkspaceSymbols as getDartWorkspaceSymbols, isDartLspRunning } from '$core/lsp/dart-sidecar';

interface WorkspaceSearchTelemetry {
  requestedEngine: string;
  engine: string;
  fallbackUsed: boolean;
  fallbackReason?: string | null;
  elapsedMs: number;
  rgSource?: string;
  rgPath?: string | null;
}

interface WorkspaceSearchInvokeResult {
  files: Array<{
    path: string;
    matches: Array<{ line: number; lineContent: string }>;
  }>;
  totalMatches: number;
  truncated: boolean;
  telemetry?: WorkspaceSearchTelemetry;
}

interface WorkspaceSearchRequest {
  query: string;
  rootPath: string;
  isRegex: boolean;
  includeHidden: boolean;
  caseSensitive: boolean;
  includePattern: string;
  excludePattern: string;
}

interface WorkspaceSearchAttempt {
  result: WorkspaceSearchInvokeResult;
  fallbackNote: string | null;
}

function getDefaultExcludePatterns(includeHidden: boolean): string[] {
  const patterns = ['node_modules/**', 'target/**', 'dist/**', 'build/**', '.svelte-kit/**'];
  if (!includeHidden) {
    patterns.push('.git/**', '.next/**');
  }
  return patterns;
}

function normalizeWorkspaceRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

function didWorkspaceRootChange(startRoot: string, currentRoot: string): boolean {
  return normalizeWorkspaceRoot(startRoot) !== normalizeWorkspaceRoot(currentRoot);
}

function isCancelledSearchError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const maybeType = 'type' in error ? (error as { type?: unknown }).type : undefined;
    if (maybeType === 'Cancelled') return true;
  }
  if (error instanceof Error) {
    return /cancelled/i.test(error.message);
  }
  if (typeof error === 'string') {
    return /cancelled/i.test(error);
  }
  return false;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkspaceSearchOptions(request: WorkspaceSearchRequest): Record<string, unknown> {
  const { query, rootPath, isRegex, includeHidden, caseSensitive, includePattern, excludePattern } = request;
  const excludePatterns = excludePattern
    ? [excludePattern, ...getDefaultExcludePatterns(includeHidden)]
    : getDefaultExcludePatterns(includeHidden);
  return {
    query,
    rootPath,
    useRegex: isRegex,
    includeHidden,
    caseSensitive,
    includePatterns: includePattern ? [includePattern] : [],
    excludePatterns,
    maxResults: 50,
    requestId: Date.now(),
  };
}

async function runWorkspaceSearchAttempt(
  request: WorkspaceSearchRequest,
): Promise<WorkspaceSearchInvokeResult> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await invoke<WorkspaceSearchInvokeResult>('workspace_search', {
        options: buildWorkspaceSearchOptions(request),
      });
    } catch (error) {
      lastError = error;
      if (!isCancelledSearchError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      await delay(30 * (attempt + 1));
    }
  }
  throw lastError;
}

async function resolveWorkspaceSearch(
  request: WorkspaceSearchRequest,
): Promise<WorkspaceSearchAttempt> {
  const primary = await runWorkspaceSearchAttempt(request);
  if (primary.totalMatches > 0 || request.isRegex || !request.caseSensitive) {
    return { result: primary, fallbackNote: null };
  }

  const relaxed = await runWorkspaceSearchAttempt({
    ...request,
    caseSensitive: false,
  });
  if (relaxed.totalMatches > 0) {
    return {
      result: relaxed,
      fallbackNote: 'Retried with caseSensitive: false after an exact-scope miss',
    };
  }

  return { result: primary, fallbackNote: null };
}

/**
 * Search workspace for text/regex patterns
 * - Shows 2 lines of context around each match
 * - Groups results by file
 * - Deduplicates overlapping context lines
 * - Caps at 50 matches, truncates long lines at 120 chars
 */
export async function handleWorkspaceSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query);
  const isRegex = args.isRegex === true;
  const includeHidden = Boolean(args.includeHidden);
  const includePattern = args.includePattern ? String(args.includePattern) : '';
  const excludePattern = args.excludePattern ? String(args.excludePattern) : '';
  const caseSensitive = Boolean(args.caseSensitive);
  const explanation = args.explanation ? String(args.explanation) : '';
  const workspaceRoot = projectStore.rootPath || '';

  if (!query.trim()) {
    return { success: false, error: 'Search query cannot be empty' };
  }

  if (!workspaceRoot) {
    return { success: false, error: 'No workspace open' };
  }

  // Use the include pattern exactly as the AI specified — don't modify it.
  // The AI is smart enough to set its own glob patterns.

  try {
    const { result, fallbackNote } = await resolveWorkspaceSearch({
      query,
      rootPath: workspaceRoot,
      isRegex,
      includeHidden,
      caseSensitive,
      includePattern,
      excludePattern,
    });
    const currentWorkspaceRoot = projectStore.rootPath || '';
    const workspaceChanged = didWorkspaceRootChange(
      workspaceRoot,
      currentWorkspaceRoot,
    );

    if (workspaceChanged) {
      let msg = `Search result is stale for "${query}"`;
      msg += isRegex ? '\nMode: regex' : '\nMode: literal';
      msg += `\nWorkspace root used: ${workspaceRoot}`;
      msg += `\nCurrent workspace root: ${currentWorkspaceRoot || '(none)'}`;
      if (includeHidden) {
        msg += '\nInclude hidden: true';
      }
      if (includePattern) {
        msg += `\nInclude pattern: ${includePattern}`;
      }
      if (result.telemetry) {
        msg += `\nEngine: ${result.telemetry.engine}`;
        if (result.telemetry.fallbackUsed && result.telemetry.fallbackReason) {
          msg += `\nFallback: ${result.telemetry.fallbackReason}`;
        }
      }
      msg += '\nThe open workspace changed before this search completed. Retry the search.';
      return {
        success: true,
        output: msg,
        meta: result.telemetry
          ? {
              staleWorkspaceResult: true,
              searchWorkspaceRoot: workspaceRoot,
              currentWorkspaceRoot,
              searchTelemetry: {
                engine: result.telemetry.engine,
                rgSource: result.telemetry.rgSource ?? 'none',
                rgPath: result.telemetry.rgPath ?? null,
                fallbackUsed: result.telemetry.fallbackUsed,
                fallbackReason: result.telemetry.fallbackReason ?? null,
                elapsedMs: result.telemetry.elapsedMs,
              },
            }
          : {
              staleWorkspaceResult: true,
              searchWorkspaceRoot: workspaceRoot,
              currentWorkspaceRoot,
            },
      };
    }

    if (result.totalMatches === 0) {
      // Helpful message with suggestions
      let msg = `No matches for "${query}"`;
      if (isRegex) {
        msg += '\nMode: regex';
        msg += '\nTip: If this was intended as plain text, retry with isRegex: false or omit isRegex.';
      } else {
        msg += '\nMode: literal';
      }
      msg += `\nWorkspace root: ${workspaceRoot}`;
      if (includeHidden) {
        msg += '\nInclude hidden: true';
      }
      if (caseSensitive && !isRegex) {
        msg += '\nTip: Try with caseSensitive: false';
      }
      if (includePattern) {
        msg += `\nInclude pattern: ${includePattern}`;
      }
      if (excludePattern) {
        msg += `\nExclude pattern: ${excludePattern}`;
      }
      if (result.telemetry) {
        msg += `\nEngine: ${result.telemetry.engine}`;
        if (result.telemetry.fallbackUsed && result.telemetry.fallbackReason) {
          msg += `\nFallback: ${result.telemetry.fallbackReason}`;
        }
      }
      if (fallbackNote) {
        msg += `\n${fallbackNote}`;
      }
      return { success: true, output: msg };
    }

    // Format output - clean, scannable format
    const lines: string[] = [];
    const fileCount = result.files.length;
    const matchCount = result.totalMatches;

    lines.push(`Found ${matchCount} match${matchCount > 1 ? 'es' : ''} in ${fileCount} file${fileCount > 1 ? 's' : ''}`);
    lines.push(`Workspace root: ${workspaceRoot}`);
    if (includeHidden) {
      lines.push('Include hidden: true');
    }
    if (result.telemetry) {
      const fallback = result.telemetry.fallbackUsed && result.telemetry.fallbackReason
        ? `, fallback: ${result.telemetry.fallbackReason}`
        : result.telemetry.fallbackUsed
          ? ', fallback used'
          : '';
      const source = result.telemetry.rgSource ? `, source: ${result.telemetry.rgSource}` : '';
      lines.push(`Engine: ${result.telemetry.engine} (${result.telemetry.elapsedMs}ms${source}${fallback})`);
    }
    if (includePattern) {
      lines.push(`Include pattern: ${includePattern}`);
    }
    if (excludePattern) {
      lines.push(`Exclude pattern: ${excludePattern}`);
    }
    if (fallbackNote) {
      lines.push(fallbackNote);
    }
    if (result.truncated) {
      lines.push('(results truncated)');
    }
    lines.push('');

    // Process each file - limit to 10 files to prevent context overflow
    const maxFilesToShow = 10;
    for (const file of result.files.slice(0, maxFilesToShow)) {
      const relativePath = file.path.replace(workspaceRoot, '').replace(/^[/\\]/, '');

      // Get file content for context (skip for very large match counts to save time)
      let fileLines: string[] = [];
      if (file.matches.length <= 10) {
        try {
          const doc = await fileService.read(file.path, true);
          if (doc) {
            fileLines = doc.content.split('\n');
          }
        } catch {
          // Continue without context
        }
      }

      lines.push(`── ${relativePath} (${file.matches.length} match${file.matches.length > 1 ? 'es' : ''}) ──`);

      // Track which lines we've shown to avoid duplicates
      const shownLines = new Set<number>();

      for (const match of file.matches.slice(0, 5)) {
        const lineNum = match.line;

        // Skip if we already showed this line in previous context
        if (shownLines.has(lineNum)) continue;

        if (fileLines.length > 0) {
          // Calculate context range (2 lines before and after)
          const contextStart = Math.max(0, lineNum - 3);
          const contextEnd = Math.min(fileLines.length - 1, lineNum + 1);

          // Show context, skipping already-shown lines
          for (let i = contextStart; i <= contextEnd; i++) {
            if (shownLines.has(i + 1)) continue;
            shownLines.add(i + 1);

            const num = String(i + 1).padStart(4, ' ');
            const content = truncateLine(fileLines[i] || '', 120);
            const isMatch = i + 1 === lineNum;

            const marker = isMatch ? '>' : ' ';
            lines.push(`${marker}${num} │ ${content}`);
          }
          lines.push('');
        } else {
          // No file content available - show just the match
          const num = String(lineNum).padStart(4, ' ');
          lines.push(`${num} │ ${truncateLine(match.lineContent.trim(), 120)}`);
        }
      }

      if (file.matches.length > 5) {
        lines.push(`     ... +${file.matches.length - 5} more matches in this file`);
        lines.push('');
      }
    }

    if (result.files.length > maxFilesToShow) {
      lines.push(`\n... and ${result.files.length - maxFilesToShow} more files with matches`);
      lines.push('Tip: Use includePattern to narrow search, e.g. "**/*.svelte"');
    }

    // Add navigation hint
    lines.push('');
    lines.push('Use read_file with offset/limit to see focused context.');

    const { text, truncated } = truncateOutput(lines.join('\n'));
    return {
      success: true,
      output: text,
      truncated,
      meta: result.telemetry
        ? {
            searchWorkspaceRoot: workspaceRoot,
            searchTelemetry: {
              engine: result.telemetry.engine,
              rgSource: result.telemetry.rgSource ?? 'none',
              rgPath: result.telemetry.rgPath ?? null,
              fallbackUsed: result.telemetry.fallbackUsed,
              fallbackReason: result.telemetry.fallbackReason ?? null,
              elapsedMs: result.telemetry.elapsedMs,
            },
          }
        : undefined,
    };

  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null
        ? JSON.stringify(err)
        : String(err);
    if (/regex|pattern/i.test(message)) {
      const hint = isRegex
        ? 'The regex appears invalid. Fix the pattern or retry with isRegex: false for literal text search.'
        : 'The query appears to contain regex-like characters. Retry without regex mode or escape special characters.';
      return { success: false, error: `Search failed: ${message}\nHint: ${hint}` };
    }
    return { success: false, error: `Search failed: ${message}` };
  }
}

/**
 * Truncate a line to max length, preserving word boundaries
 */
function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;

  // Try to break at a word boundary
  const truncated = line.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLen * 0.7) {
    return truncated.slice(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Find files by name (fuzzy search)
 * - Groups by directory for easier scanning
 * - Shows file type extension
 */
export async function handleFindFiles(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query);

  if (!query.trim()) {
    return { success: false, error: 'Search query cannot be empty' };
  }

  const workspaceRoot = projectStore.rootPath || '';
  const includePattern = args.includePattern ? String(args.includePattern) : '';
  const excludePattern = args.excludePattern ? String(args.excludePattern) : '';
  const includeHidden = Boolean(args.includeHidden);
  const excludePatterns = excludePattern
    ? [excludePattern, ...getDefaultExcludePatterns(includeHidden)]
    : getDefaultExcludePatterns(includeHidden);

  function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  try {
    let results: Array<{ name: string; relativePath: string }>;
    let engineLabel = 'unknown';
    let rgSource: string | null = null;
    let rgPath: string | null = null;
    let elapsedMs = 0;
    let fallbackUsed = false;
    let fallbackReason: string | null = null;

    const backendResult = await invoke<{
      files: string[];
      totalFiles: number;
      truncated: boolean;
      engine: string;
      fallbackUsed: boolean;
      fallbackReason?: string | null;
      elapsedMs: number;
      rgSource?: string | null;
      rgPath?: string | null;
    }>('find_files_by_name', {
      options: {
        query,
        rootPath: workspaceRoot,
        includeHidden,
        engine: 'rg',
        includePatterns: includePattern ? [includePattern] : [],
        excludePatterns,
        maxResults: 25,
      }
    });
    const currentWorkspaceRoot = projectStore.rootPath || '';
    const workspaceChanged = didWorkspaceRootChange(
      workspaceRoot,
      currentWorkspaceRoot,
    );
    engineLabel = backendResult.engine;
    rgSource = backendResult.rgSource ?? null;
    rgPath = backendResult.rgPath ?? null;
    elapsedMs = backendResult.elapsedMs ?? 0;
    fallbackUsed = backendResult.fallbackUsed;
    fallbackReason = backendResult.fallbackReason ?? null;
    results = backendResult.files.map((relativePath) => ({
      relativePath,
      name: relativePath.split('/').pop() || relativePath,
    }));

    if (workspaceChanged) {
      let msg = `Find files result is stale for "${query}"`;
      msg += `\nWorkspace root used: ${workspaceRoot}`;
      msg += `\nCurrent workspace root: ${currentWorkspaceRoot || '(none)'}`;
      if (includePattern) {
        msg += `\nInclude pattern: ${includePattern}`;
      }
      msg += `\nSearch backend: ${engineLabel}`;
      msg += `\nFallback: ${fallbackUsed ? (fallbackReason ?? 'used') : 'none'}`;
      msg += '\nThe open workspace changed before this search completed. Retry the search.';
      return {
        success: true,
        output: msg,
        meta: {
          staleWorkspaceResult: true,
          searchWorkspaceRoot: workspaceRoot,
          currentWorkspaceRoot,
          searchTelemetry: {
            engine: engineLabel,
            rgSource: rgSource ?? (engineLabel === 'rg' ? 'unknown' : 'none'),
            rgPath,
            fallbackUsed,
            fallbackReason,
            elapsedMs,
          },
        },
      };
    }

    if (results.length === 0) {
      // Helpful suggestions
      let msg = `No files matching "${query}"`;
      msg += `\nWorkspace root: ${workspaceRoot}`;
      if (includePattern) {
        msg += `\nInclude pattern: ${includePattern}`;
      }
      if (query.includes('.')) {
        msg += `\nTip: Try without extension, e.g. "${query.split('.')[0]}"`;
      }
      if (query.length < 3) {
        msg += '\nTip: Try a longer search term';
      }
      msg += `\nSearch backend: ${engineLabel}`;
      msg += `\nFallback: ${fallbackUsed ? (fallbackReason ?? 'used') : 'none'}`;
      return { success: true, output: msg };
    }

    // Format with file type indicators and grouping
    const lines: string[] = [];
    lines.push(`Found ${results.length} file${results.length > 1 ? 's' : ''} matching "${query}":`);
    lines.push(`Workspace root: ${workspaceRoot}`);
    lines.push(`Search backend: ${engineLabel}`);
    lines.push(`Fallback: ${fallbackUsed ? (fallbackReason ?? 'used') : 'none'}`);
    if (includePattern) {
      lines.push(`Include pattern: ${includePattern}`);
    }
    lines.push('');

    // Group by parent directory for easier scanning
    const byDir = new Map<string, typeof results>();
    for (const file of results) {
      const parts = file.relativePath.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(file);
    }

    // If all in same dir or few results, show flat list
    if (byDir.size <= 2 || results.length <= 8) {
      for (const file of results) {
        lines.push(`  ${file.relativePath}`);
      }
    } else {
      // Group by directory
      for (const [dir, files] of byDir) {
        if (files.length === 0) continue;
        lines.push(`${dir}/`);
        for (const file of files) {
          lines.push(`  ${file.name}`);
        }
      }
    }

    // Add helpful hint
    lines.push('');
    lines.push('Use read_file to view contents.');

    return {
      success: true,
        output: lines.join('\n'),
        meta: {
          searchWorkspaceRoot: workspaceRoot,
          searchTelemetry: {
            engine: engineLabel,
            rgSource: rgSource ?? (engineLabel === 'rg' ? 'unknown' : 'none'),
            rgPath,
            fallbackUsed,
            fallbackReason,
            elapsedMs,
          },
        },
      };

  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null
        ? JSON.stringify(err)
        : String(err);
    return { success: false, error: `Find failed: ${message}` };
  }
}



/**
 * Search for symbols (functions, classes, variables) using LSP
 * Uses workspace symbol queries from connected LSPs with regex text fallback.
 */
export async function handleSearchSymbols(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query);
  const kindFilter = args.kind ? String(args.kind).toLowerCase() : null;
  const workspaceRoot = projectStore.rootPath || '';

  if (!workspaceRoot) {
    return { success: false, error: 'No workspace open' };
  }

  try {
    // Use workspace symbol search from LSP - query all active LSPs
    let symbols: any[] = [];

    // Query TypeScript LSP if connected
    if (isTsLspConnected()) {
      const tsSymbols = await getTsWorkspaceSymbols(query);
      if (tsSymbols) symbols = symbols.concat(tsSymbols);
    }

    // Query Dart LSP if running
    if (isDartLspRunning()) {
      const dartSymbols = await getDartWorkspaceSymbols(query);
      if (dartSymbols) symbols = symbols.concat(dartSymbols);
    }

    // If no symbols from active LSPs, try to start them if they should be there
    if (symbols.length === 0) {
      // Logic to bootstrap LSP for symbol search if needed
      // (Simplified for now: if no symbols, proceed to fallback)
    }

    if (!symbols || symbols.length === 0) {
      // Fallback: use text search for the symbol name
      const fallbackResult = await handleWorkspaceSearch({
        query: `\\b${query}\\b`,
        includePattern: '**/*.{ts,tsx,js,jsx,svelte,vue,dart}',
        caseSensitive: true
      });

      if (fallbackResult.success && fallbackResult.output) {
        return {
          success: true,
          output: `No LSP symbols found. Text search results:\n${fallbackResult.output}`
        };
      }

      return { success: true, output: `No symbols matching "${query}"` };
    }

    // Map LSP symbol kinds to readable names
    const kindNames: Record<number, string> = {
      1: 'file', 2: 'module', 3: 'namespace', 4: 'package',
      5: 'class', 6: 'method', 7: 'property', 8: 'field',
      9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function',
      13: 'variable', 14: 'constant', 15: 'string', 16: 'number',
      17: 'boolean', 18: 'array', 19: 'object', 20: 'key',
      21: 'null', 22: 'enum_member', 23: 'struct', 24: 'event',
      25: 'operator', 26: 'type_parameter'
    };

    // Filter by kind if specified
    let filtered = symbols;
    if (kindFilter) {
      const kindMap: Record<string, number[]> = {
        'function': [6, 12], // method, function
        'class': [5],
        'variable': [13, 14], // variable, constant
        'type': [11, 26], // interface, type_parameter
        'interface': [11],
        'enum': [10],
        'property': [7, 8], // property, field
      };
      const allowedKinds = kindMap[kindFilter] || [];
      if (allowedKinds.length > 0) {
        filtered = symbols.filter(s => allowedKinds.includes(s.kind));
      }
    }

    // Format results
    const results = filtered.slice(0, 20).map(s => {
      const kindName = kindNames[s.kind] || 'symbol';
      const filePath = s.location.uri.replace('file://', '').replace(workspaceRoot, '').replace(/^[/\\]/, '');
      const line = s.location.range.start.line + 1;
      const container = s.containerName ? ` (in ${s.containerName})` : '';
      return `${s.name} [${kindName}] - ${filePath}:${line}${container}`;
    });

    const { text } = truncateOutput(
      `Found ${filtered.length} symbols:\n${results.join('\n')}`
    );

    return { success: true, output: text };

  } catch (err) {
    // LSP not available - fallback to text search with broader pattern
    // Covers: function declarations, arrow functions, class/interface/type/enum,
    // const/let/var assignments, Dart keywords, decorators/annotations
    const fallbackResult = await handleWorkspaceSearch({
      query: `(function|class|const|let|var|interface|type|enum|export|def|fn|pub|async|final|late|dynamic|@)\\s*${query}\\b|\\b${query}\\s*(=|:)\\s*(\\(|async|function|class)`,
      includePattern: '**/*.{ts,tsx,js,jsx,svelte,vue,dart,rs,py,go}',
      caseSensitive: false
    });

    if (fallbackResult.success && fallbackResult.output) {
      return {
        success: true,
        output: `Symbol search (text fallback):\n${fallbackResult.output}`
      };
    }

    return { success: false, error: `Symbol search failed: ${err}` };
  }
}
