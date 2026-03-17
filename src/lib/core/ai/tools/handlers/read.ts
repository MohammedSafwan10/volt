/**
 * Read tool handlers - read_file, list_dir, file_outline
 * 
 * Features:
 * - Explanation parameter for intelligent pruning
 * - Line numbers in output
 * - Smart truncation
 */

import { invoke } from '@tauri-apps/api/core';
import { fileService } from '$core/services/file-service';
import { resolvePath, truncateOutput, formatWithLineNumbers, type ToolResult } from '$core/ai/tools/utils';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';

/**
 * Extract keywords from explanation for content relevance scoring
 */
function extractKeywords(explanation: string): string[] {
  if (!explanation) return [];

  // Remove common words and extract meaningful terms
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
    'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'also',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose',
    'where', 'when', 'why', 'how', 'all', 'each', 'every', 'any', 'some',
    'file', 'code', 'function', 'find', 'look', 'see', 'check', 'read', 'get',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'they', 'their'
  ]);

  const words = explanation.toLowerCase()
    .replace(/[^a-z0-9_\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  return [...new Set(words)];
}

/**
 * Score a line's relevance based on keywords
 */
function scoreLineRelevance(line: string, keywords: string[]): number {
  if (keywords.length === 0) return 1;

  const lineLower = line.toLowerCase();
  let score = 0;

  for (const keyword of keywords) {
    if (lineLower.includes(keyword)) {
      score += 2;
      // Bonus for exact word match
      if (new RegExp(`\\b${keyword}\\b`).test(lineLower)) {
        score += 1;
      }
    }
  }

  // Bonus for important code patterns
  if (/^(export|function|class|interface|type|const|let|var)\s/.test(line.trim())) {
    score += 1;
  }

  return score;
}

/**
 * Intelligently prune file content based on explanation
 * Keeps relevant sections + context, removes irrelevant parts
 */
function pruneContent(content: string, explanation: string, maxLines = 300): {
  pruned: string;
  wasPruned: boolean;
  relevantRanges: Array<{ start: number; end: number }>;
} {
  const lines = content.split('\n');

  // If file is small enough, return as-is
  if (lines.length <= maxLines || !explanation) {
    return { pruned: content, wasPruned: false, relevantRanges: [] };
  }

  const keywords = extractKeywords(explanation);
  if (keywords.length === 0) {
    // No keywords - just truncate
    return {
      pruned: lines.slice(0, maxLines).join('\n') + '\n... [truncated]',
      wasPruned: true,
      relevantRanges: []
    };
  }

  // Score each line
  const scores = lines.map((line, i) => ({ line, index: i, score: scoreLineRelevance(line, keywords) }));

  // Find relevant sections (lines with score > 0 + context)
  const contextLines = 5; // Lines before/after relevant code
  const relevantIndices = new Set<number>();
  const relevantRanges: Array<{ start: number; end: number }> = [];

  for (const { index, score } of scores) {
    if (score > 0) {
      const start = Math.max(0, index - contextLines);
      const end = Math.min(lines.length - 1, index + contextLines);

      for (let i = start; i <= end; i++) {
        relevantIndices.add(i);
      }

      // Track ranges for metadata
      if (relevantRanges.length === 0 || relevantRanges[relevantRanges.length - 1].end < start - 1) {
        relevantRanges.push({ start: start + 1, end: end + 1 }); // 1-based
      } else {
        relevantRanges[relevantRanges.length - 1].end = end + 1;
      }
    }
  }

  // Always include first 20 lines (imports, class definition)
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    relevantIndices.add(i);
  }

  // Build pruned output
  const sortedIndices = [...relevantIndices].sort((a, b) => a - b);
  const prunedLines: string[] = [];
  let lastIndex = -1;

  for (const index of sortedIndices) {
    if (prunedLines.length >= maxLines) break;

    // Add ellipsis for gaps
    if (lastIndex >= 0 && index > lastIndex + 1) {
      const gap = index - lastIndex - 1;
      prunedLines.push(`... [${gap} lines omitted]`);
    }

    prunedLines.push(lines[index]);
    lastIndex = index;
  }

  // Add final ellipsis if needed
  if (lastIndex < lines.length - 1) {
    const remaining = lines.length - lastIndex - 1;
    prunedLines.push(`... [${remaining} lines omitted]`);
  }

  return {
    pruned: prunedLines.join('\n'),
    wasPruned: true,
    relevantRanges
  };
}

/**
 * Read a single file with optional line slice
 * Includes line numbers, intelligent pruning based on explanation
 */
