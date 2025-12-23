/**
 * Smart Context Service v2.0
 * 
 * Inspired by:
 * - Claude Code: CLAUDE.md hierarchical memory, @imports, skills
 * - GitHub Copilot: .github/copilot-instructions.md, prompt files
 * - Cursor: Rules system (Always, Auto Attached, Manual), context symbols
 * - CopilotKit: Bidirectional state, context hooks
 * 
 * Key improvements:
 * 1. VOLT.md project memory (like CLAUDE.md)
 * 2. Hierarchical context loading (project → folder → file)
 * 3. Smart file relevance scoring (not just open tabs)
 * 4. Context budget management (prioritize what matters)
 * 5. Semantic deduplication (don't repeat same info)
 * 6. File content caching (avoid re-reading)
 */

import { editorStore } from '$lib/stores/editor.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { terminalStore } from '$lib/stores/terminal.svelte';
import { activityStore } from '$lib/stores/activity.svelte';
import { readFile } from '$lib/services/file-system';

// ============================================================================
// Types
// ============================================================================

export interface ContextRule {
  /** Rule identifier */
  id: string;
  /** When to include: always, auto (glob match), manual (@ruleName) */
  inclusion: 'always' | 'auto' | 'manual';
  /** Glob pattern for auto-attached rules */
  filePattern?: string;
  /** Rule content (instructions) */
  content: string;
  /** Source file path */
  source: string;
}

export interface FileContext {
  path: string;
  content: string;
  relevanceScore: number;
  reason: string;
  /** Whether content was truncated */
  truncated: boolean;
  /** Line range if partial */
  lineRange?: { start: number; end: number };
}

export interface SmartContextV2 {
  /** Project memory from VOLT.md */
  projectMemory?: string;
  /** Active rules that apply to current context */
  activeRules: ContextRule[];
  /** Currently active file with full content */
  activeFile?: FileContext;
  /** Related files (imports, recent, relevant) */
  relatedFiles: FileContext[];
  /** Terminal output if relevant */
  terminalContext?: string;
  /** Workspace root path */
  workspaceRoot?: string;
  /** Total context size in characters */
  totalSize: number;
  /** Files already in context (to prevent re-reading) */
  filesInContext: Set<string>;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum context budget in characters (~100k tokens ≈ 400k chars for Gemini) */
const MAX_CONTEXT_CHARS = 200_000;

/** Reserved space for system prompt and response */
const RESERVED_CHARS = 20_000;

/** Budget allocation percentages */
const BUDGET = {
  projectMemory: 0.05,    // 5% for VOLT.md
  activeFile: 0.35,       // 35% for current file
  relatedFiles: 0.45,     // 45% for related files
  terminal: 0.10,         // 10% for terminal
  rules: 0.05,            // 5% for rules
};

/** Files to exclude from context */
const EXCLUDED_PATTERNS = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.svelte-kit/',
  'target/',
  // Don't leak AI internals
  'src/lib/services/ai/',
  'src/lib/stores/assistant',
  '.volt/agent/',
];

/** Memory file names (checked in order) */
const MEMORY_FILES = ['VOLT.md', '.volt/VOLT.md', '.volt/instructions.md'];

// ============================================================================
// File Content Cache
// ============================================================================

interface CacheEntry {
  content: string;
  timestamp: number;
  size: number;
}

const fileCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30_000; // 30 seconds

async function getCachedContent(path: string): Promise<string | null> {
  const cached = fileCache.get(path);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.content;
  }
  
  // Check if file is in editor store (most up-to-date)
  const openFile = editorStore.openFiles.find(f => 
    f.path === path || f.path.endsWith(path.replace(/^.*[/\\]/, ''))
  );
  if (openFile) {
    fileCache.set(path, {
      content: openFile.content,
      timestamp: Date.now(),
      size: openFile.content.length,
    });
    return openFile.content;
  }
  
  // Read from disk
  try {
    const content = await readFile(path);
    if (content) {
      fileCache.set(path, {
        content,
        timestamp: Date.now(),
        size: content.length,
      });
      return content;
    }
  } catch {
    // File doesn't exist or can't be read
  }
  
  return null;
}

export function clearContextCache(): void {
  fileCache.clear();
}

export function invalidateCacheEntry(path: string): void {
  fileCache.delete(path);
}

// ============================================================================
// Content Processing
// ============================================================================

/**
 * Smart truncation that preserves structure and relevance
 */