export async function handleReadFile(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const relativePath = String(args.path);
  const explanation = args.explanation ? String(args.explanation) : '';
  const path = resolvePath(relativePath);
  runtime?.onUpdate?.({ liveStatus: 'Reading file...' });

  let content: string;
  try {
    // Use fileService for consistent file access - always get fresh from disk for AI reads
    const doc = await fileService.read(path, true);
    if (!doc) {
      return { success: false, error: `File not found: ${relativePath}` };
    }
    content = doc.content;
  } catch (err) {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  const totalLines = content.split('\n').length;

  const rawOffset = Number(args.offset);
  const rawLimit = Number(args.limit);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(2000, Math.max(1, Math.floor(rawLimit)))
    : totalLines;
  const startLine = Math.min(totalLines, offset + 1);
  const endLine = Math.min(totalLines, startLine + limit - 1);

  let output = content;
  let wasPruned = false;
  let relevantRanges: Array<{ start: number; end: number }> = [];

  if (offset > 0 || Number.isFinite(rawLimit)) {
    // Explicit slice requested.
    const lines = content.split('\n');
    output = lines.slice(startLine - 1, endLine).join('\n');
  } else if (explanation) {
    // No line range but has explanation - use intelligent pruning
    const pruneResult = pruneContent(content, explanation);
    output = pruneResult.pruned;
    wasPruned = pruneResult.wasPruned;
    relevantRanges = pruneResult.relevantRanges;
  }

  // Format with line numbers
  const formatted = formatWithLineNumbers(output, startLine);

  // Add header
  let header = startLine === 1 && endLine === totalLines
    ? `${relativePath} (${totalLines} lines)`
    : `${relativePath} lines ${startLine}-${endLine} of ${totalLines}`;

  if (wasPruned) {
    header += ' [intelligently pruned]';
  }
  header += '\n';

  const { text, truncated } = truncateOutput(header + formatted);

  return {
    success: true,
    output: text,
    truncated,
    meta: {
      startLine,
      endLine,
      totalLines,
      wasPruned,
      relevantRanges
    }
  };
}

/**
 * Read multiple files at once
 */
export async function handleReadFiles(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const paths = args.paths as string[] | undefined;
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return { success: false, error: 'No paths provided' };
  }
  runtime?.onUpdate?.({
    liveStatus: paths.length === 1 ? 'Reading file...' : `Reading ${paths.length} files...`,
  });

  const results: string[] = [];
  let totalLines = 0;

  for (const relativePath of paths) {
    const path = resolvePath(relativePath);
    try {
      // Use fileService for consistent file access - always get fresh from disk
      const doc = await fileService.read(path, true);
      if (!doc) {
        results.push(`── ${relativePath} ──\n[Error: File not found]`);
        continue;
      }
      const content = doc.content;
      const lines = content.split('\n').length;
      totalLines += lines;

      const formatted = formatWithLineNumbers(content);
      results.push(`── ${relativePath} (${lines} lines) ──\n${formatted}`);
    } catch {
      results.push(`── ${relativePath} ──\n[Error: File not found]`);
    }
  }

  const { text, truncated } = truncateOutput(results.join('\n\n'));

  return {
    success: true,
    output: text,
    truncated,
    meta: { totalLines, fileCount: paths.length }
  };
}

/**
 * List directory contents
 */
export async function handleListDir(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path || '.');
  const path = resolvePath(relativePath);

  try {
    const entries = await invoke<Array<{
      name: string;
      isDir: boolean;
      size: number;
    }>>('list_dir', { path });

    if (entries.length === 0) {
      return { success: true, output: `${relativePath}/ (empty)` };
    }

    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const lines = entries.map(e => {
      const icon = e.isDir ? '📁' : '📄';
      const size = e.isDir ? '' : ` (${formatSize(e.size)})`;
      return `${icon} ${e.name}${size}`;
    });

    return {
      success: true,
      output: `${relativePath}/\n${lines.join('\n')}`
    };
  } catch (err) {
    return { success: false, error: `Cannot list: ${relativePath}` };
  }
}

/**
 * Get file tree structure (recursive directory listing)
 * List directory contents:
 * - Shows file type icons/emojis
 * - Shows file counts per directory
 * - Smarter directory skipping
 * - Shows project type detection (React, Svelte, etc.)
 * - LARGE PROJECT SAFE: Caps total entries to prevent context overflow
 */