function truncateContent(
  content: string,
  maxChars: number,
  query?: string,
  cursorLine?: number
): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  const lines = content.split('\n');
  const keepLines = new Set<number>();
  
  // Always keep first 30 lines (imports, declarations)
  for (let i = 0; i < Math.min(30, lines.length); i++) {
    keepLines.add(i);
  }
  
  // Always keep last 10 lines
  for (let i = Math.max(0, lines.length - 10); i < lines.length; i++) {
    keepLines.add(i);
  }
  
  // Keep cursor context (±50 lines)
  if (cursorLine !== undefined) {
    const start = Math.max(0, cursorLine - 50);
    const end = Math.min(lines.length, cursorLine + 50);
    for (let i = start; i < end; i++) {
      keepLines.add(i);
    }
  }
  
  // Keep query-relevant lines (±10 lines around matches)
  if (query) {
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (keywords.some(k => line.includes(k))) {
        const start = Math.max(0, i - 10);
        const end = Math.min(lines.length, i + 10);
        for (let j = start; j < end; j++) {
          keepLines.add(j);
        }
      }
    }
  }
  
  // Keep symbol definitions
  const symbolRegex = /^(export\s+)?(class|function|interface|const|let|type|enum|async\s+function)\s+\w+/;
  for (let i = 0; i < lines.length; i++) {
    if (symbolRegex.test(lines[i].trim())) {
      keepLines.add(i);
      // Include opening brace line
      if (i + 1 < lines.length && lines[i + 1].trim().startsWith('{')) {
        keepLines.add(i + 1);
      }
    }
  }
  
  // Build result with truncation markers
  const sortedLines = Array.from(keepLines).sort((a, b) => a - b);
  let result = '';
  let lastLine = -1;
  
  for (const lineNum of sortedLines) {
    if (lastLine !== -1 && lineNum > lastLine + 1) {
      const gap = lineNum - lastLine - 1;
      result += `\n... [${gap} lines omitted] ...\n`;
    }
    result += lines[lineNum] + '\n';
    lastLine = lineNum;
    
    // Stop if we exceed budget
    if (result.length > maxChars) {
      result += '\n... [truncated] ...';
      break;
    }
  }
  
  return { content: result.trim(), truncated: true };
}

/**
 * Score file relevance based on multiple factors
 */
function scoreFileRelevance(
  filePath: string,
  fileContent: string,
  query: string,
  activeFilePath?: string
): number {
  let score = 0;
  const lowerPath = filePath.toLowerCase();
  const lowerContent = fileContent.toLowerCase();
  const lowerQuery = query.toLowerCase();
  
  // 1. Query keyword matches in path (high value)
  const keywords = lowerQuery.split(/\s+/).filter(k => k.length > 2);
  for (const keyword of keywords) {
    if (lowerPath.includes(keyword)) score += 20;
    // Count content matches (capped)
    const matches = (lowerContent.match(new RegExp(keyword, 'g')) || []).length;
    score += Math.min(matches * 2, 30);
  }
  
  // 2. Import relationship with active file
  if (activeFilePath) {
    const activeContent = editorStore.activeFile?.content || '';
    if (activeContent.includes(filePath.split('/').pop()?.replace(/\.\w+$/, '') || '')) {
      score += 40; // Imported by active file
    }
  }
  
  // 3. Recent activity bonus
  const recentIndex = activityStore.recentPaths.indexOf(filePath);
  if (recentIndex !== -1) {
    score += Math.max(0, 20 - recentIndex * 2);
  }
  
  // 4. File type relevance
  if (filePath.endsWith('.svelte') || filePath.endsWith('.ts')) score += 5;
  if (filePath.includes('store') || filePath.includes('service')) score += 5;
  
  // 5. Penalize large files (prefer focused context)
  if (fileContent.length > 10000) score -= 10;
  if (fileContent.length > 50000) score -= 20;
  
  return score;
}

// ============================================================================
// Memory & Rules Loading
// ============================================================================

/**
 * Load project memory from VOLT.md (like CLAUDE.md)
 */
async function loadProjectMemory(workspaceRoot: string): Promise<string | null> {
  for (const memFile of MEMORY_FILES) {
    const path = `${workspaceRoot}/${memFile}`;
    const content = await getCachedContent(path);
    if (content) {
      return content;
    }
  }
  return null;
}

/**
 * Check if a path should be excluded from context
 */
function isExcluded(path: string): boolean {
  return EXCLUDED_PATTERNS.some(pattern => path.includes(pattern));
}

// ============================================================================
// Main Context Gathering
// ============================================================================

/**
 * Gather smart context for AI request
 * 
 * This is the main entry point. It:
 * 1. Loads project memory (VOLT.md)
 * 2. Gets active file with smart truncation
 * 3. Finds related files based on imports and relevance
 * 4. Includes terminal output if query mentions errors/terminal
 * 5. Manages total context budget
 */