export async function handleGetFileTree(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path || '.');
  const maxDepth = Math.min(Number(args.depth) || 3, 4); // Cap at 4 for safety
  const path = resolvePath(relativePath);

  try {
    const { tree, stats, wasTruncated } = await buildFileTreeWithStats(path, relativePath, 0, maxDepth);
    const output = formatFileTreeBetter(tree, relativePath, stats, wasTruncated);
    const { text, truncated } = truncateOutput(output);
    return { success: true, output: text, truncated: truncated || wasTruncated };
  } catch (err) {
    return { success: false, error: `Cannot get tree: ${relativePath}` };
  }
}

interface TreeEntry {
  name: string;
  isDir: boolean;
  children?: TreeEntry[];
  fileCount?: number; // For directories
}

interface TreeStats {
  totalFiles: number;
  totalDirs: number;
  fileTypes: Map<string, number>;
  projectType?: string;
}

// Global limit to prevent context overflow on huge projects
const MAX_TREE_ENTRIES = 200;

/**
 * Recursively build file tree with statistics
 * LARGE PROJECT SAFE: Stops after MAX_TREE_ENTRIES
 */
async function buildFileTreeWithStats(
  absolutePath: string,
  relativePath: string,
  currentDepth: number,
  maxDepth: number
): Promise<{ tree: TreeEntry[]; stats: TreeStats; wasTruncated: boolean }> {
  const stats: TreeStats = {
    totalFiles: 0,
    totalDirs: 0,
    fileTypes: new Map(),
  };

  let entryCount = 0;
  let wasTruncated = false;

  const tree = await buildFileTreeRecursive(absolutePath, relativePath, currentDepth, maxDepth, stats,
    () => entryCount++,
    () => entryCount >= MAX_TREE_ENTRIES,
    () => { wasTruncated = true; }
  );

  // Detect project type from file types
  if (stats.fileTypes.has('svelte')) stats.projectType = 'Svelte';
  else if (stats.fileTypes.has('tsx') || stats.fileTypes.has('jsx')) stats.projectType = 'React';
  else if (stats.fileTypes.has('vue')) stats.projectType = 'Vue';
  else if (stats.fileTypes.has('py')) stats.projectType = 'Python';
  else if (stats.fileTypes.has('rs')) stats.projectType = 'Rust';
  else if (stats.fileTypes.has('go')) stats.projectType = 'Go';
  else if (stats.fileTypes.has('ts') || stats.fileTypes.has('js')) stats.projectType = 'Node.js';

  return { tree, stats, wasTruncated };
}

async function buildFileTreeRecursive(
  absolutePath: string,
  relativePath: string,
  currentDepth: number,
  maxDepth: number,
  stats: TreeStats,
  incrementCount: () => void,
  shouldStop: () => boolean,
  markTruncated: () => void
): Promise<TreeEntry[]> {
  if (currentDepth >= maxDepth || shouldStop()) return [];

  try {
    const entries = await invoke<Array<{ name: string; isDir: boolean; path: string }>>('list_dir', { path: absolutePath });

    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    // Skip common non-essential directories
    const skipDirs = ['node_modules', '.git', 'dist', 'build', '.svelte-kit', '__pycache__', '.next', 'coverage', '.turbo', '.cache', 'vendor', 'target', '.pnpm', '.yarn'];

    const result: TreeEntry[] = [];
    for (const entry of entries) {
      // Check if we should stop
      if (shouldStop()) {
        markTruncated();
        break;
      }

      // Skip hidden files at root level (except important ones)
      if (entry.name.startsWith('.') && currentDepth === 0) {
        if (!['env', '.env', '.env.local', '.gitignore', '.eslintrc', '.prettierrc'].some(f => entry.name.includes(f))) {
          continue;
        }
      }
      if (skipDirs.includes(entry.name)) continue;

      incrementCount();

      const treeEntry: TreeEntry = {
        name: entry.name,
        isDir: entry.isDir,
      };

      if (entry.isDir) {
        stats.totalDirs++;
        if (currentDepth < maxDepth - 1 && !shouldStop()) {
          treeEntry.children = await buildFileTreeRecursive(
            entry.path,
            `${relativePath}/${entry.name}`,
            currentDepth + 1,
            maxDepth,
            stats,
            incrementCount,
            shouldStop,
            markTruncated
          );
          treeEntry.fileCount = treeEntry.children.filter(c => !c.isDir).length;
        }
      } else {
        stats.totalFiles++;
        // Track file types
        const ext = entry.name.split('.').pop()?.toLowerCase() || '';
        if (ext) {
          stats.fileTypes.set(ext, (stats.fileTypes.get(ext) || 0) + 1);
        }
      }

      result.push(treeEntry);
    }

    return result;
  } catch {
    return [];
  }
}

/**
 * Format tree with icons and better structure
 */
function formatFileTreeBetter(entries: TreeEntry[], rootPath: string, stats: TreeStats, wasTruncated: boolean): string {
  const lines: string[] = [];

  // Header with project info
  lines.push(`📂 ${rootPath}/`);
  if (stats.projectType) {
    lines.push(`   Project: ${stats.projectType} | ${stats.totalFiles} files, ${stats.totalDirs} directories`);
  } else {
    lines.push(`   ${stats.totalFiles} files, ${stats.totalDirs} directories`);
  }

  if (wasTruncated) {
    lines.push(`   ⚠️ Large project - showing first ${MAX_TREE_ENTRIES} entries. Use find_files or workspace_search for specific files.`);
  }
  lines.push('');

  // Tree
  lines.push(formatTreeRecursive(entries, ''));

  if (wasTruncated) {
    lines.push('');
    lines.push('... (truncated for large project)');
  }

  return lines.join('\n');
}

function formatTreeRecursive(entries: TreeEntry[], prefix: string): string {
  let output = '';

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (entry.isDir) {
      const countInfo = entry.fileCount !== undefined ? ` (${entry.fileCount})` : '';
      output += `${prefix}${connector}📁 ${entry.name}/${countInfo}\n`;
    } else {
      const icon = getFileTypeIcon(entry.name);
      output += `${prefix}${connector}${icon} ${entry.name}\n`;
    }

    if (entry.children && entry.children.length > 0) {
      output += formatTreeRecursive(entry.children, prefix + childPrefix);
    }
  }

  return output;
}

/**
 * Get icon for file type
 */
function getFileTypeIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const icons: Record<string, string> = {
    'ts': '📘', 'tsx': '⚛️', 'js': '📒', 'jsx': '⚛️',
    'svelte': '🔶', 'vue': '💚', 'py': '🐍', 'rs': '🦀',
    'go': '🐹', 'java': '☕', 'rb': '💎', 'php': '🐘',
    'html': '🌐', 'css': '🎨', 'scss': '🎨', 'sass': '🎨',
    'json': '📋', 'yaml': '📋', 'yml': '📋', 'toml': '📋',
    'md': '📝', 'txt': '📄', 'sql': '🗃️',
    'png': '🖼️', 'jpg': '🖼️', 'svg': '🎨', 'ico': '🖼️',
    'lock': '🔒', 'env': '🔐',
  };

  return icons[ext] || '📄';
}

/**
 * Get file info (size, modified date, etc.)
 */
export async function handleGetFileInfo(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);

  try {
    const info = await invoke<{
      name: string;
      isDir: boolean;
      isFile: boolean;
      isReadonly: boolean;
      size: number;
      modified: number | null;
    }>('get_file_info', { path });

    const output = [
      `Name: ${info.name}`,
      `Type: ${info.isDir ? 'Directory' : 'File'}`,
      `Size: ${formatSize(info.size)}`,
      info.modified ? `Modified: ${new Date(info.modified).toLocaleString()}` : null
    ].filter(Boolean).join('\n');

    return { success: true, output };
  } catch (err) {
    return { success: false, error: `File not found: ${relativePath}` };
  }
}

/**
 * Format file size in human readable format
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


/**
 * Read code file with smart structure analysis
 * Smart code reader:
 * - Shows file structure (functions, classes, exports)
 * - Can read specific symbol by name
 * - Auto-detects and highlights important sections
 * - LARGE FILE SAFE: Skips structure analysis for huge files
 */