export async function getSmartContextV2(query: string): Promise<SmartContextV2> {
  const workspaceRoot = projectStore.rootPath ?? '';
  const availableBudget = MAX_CONTEXT_CHARS - RESERVED_CHARS;
  const filesInContext = new Set<string>();
  
  let totalSize = 0;
  const context: SmartContextV2 = {
    activeRules: [],
    relatedFiles: [],
    totalSize: 0,
    filesInContext,
    workspaceRoot: workspaceRoot || undefined,
  };
  
  // 1. Load Project Memory (VOLT.md)
  const memoryBudget = Math.floor(availableBudget * BUDGET.projectMemory);
  if (workspaceRoot) {
    const memory = await loadProjectMemory(workspaceRoot);
    if (memory) {
      const { content } = truncateContent(memory, memoryBudget);
      context.projectMemory = content;
      totalSize += content.length;
    }
  }
  
  // 2. Active File (highest priority)
  const activeFileBudget = Math.floor(availableBudget * BUDGET.activeFile);
  const activeFile = editorStore.activeFile;
  if (activeFile && !isExcluded(activeFile.path)) {
    const cursor = editorStore.cursorPosition;
    const { content, truncated } = truncateContent(
      activeFile.content,
      activeFileBudget,
      query,
      cursor.line
    );
    
    context.activeFile = {
      path: activeFile.path,
      content,
      relevanceScore: 100,
      reason: 'Active file',
      truncated,
    };
    filesInContext.add(activeFile.path);
    totalSize += content.length;
  }
  
  // 3. Related Files
  const relatedBudget = Math.floor(availableBudget * BUDGET.relatedFiles);
  let relatedUsed = 0;
  
  // Collect candidate files from multiple sources
  const candidates: Array<{ path: string; content: string; source: string }> = [];
  
  // 3a. Open tabs (already loaded, high relevance)
  for (const file of editorStore.openFiles) {
    if (file.path === activeFile?.path) continue;
    if (isExcluded(file.path)) continue;
    candidates.push({
      path: file.path,
      content: file.content,
      source: 'open_tab',
    });
  }
  
  // 3b. Imports from active file
  if (activeFile) {
    const imports = extractImports(activeFile.content, activeFile.path, workspaceRoot);
    for (const importPath of imports) {
      if (filesInContext.has(importPath)) continue;
      if (isExcluded(importPath)) continue;
      
      const content = await getCachedContent(importPath);
      if (content) {
        candidates.push({
          path: importPath,
          content,
          source: 'import',
        });
      }
    }
  }
  
  // Score and sort candidates
  const scoredCandidates = candidates.map(c => ({
    ...c,
    score: scoreFileRelevance(c.path, c.content, query, activeFile?.path),
  })).sort((a, b) => b.score - a.score);
  
  // Add files until budget exhausted
  for (const candidate of scoredCandidates) {
    if (filesInContext.has(candidate.path)) continue;
    
    const remainingBudget = relatedBudget - relatedUsed;
    if (remainingBudget < 500) break; // Minimum useful size
    
    const perFileBudget = Math.min(remainingBudget, 15000); // Cap per file
    const { content, truncated } = truncateContent(
      candidate.content,
      perFileBudget,
      query
    );
    
    context.relatedFiles.push({
      path: candidate.path,
      content,
      relevanceScore: candidate.score,
      reason: candidate.source === 'import' ? 'Imported by active file' : 'Open tab',
      truncated,
    });
    
    filesInContext.add(candidate.path);
    relatedUsed += content.length;
    totalSize += content.length;
  }
  
  // 4. Terminal Context (if query mentions errors/terminal/run)
  const terminalBudget = Math.floor(availableBudget * BUDGET.terminal);
  const terminalKeywords = ['error', 'terminal', 'run', 'build', 'test', 'npm', 'cargo', 'fail'];
  if (terminalKeywords.some(k => query.toLowerCase().includes(k))) {
    const terminalOutput = getTerminalOutput(terminalBudget);
    if (terminalOutput) {
      context.terminalContext = terminalOutput;
      totalSize += terminalOutput.length;
    }
  }
  
  context.totalSize = totalSize;
  return context;
}

/**
 * Extract import paths from file content
 */
function extractImports(content: string, currentPath: string, workspaceRoot: string): string[] {
  const imports: string[] = [];
  const importRegex = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    const resolved = resolveImportPath(importPath, currentPath, workspaceRoot);
    if (resolved) {
      imports.push(resolved);
    }
  }
  
  return imports;
}

/**
 * Resolve import path to absolute path
 */