export async function handleReadCode(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const relativePath = String(args.path);
  const symbolName = args.symbol ? String(args.symbol) : '';
  const showStructure = args.structure !== false; // Default true
  const path = resolvePath(relativePath);
  runtime?.onUpdate?.({ liveStatus: 'Reading code...' });

  let content: string;
  try {
    const doc = await fileService.read(path, true);
    if (!doc) {
      return { success: false, error: `File not found: ${relativePath}` };
    }
    content = doc.content;
  } catch (err) {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  const lines = content.split('\n');
  const totalLines = lines.length;
  const ext = relativePath.split('.').pop()?.toLowerCase() || '';

  // Skip structure analysis for huge files (>2000 lines) to prevent slowdown
  const isHugeFile = totalLines > 2000;

  // Analyze code structure (skip for huge files unless symbol requested)
  const structure = (isHugeFile && !symbolName)
    ? { symbols: [], imports: [] }
    : analyzeCodeStructure(content, ext);

  // If symbol requested, find and return just that symbol
  if (symbolName) {
    const symbol = structure.symbols.find(s =>
      s.name.toLowerCase() === symbolName.toLowerCase() ||
      s.name.toLowerCase().includes(symbolName.toLowerCase())
    );

    if (symbol) {
      const symbolContent = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
      const formatted = formatWithLineNumbers(symbolContent, symbol.startLine);

      return {
        success: true,
        output: `${relativePath} - ${symbol.kind}: ${symbol.name} (lines ${symbol.startLine}-${symbol.endLine})\n\n${formatted}`,
        meta: { symbol, totalLines }
      };
    } else {
      const availableSymbols = structure.symbols.length > 0
        ? structure.symbols.slice(0, 20).map(s => s.name).join(', ')
        : '(file too large for full analysis - try workspace_search)';
      return {
        success: false,
        error: `Symbol "${symbolName}" not found. Available: ${availableSymbols}`
      };
    }
  }

  // Build output with structure header
  const outputLines: string[] = [];

  // Header
  outputLines.push(`📄 ${relativePath} (${totalLines} lines)`);

  if (isHugeFile) {
    outputLines.push(`⚠️ Large file - structure analysis skipped. Use symbol parameter to read specific functions.`);
  }

  // Structure summary if requested and file has structure
  if (showStructure && structure.symbols.length > 0 && !isHugeFile) {
    outputLines.push('');
    outputLines.push('📋 Structure:');

    // Group by kind
    const byKind = new Map<string, typeof structure.symbols>();
    for (const sym of structure.symbols) {
      if (!byKind.has(sym.kind)) byKind.set(sym.kind, []);
      byKind.get(sym.kind)!.push(sym);
    }

    for (const [kind, syms] of byKind) {
      const icon = kind === 'function' ? '⚡' : kind === 'class' ? '🏛️' : kind === 'interface' ? '📐' : kind === 'type' ? '📝' : '•';
      for (const sym of syms.slice(0, 15)) { // Cap at 15 per kind
        const exported = sym.exported ? '↗️' : '  ';
        outputLines.push(`   ${exported} ${icon} ${sym.name} (L${sym.startLine})`);
      }
      if (syms.length > 15) {
        outputLines.push(`   ... +${syms.length - 15} more ${kind}s`);
      }
    }
    outputLines.push('');
  }

  // File content with line numbers
  const formatted = formatWithLineNumbers(content);
  const { text, truncated } = truncateOutput(outputLines.join('\n') + '\n' + formatted);

  return {
    success: true,
    output: text,
    truncated,
    meta: { totalLines, structure: isHugeFile ? null : structure }
  };
}

interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'variable';
  startLine: number;
  endLine: number;
  exported: boolean;
}

interface CodeStructure {
  symbols: CodeSymbol[];
  imports: string[];
}

/**
 * Analyze code structure using regex patterns
 * Works for TS/JS/Svelte - no LSP needed
 */
function analyzeCodeStructure(content: string, ext: string): CodeStructure {
  const lines = content.split('\n');
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];

  // Patterns for different constructs
  const patterns = {
    function: /^(export\s+)?(async\s+)?function\s+(\w+)/,
    arrowFunction: /^(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s*)?\([^)]*\)\s*(:\s*\w+)?\s*=>/,
    class: /^(export\s+)?class\s+(\w+)/,
    interface: /^(export\s+)?interface\s+(\w+)/,
    type: /^(export\s+)?type\s+(\w+)/,
    constExport: /^export\s+const\s+(\w+)/,
    import: /^import\s+/,
  };

  let braceDepth = 0;
  let currentSymbol: CodeSymbol | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Track imports
    if (patterns.import.test(trimmed)) {
      imports.push(trimmed);
      continue;
    }

    // Skip if inside a symbol body
    if (currentSymbol) {
      // Count braces
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }

      if (braceDepth === 0) {
        currentSymbol.endLine = lineNum;
        symbols.push(currentSymbol);
        currentSymbol = null;
      }
      continue;
    }

    // Check for new symbols
    let match: RegExpMatchArray | null;

    if ((match = trimmed.match(patterns.function))) {
      currentSymbol = {
        name: match[3],
        kind: 'function',
        startLine: lineNum,
        endLine: lineNum,
        exported: !!match[1]
      };
      braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      if (braceDepth === 0 && line.includes('{') && line.includes('}')) {
        symbols.push(currentSymbol);
        currentSymbol = null;
      }
    } else if ((match = trimmed.match(patterns.arrowFunction))) {
      currentSymbol = {
        name: match[3],
        kind: 'function',
        startLine: lineNum,
        endLine: lineNum,
        exported: !!match[1]
      };
      braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      if (braceDepth <= 0) {
        // Single line arrow function
        symbols.push(currentSymbol);
        currentSymbol = null;
        braceDepth = 0;
      }
    } else if ((match = trimmed.match(patterns.class))) {
      currentSymbol = {
        name: match[2],
        kind: 'class',
        startLine: lineNum,
        endLine: lineNum,
        exported: !!match[1]
      };
      braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    } else if ((match = trimmed.match(patterns.interface))) {
      currentSymbol = {
        name: match[2],
        kind: 'interface',
        startLine: lineNum,
        endLine: lineNum,
        exported: !!match[1]
      };
      braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      if (braceDepth === 0) {
        symbols.push(currentSymbol);
        currentSymbol = null;
      }
    } else if ((match = trimmed.match(patterns.type))) {
      currentSymbol = {
        name: match[2],
        kind: 'type',
        startLine: lineNum,
        endLine: lineNum,
        exported: !!match[1]
      };
      // Types usually end with ; on same or next line
      if (trimmed.endsWith(';') || trimmed.endsWith('}')) {
        symbols.push(currentSymbol);
        currentSymbol = null;
      } else {
        braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      }
    } else if ((match = trimmed.match(patterns.constExport))) {
      // Simple exported const (not arrow function)
      symbols.push({
        name: match[1],
        kind: 'const',
        startLine: lineNum,
        endLine: lineNum,
        exported: true
      });
    }
  }

  // Close any unclosed symbol
  if (currentSymbol) {
    currentSymbol.endLine = lines.length;
    symbols.push(currentSymbol);
  }

  return { symbols, imports };
}

// ============================================================================
// FILE OUTLINE - Structure only, no content (token-efficient)
// ============================================================================

/**
 * Get file structure outline without loading content.
 * Returns classes, functions, interfaces, types with line ranges.
 * Works on large files (no content = no size limit concerns).
 * ~100x more token-efficient than read_code for understanding file structure.
 */
export async function handleFileOutline(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);

  let content: string;
  try {
    const doc = await fileService.read(path, true);
    if (!doc) {
      return { success: false, error: `File not found: ${relativePath}` };
    }
    content = doc.content;
  } catch {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  const lines = content.split('\n');
  const totalLines = lines.length;
  const ext = relativePath.split('.').pop()?.toLowerCase() || '';

  // Analyze structure — no size limit since we're not returning content
  const structure = analyzeCodeStructure(content, ext);

  // Build compact outline
  const outputLines: string[] = [];
  outputLines.push(`📄 ${relativePath} (${totalLines} lines)`);

  // Import summary
  if (structure.imports.length > 0) {
    outputLines.push(`\nImports: ${structure.imports.length} imports`);
  }

  // Symbols grouped by kind
  if (structure.symbols.length === 0) {
    outputLines.push('\nNo symbols detected (may be a config, data, or markup file)');
  } else {
    outputLines.push('\nSymbols:');

    // Group by kind
    const byKind = new Map<string, typeof structure.symbols>();
    for (const sym of structure.symbols) {
      if (!byKind.has(sym.kind)) byKind.set(sym.kind, []);
      byKind.get(sym.kind)!.push(sym);
    }

    for (const [kind, syms] of byKind) {
      const icon = kind === 'function' ? '⚡' : kind === 'class' ? '🏛️' : kind === 'interface' ? '📐' : kind === 'type' ? '📝' : kind === 'const' ? '📦' : '•';
      for (const sym of syms.slice(0, 30)) {
        const exported = sym.exported ? '↗️ ' : '   ';
        const range = sym.endLine > sym.startLine ? `L${sym.startLine}-L${sym.endLine}` : `L${sym.startLine}`;
        outputLines.push(`  ${exported}${icon} ${sym.name} (${range})`);
      }
      if (syms.length > 30) {
        outputLines.push(`  ... +${syms.length - 30} more ${kind}s`);
      }
    }
  }

  return {
    success: true,
    output: outputLines.join('\n'),
    meta: {
      totalLines,
      symbolCount: structure.symbols.length,
      importCount: structure.imports.length,
    }
  };
}