function resolveImportPath(importPath: string, currentPath: string, workspaceRoot: string): string | null {
  // Skip node_modules imports
  if (!importPath.startsWith('.') && !importPath.startsWith('$lib')) {
    return null;
  }
  
  const sep = currentPath.includes('\\') ? '\\' : '/';
  const dir = currentPath.substring(0, currentPath.lastIndexOf(sep) + 1);
  
  let resolved: string;
  
  if (importPath.startsWith('$lib')) {
    // SvelteKit $lib alias
    resolved = workspaceRoot + sep + 'src' + sep + 'lib' + importPath.slice(4).replace(/\//g, sep);
  } else {
    // Relative import
    resolved = dir + importPath.replace(/\//g, sep);
  }
  
  // Clean up path
  resolved = resolved.replace(/[/\\]\.\//g, sep);
  
  // Add extension if missing
  if (!resolved.match(/\.\w+$/)) {
    // Try common extensions
    const extensions = ['.ts', '.svelte', '.js'];
    for (const ext of extensions) {
      const withExt = resolved + ext;
      // We'll try to read it later, just return the most likely
      if (currentPath.endsWith('.svelte') && ext === '.svelte') {
        return withExt;
      }
      if (currentPath.endsWith('.ts') && ext === '.ts') {
        return withExt;
      }
    }
    resolved += '.ts'; // Default to .ts
  }
  
  return resolved;
}

/**
 * Get recent terminal output
 */
function getTerminalOutput(maxChars: number): string | null {
  const sessions = terminalStore.sessions;
  if (sessions.length === 0) return null;
  
  let output = '';
  for (const session of sessions) {
    const sessionOutput = session.getRecentOutput(Math.floor(maxChars / sessions.length));
    if (sessionOutput.trim()) {
      output += `[Terminal ${session.id}]\n${sessionOutput}\n\n`;
    }
  }
  
  return output.trim() || null;
}

// ============================================================================
// Context Formatting
// ============================================================================

/**
 * Format context for AI prompt
 * 
 * Key principles:
 * 1. Clear structure with XML-like tags
 * 2. File paths always shown for reference
 * 3. Truncation clearly marked
 * 4. Instructions for AI on how to use context
 */
export function formatSmartContextV2(context: SmartContextV2): string {
  const parts: string[] = [];
  
  // Header with instructions
  parts.push(`<context>
<!-- 
  CONTEXT USAGE INSTRUCTIONS:
  1. This context contains files relevant to the user's query
  2. DO NOT re-read files shown here - use this content directly
  3. When editing, use the EXACT content shown (whitespace matters)
  4. Files marked [truncated] may need read_file for full content
  5. Check filesInContext before calling read_file
-->
`);
  
  // Workspace info
  if (context.workspaceRoot) {
    parts.push(`<workspace>${context.workspaceRoot}</workspace>\n`);
  }
  
  // Project memory (VOLT.md)
  if (context.projectMemory) {
    parts.push(`<project_memory>
${context.projectMemory}
</project_memory>\n`);
  }
  
  // Active file
  if (context.activeFile) {
    const truncNote = context.activeFile.truncated ? ' [truncated]' : '';
    parts.push(`<active_file path="${context.activeFile.path}"${truncNote}>
\`\`\`
${context.activeFile.content}
\`\`\`
</active_file>\n`);
  }
  
  // Related files
  if (context.relatedFiles.length > 0) {
    parts.push(`<related_files count="${context.relatedFiles.length}">`);
    for (const file of context.relatedFiles) {
      const truncNote = file.truncated ? ' [truncated]' : '';
      parts.push(`
<file path="${file.path}" reason="${file.reason}"${truncNote}>
\`\`\`
${file.content}
\`\`\`
</file>`);
    }
    parts.push(`\n</related_files>\n`);
  }
  
  // Terminal output
  if (context.terminalContext) {
    parts.push(`<terminal_output>
${context.terminalContext}
</terminal_output>\n`);
  }
  
  // Files in context list (for AI reference)
  const fileList = Array.from(context.filesInContext).join(', ');
  parts.push(`<files_in_context>${fileList}</files_in_context>\n`);
  
  parts.push(`</context>`);
  
  // Final instructions
  parts.push(`
CRITICAL CONTEXT RULES:
1. Files listed in <files_in_context> are ALREADY LOADED - do NOT call read_file for them
2. Use the EXACT content shown when making edits (copy-paste, don't paraphrase)
3. If a file is [truncated] and you need more, use read_file with specific line ranges
4. The user's message follows - focus on their request, not on describing this context`);
  
  return parts.join('\n');
}

// ============================================================================
// Utility Exports
// ============================================================================

/**
 * Check if a file is already in context
 */
export function isFileInContext(context: SmartContextV2, filePath: string): boolean {
  return context.filesInContext.has(filePath);
}

/**
 * Get context size stats
 */
export function getContextStats(context: SmartContextV2): {
  totalChars: number;
  fileCount: number;
  budgetUsed: number;
} {
  return {
    totalChars: context.totalSize,
    fileCount: context.filesInContext.size,
    budgetUsed: context.totalSize / MAX_CONTEXT_CHARS,
  };
}
