/**
 * ============================================================================
 * VOLT ADVANCED RAG CONTEXT ENGINE v3.0
 * ============================================================================
 * 
 * A production-grade context gathering system inspired by:
 * - Kiro: Sub-agents, semantic search, intelligent file discovery
 * - Cursor: Rules system, symbol extraction, smart truncation
 * - Claude Code: Hierarchical memory, project understanding
 * - GitHub Copilot: Relevance scoring, context prioritization
 * 
 * KEY FEATURES:
 * 1. Semantic Understanding - Understands code relationships, not just text
 * 2. Multi-Signal Relevance - Combines imports, symbols, recency, query match
 * 3. Intelligent Chunking - AST-aware truncation preserving structure
 * 4. Dependency Graph - Follows imports to find related code
 * 5. Symbol Extraction - Finds classes, functions, types across codebase
 * 6. Query Intent Analysis - Understands what user is asking for
 * 7. Budget Management - Prioritizes high-value context within limits
 * 8. Caching Layer - Avoids redundant file reads
 * 
 * ============================================================================
 */

import { editorStore } from '$lib/stores/editor.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { terminalStore } from '$lib/stores/terminal.svelte';
import { activityStore } from '$lib/stores/activity.svelte';
import { readFileQuiet } from '$lib/services/file-system';
import { contextEventsStore } from '$lib/stores/context-events.svelte';

// ============================================================================
// TYPES
// ============================================================================

/** Extracted symbol from code */
export interface CodeSymbol {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'type' | 'const' | 'variable' | 'enum' | 'method';
  line: number;
  exported: boolean;
  signature?: string;
}

/** File with full context metadata */
export interface ContextFile {
  path: string;
  content: string;
  relevanceScore: number;
  reasons: string[];
  symbols: CodeSymbol[];
  truncated: boolean;
  size: number;
}

/** Query intent classification */
export interface QueryIntent {
  type: 'explain' | 'fix' | 'implement' | 'refactor' | 'debug' | 'search' | 'general';
  keywords: string[];
  targetSymbols: string[];
  targetFiles: string[];
  needsTerminal: boolean;
  needsGit: boolean;
}

/** The main context object */
export interface SmartContext {
  /** Analyzed query intent */
  intent: QueryIntent;
  /** Project memory from VOLT.md */
  projectMemory?: string;
  /** Active file with full analysis */
  activeFile?: ContextFile;
  /** Related files sorted by relevance */
  relatedFiles: ContextFile[];
  /** Symbol index for quick lookup */
  symbolIndex: Map<string, { file: string; symbol: CodeSymbol }>;
  /** Terminal output if relevant */
  terminalOutput?: string;
  /** Git status if relevant */
  gitContext?: string;
  /** Workspace root */
  workspaceRoot?: string;
  /** Files already in context (prevents re-reading) */
  filesInContext: Set<string>;
  /** Total context size */
  totalSize: number;
  /** Budget utilization percentage */
  budgetUsed: number;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  /** Maximum context size in characters */
  MAX_CONTEXT_CHARS: 250_000,
  /** Reserved space for system prompt + response */
  RESERVED_CHARS: 30_000,
  /** Maximum files to include */
  MAX_FILES: 25,
  /** Maximum symbols to track */
  MAX_SYMBOLS: 200,
  /** Cache TTL in milliseconds */
  CACHE_TTL: 60_000,
  /** Budget allocation */
  BUDGET: {
    projectMemory: 0.03,
    activeFile: 0.30,
    relatedFiles: 0.50,
    terminal: 0.10,
    git: 0.07,
  },
  /** Per-file size limits */
  FILE_LIMITS: {
    activeFile: 50_000,
    relatedFile: 20_000,
    minUseful: 500,
  },
};

/** Patterns to exclude from context */
const EXCLUDED_PATTERNS = [
  'node_modules/', '.git/', 'dist/', 'build/', '.svelte-kit/',
  'target/', '.next/', '.nuxt/', 'coverage/', '__pycache__/',
  '.volt/agent/', 'src/lib/services/ai/', // Don't leak AI internals
  '.env', '.lock', '-lock.json',
];

/** Memory file locations (checked in order) */
const MEMORY_FILES = ['VOLT.md', '.volt/VOLT.md', '.volt/instructions.md', 'CLAUDE.md'];

/** File extensions we care about */
const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.svelte', '.vue',
  '.rs', '.go', '.py', '.rb', '.java', '.kt',
  '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.toml',
  '.md', '.mdx',
];

// ============================================================================
// CACHING LAYER
// ============================================================================

interface CacheEntry {
  content: string;
  symbols: CodeSymbol[];
  timestamp: number;
  size: number;
}

const fileCache = new Map<string, CacheEntry>();
const symbolCache = new Map<string, CodeSymbol[]>();

/** Clear all caches */
export function clearContextCache(): void {
  fileCache.clear();
  symbolCache.clear();
}

/** Invalidate specific file */
export function invalidateCacheEntry(path: string): void {
  fileCache.delete(path);
  symbolCache.delete(path);
}

/** Get file content with caching */
async function getCachedFile(path: string): Promise<CacheEntry | null> {
  // Check cache first
  const cached = fileCache.get(path);
  if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_TTL) {
    return cached;
  }

  // Check editor store (most up-to-date for open files)
  const openFile = editorStore.openFiles.find(f => f.path === path);
  if (openFile) {
    const symbols = extractSymbols(openFile.content, path);
    const entry: CacheEntry = {
      content: openFile.content,
      symbols,
      timestamp: Date.now(),
      size: openFile.content.length,
    };
    fileCache.set(path, entry);
    return entry;
  }

  // Read from disk (use quiet version to avoid toast spam during context gathering)
  try {
    const content = await readFileQuiet(path);
    if (content) {
      const symbols = extractSymbols(content, path);
      const entry: CacheEntry = {
        content,
        symbols,
        timestamp: Date.now(),
        size: content.length,
      };
      fileCache.set(path, entry);
      return entry;
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return null;
}

// ============================================================================
// SYMBOL EXTRACTION (AST-lite)
// ============================================================================

/** Extract symbols from code using regex patterns (fast, no AST parser needed) */
function extractSymbols(content: string, filePath: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = content.split('\n');
  const ext = filePath.split('.').pop()?.toLowerCase();

  // TypeScript/JavaScript patterns
  if (['ts', 'tsx', 'js', 'jsx', 'svelte'].includes(ext || '')) {
    const patterns: Array<{ regex: RegExp; kind: CodeSymbol['kind'] }> = [
      { regex: /^(export\s+)?(async\s+)?function\s+(\w+)/m, kind: 'function' },
      { regex: /^(export\s+)?class\s+(\w+)/m, kind: 'class' },
      { regex: /^(export\s+)?interface\s+(\w+)/m, kind: 'interface' },
      { regex: /^(export\s+)?type\s+(\w+)/m, kind: 'type' },
      { regex: /^(export\s+)?enum\s+(\w+)/m, kind: 'enum' },
      { regex: /^(export\s+)?(const|let|var)\s+(\w+)\s*=/m, kind: 'const' },
      { regex: /^\s+(async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/m, kind: 'method' },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { regex, kind } of patterns) {
        const match = line.match(regex);
        if (match) {
          const exported = line.includes('export');
          const name = match[match.length - 1]; // Last capture group is the name
          if (name && name.length > 1 && !['if', 'for', 'while', 'switch'].includes(name)) {
            symbols.push({
              name,
              kind,
              line: i + 1,
              exported,
              signature: line.trim().slice(0, 100),
            });
          }
        }
      }
    }
  }

  // Rust patterns
  if (ext === 'rs') {
    const patterns: Array<{ regex: RegExp; kind: CodeSymbol['kind'] }> = [
      { regex: /^(pub\s+)?fn\s+(\w+)/m, kind: 'function' },
      { regex: /^(pub\s+)?struct\s+(\w+)/m, kind: 'class' },
      { regex: /^(pub\s+)?trait\s+(\w+)/m, kind: 'interface' },
      { regex: /^(pub\s+)?enum\s+(\w+)/m, kind: 'enum' },
      { regex: /^(pub\s+)?type\s+(\w+)/m, kind: 'type' },
      { regex: /^(pub\s+)?const\s+(\w+)/m, kind: 'const' },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { regex, kind } of patterns) {
        const match = line.match(regex);
        if (match) {
          const exported = line.includes('pub');
          const name = match[2];
          if (name) {
            symbols.push({ name, kind, line: i + 1, exported, signature: line.trim().slice(0, 100) });
          }
        }
      }
    }
  }

  // Python patterns
  if (ext === 'py') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const classMatch = line.match(/^class\s+(\w+)/);
      const funcMatch = line.match(/^(async\s+)?def\s+(\w+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', line: i + 1, exported: true });
      }
      if (funcMatch) {
        symbols.push({ name: funcMatch[2], kind: 'function', line: i + 1, exported: !line.startsWith('  ') });
      }
    }
  }

  return symbols;
}

// ============================================================================
// QUERY INTENT ANALYSIS
// ============================================================================

/** Analyze user query to understand intent */
function analyzeQueryIntent(query: string): QueryIntent {
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.split(/\s+/);

  // Determine intent type
  let type: QueryIntent['type'] = 'general';
  if (/\b(explain|what|how|why|describe)\b/.test(lowerQuery)) type = 'explain';
  else if (/\b(fix|bug|error|issue|broken|wrong|fail)\b/.test(lowerQuery)) type = 'fix';
  else if (/\b(add|create|implement|build|make|write)\b/.test(lowerQuery)) type = 'implement';
  else if (/\b(refactor|improve|clean|optimize|simplify)\b/.test(lowerQuery)) type = 'refactor';
  else if (/\b(debug|trace|log|inspect|check)\b/.test(lowerQuery)) type = 'debug';
  else if (/\b(find|search|where|locate|look)\b/.test(lowerQuery)) type = 'search';

  // Extract potential symbol names (CamelCase, snake_case, UPPER_CASE)
  const symbolPattern = /\b([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*_[a-zA-Z0-9_]*|[A-Z][A-Z0-9_]+)\b/g;
  const targetSymbols = [...new Set(query.match(symbolPattern) || [])].filter(s => s.length > 2);

  // Extract file references
  const filePattern = /\b[\w-]+\.(ts|js|svelte|rs|py|tsx|jsx|vue|go|css|html|json)\b/gi;
  const targetFiles = [...new Set(query.match(filePattern) || [])];

  // Extract meaningful keywords (filter common words)
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'must', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
    'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while',
    'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off']);

  const keywords = words
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 15);

  return {
    type,
    keywords,
    targetSymbols,
    targetFiles,
    needsTerminal: /\b(error|terminal|run|build|test|npm|cargo|fail|output|log)\b/.test(lowerQuery),
    needsGit: /\b(git|commit|branch|diff|change|modified|staged)\b/.test(lowerQuery),
  };
}

// ============================================================================
// IMPORT/DEPENDENCY RESOLUTION
// ============================================================================

/** Extract and resolve imports from file content */
function resolveImports(content: string, currentPath: string, workspaceRoot: string): string[] {
  const imports: string[] = [];
  const sep = currentPath.includes('\\') ? '\\' : '/';
  const dir = currentPath.substring(0, currentPath.lastIndexOf(sep) + 1);

  // Match various import patterns
  const patterns = [
    /(?:import|export)\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /use\s+(?:crate::)?(\w+(?:::\w+)*)/g, // Rust
    /from\s+['"]([^'"]+)['"]\s+import/g, // Python
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];
      if (!importPath) continue;

      // Skip node_modules/external imports
      if (!importPath.startsWith('.') && !importPath.startsWith('$lib') && !importPath.startsWith('@/')) {
        continue;
      }

      let resolved: string;

      if (importPath.startsWith('$lib')) {
        // SvelteKit $lib alias
        resolved = workspaceRoot + sep + 'src' + sep + 'lib' + importPath.slice(4).replace(/\//g, sep);
      } else if (importPath.startsWith('@/')) {
        // Common @ alias (src/)
        resolved = workspaceRoot + sep + 'src' + importPath.slice(2).replace(/\//g, sep);
      } else {
        // Relative import
        resolved = dir + importPath.replace(/\//g, sep);
      }

      // Normalize path (remove ./ and resolve ..)
      resolved = normalizePath(resolved);

      // Try to resolve extension
      if (!resolved.match(/\.\w+$/)) {
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.svelte', '.vue', '/index.ts', '/index.js'];
        for (const ext of extensions) {
          imports.push(resolved + ext);
        }
      } else {
        imports.push(resolved);
      }
    }
  }

  return [...new Set(imports)];
}

/** Normalize file path */
function normalizePath(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[/\\]/);
  const result: string[] = [];

  for (const part of parts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }

  return result.join(sep);
}

/** Check if path should be excluded */
function isExcluded(path: string): boolean {
  return EXCLUDED_PATTERNS.some(pattern => path.includes(pattern));
}

/** Check if file has a code extension */
function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some(ext => path.endsWith(ext));
}

// ============================================================================
// RELEVANCE SCORING ENGINE
// ============================================================================

interface ScoringContext {
  query: string;
  intent: QueryIntent;
  activeFilePath?: string;
  activeFileImports: string[];
}

/** Calculate relevance score for a file */
function scoreFileRelevance(
  filePath: string,
  fileContent: string,
  symbols: CodeSymbol[],
  ctx: ScoringContext
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const lowerPath = filePath.toLowerCase();
  const lowerContent = fileContent.toLowerCase();

  // 1. DIRECT FILE REFERENCE (highest priority)
  for (const targetFile of ctx.intent.targetFiles) {
    if (lowerPath.includes(targetFile.toLowerCase())) {
      score += 100;
      reasons.push(`Directly referenced: ${targetFile}`);
    }
  }

  // 2. SYMBOL MATCH (very high priority)
  for (const targetSymbol of ctx.intent.targetSymbols) {
    const matchingSymbol = symbols.find(s => 
      s.name.toLowerCase() === targetSymbol.toLowerCase() ||
      s.name.includes(targetSymbol) ||
      targetSymbol.includes(s.name)
    );
    if (matchingSymbol) {
      score += 80;
      reasons.push(`Contains symbol: ${matchingSymbol.name}`);
    }
  }

  // 3. IMPORT RELATIONSHIP (high priority)
  if (ctx.activeFileImports.some(imp => filePath.includes(imp.split(/[/\\]/).pop()?.replace(/\.\w+$/, '') || ''))) {
    score += 60;
    reasons.push('Imported by active file');
  }

  // 4. KEYWORD MATCHES IN PATH
  for (const keyword of ctx.intent.keywords) {
    if (lowerPath.includes(keyword)) {
      score += 25;
      reasons.push(`Path matches: ${keyword}`);
    }
  }

  // 5. KEYWORD MATCHES IN CONTENT (capped)
  let contentMatches = 0;
  for (const keyword of ctx.intent.keywords) {
    // Escape special regex characters in keyword
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      const regex = new RegExp(`\\b${escapedKeyword}\\b`, 'gi');
      const matches = lowerContent.match(regex);
      if (matches) {
        contentMatches += Math.min(matches.length, 10);
      }
    } catch {
      // If regex still fails, do simple string match
      if (lowerContent.includes(keyword)) {
        contentMatches += 1;
      }
    }
  }
  if (contentMatches > 0) {
    score += Math.min(contentMatches * 3, 40);
    reasons.push(`Content matches: ${contentMatches} keywords`);
  }

  // 6. RECENT ACTIVITY BONUS
  const recentIndex = activityStore.recentPaths.indexOf(filePath);
  if (recentIndex !== -1 && recentIndex < 10) {
    const bonus = 30 - recentIndex * 3;
    score += bonus;
    reasons.push(`Recently accessed (#${recentIndex + 1})`);
  }

  // 7. OPEN TAB BONUS
  if (editorStore.openFiles.some(f => f.path === filePath)) {
    score += 20;
    reasons.push('Open in editor');
  }

  // 8. FILE TYPE RELEVANCE
  if (filePath.endsWith('.svelte') || filePath.endsWith('.tsx') || filePath.endsWith('.vue')) {
    score += 5; // UI components often important
  }
  if (filePath.includes('store') || filePath.includes('service') || filePath.includes('util')) {
    score += 5; // Core logic files
  }

  // 9. EXPORTED SYMBOLS BONUS
  const exportedCount = symbols.filter(s => s.exported).length;
  if (exportedCount > 0) {
    score += Math.min(exportedCount * 2, 15);
  }

  // 10. SIZE PENALTY (prefer focused files)
  if (fileContent.length > 20000) score -= 10;
  if (fileContent.length > 50000) score -= 20;

  return { score, reasons };
}

// ============================================================================
// INTELLIGENT CONTENT TRUNCATION
// ============================================================================

interface TruncationOptions {
  maxChars: number;
  query?: string;
  cursorLine?: number;
  preserveSymbols?: boolean;
}

/** Intelligently truncate content while preserving structure */
function truncateContent(content: string, options: TruncationOptions): { content: string; truncated: boolean } {
  const { maxChars, query, cursorLine, preserveSymbols = true } = options;

  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  const lines = content.split('\n');
  const keepLines = new Set<number>();
  const lineScores = new Map<number, number>();

  // Score each line
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    const line = lines[i];
    const trimmed = line.trim();

    // Imports/exports always important
    if (/^(import|export|from|use|require)/.test(trimmed)) {
      score += 100;
    }

    // Symbol definitions
    if (preserveSymbols && /^(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|pub\s+fn|struct|trait|def)\s+\w+/.test(trimmed)) {
      score += 80;
    }

    // Query keyword matches
    if (query) {
      const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
      for (const kw of keywords) {
        if (line.toLowerCase().includes(kw)) {
          score += 30;
        }
      }
    }

    // Cursor proximity
    if (cursorLine !== undefined) {
      const distance = Math.abs(i - cursorLine);
      if (distance < 50) {
        score += 50 - distance;
      }
    }

    // Comments with TODO/FIXME/NOTE
    if (/\/\/\s*(TODO|FIXME|NOTE|HACK|XXX)/i.test(line)) {
      score += 20;
    }

    lineScores.set(i, score);
  }

  // Always keep first N lines (imports)
  const importEnd = Math.min(40, lines.length);
  for (let i = 0; i < importEnd; i++) {
    keepLines.add(i);
  }

  // Always keep last few lines
  for (let i = Math.max(0, lines.length - 10); i < lines.length; i++) {
    keepLines.add(i);
  }

  // Add high-scoring lines
  const sortedByScore = [...lineScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200);

  for (const [lineNum] of sortedByScore) {
    keepLines.add(lineNum);
    // Add context around important lines
    for (let j = Math.max(0, lineNum - 3); j <= Math.min(lines.length - 1, lineNum + 3); j++) {
      keepLines.add(j);
    }
  }

  // Build result with truncation markers
  const sortedLines = [...keepLines].sort((a, b) => a - b);
  let result = '';
  let lastLine = -1;
  let currentSize = 0;

  for (const lineNum of sortedLines) {
    if (currentSize > maxChars) break;

    if (lastLine !== -1 && lineNum > lastLine + 1) {
      const gap = lineNum - lastLine - 1;
      if (gap > 0) {
        const marker = `\n/* ... ${gap} lines omitted ... */\n`;
        result += marker;
        currentSize += marker.length;
      }
    }

    const lineContent = lines[lineNum] + '\n';
    result += lineContent;
    currentSize += lineContent.length;
    lastLine = lineNum;
  }

  return { content: result.trim(), truncated: true };
}

// ============================================================================
// FILE DISCOVERY ENGINE
// ============================================================================

interface FileCandidate {
  path: string;
  content: string;
  symbols: CodeSymbol[];
  score: number;
  reasons: string[];
}

/** Discover relevant files beyond just open tabs */
async function discoverRelevantFiles(
  ctx: ScoringContext,
  workspaceRoot: string,
  alreadyIncluded: Set<string>
): Promise<FileCandidate[]> {
  const candidates: FileCandidate[] = [];

  // 1. Open tabs (already loaded, high priority)
  for (const file of editorStore.openFiles) {
    if (alreadyIncluded.has(file.path)) continue;
    if (isExcluded(file.path)) continue;

    const symbols = extractSymbols(file.content, file.path);
    const { score, reasons } = scoreFileRelevance(file.path, file.content, symbols, ctx);

    candidates.push({
      path: file.path,
      content: file.content,
      symbols,
      score,
      reasons,
    });
  }

  // 2. Imports from active file
  for (const importPath of ctx.activeFileImports) {
    if (alreadyIncluded.has(importPath)) continue;
    if (isExcluded(importPath)) continue;

    const cached = await getCachedFile(importPath);
    if (cached) {
      const { score, reasons } = scoreFileRelevance(importPath, cached.content, cached.symbols, ctx);
      candidates.push({
        path: importPath,
        content: cached.content,
        symbols: cached.symbols,
        score: score + 30, // Bonus for being imported
        reasons: [...reasons, 'Imported by active file'],
      });
    }
  }

  // 3. Recent files
  for (const recentPath of activityStore.recentPaths.slice(0, 15)) {
    if (alreadyIncluded.has(recentPath)) continue;
    if (isExcluded(recentPath)) continue;
    if (!isCodeFile(recentPath)) continue;

    const cached = await getCachedFile(recentPath);
    if (cached) {
      const { score, reasons } = scoreFileRelevance(recentPath, cached.content, cached.symbols, ctx);
      candidates.push({
        path: recentPath,
        content: cached.content,
        symbols: cached.symbols,
        score,
        reasons,
      });
    }
  }

  // 4. Symbol-based discovery (find files containing target symbols)
  if (ctx.intent.targetSymbols.length > 0 && workspaceRoot) {
    const symbolFiles = await findFilesWithSymbols(ctx.intent.targetSymbols, workspaceRoot, alreadyIncluded);
    for (const sf of symbolFiles) {
      if (!candidates.some(c => c.path === sf.path)) {
        candidates.push(sf);
      }
    }
  }

  // 5. Keyword-based file discovery
  if (ctx.intent.keywords.length > 0 && workspaceRoot) {
    const keywordFiles = await findFilesByKeywords(ctx.intent.keywords, workspaceRoot, alreadyIncluded);
    for (const kf of keywordFiles) {
      if (!candidates.some(c => c.path === kf.path)) {
        candidates.push(kf);
      }
    }
  }

  // Sort by score and deduplicate
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((c, i, arr) => arr.findIndex(x => x.path === c.path) === i);
}

/** Find files containing specific symbols */
async function findFilesWithSymbols(
  symbols: string[],
  workspaceRoot: string,
  exclude: Set<string>
): Promise<FileCandidate[]> {
  const results: FileCandidate[] = [];

  // Check cached files first
  for (const [path, entry] of fileCache.entries()) {
    if (exclude.has(path)) continue;

    for (const symbol of symbols) {
      const match = entry.symbols.find(s => 
        s.name.toLowerCase().includes(symbol.toLowerCase()) ||
        symbol.toLowerCase().includes(s.name.toLowerCase())
      );
      if (match) {
        results.push({
          path,
          content: entry.content,
          symbols: entry.symbols,
          score: 70,
          reasons: [`Contains symbol: ${match.name}`],
        });
        break;
      }
    }
  }

  return results.slice(0, 5);
}

/** Find files by keyword in path */
async function findFilesByKeywords(
  keywords: string[],
  workspaceRoot: string,
  exclude: Set<string>
): Promise<FileCandidate[]> {
  const results: FileCandidate[] = [];

  // Check cached files
  for (const [path, entry] of fileCache.entries()) {
    if (exclude.has(path)) continue;

    const lowerPath = path.toLowerCase();
    for (const keyword of keywords) {
      if (lowerPath.includes(keyword.toLowerCase())) {
        results.push({
          path,
          content: entry.content,
          symbols: entry.symbols,
          score: 40,
          reasons: [`Path contains: ${keyword}`],
        });
        break;
      }
    }
  }

  return results.slice(0, 5);
}

// ============================================================================
// TERMINAL & GIT CONTEXT
// ============================================================================

/** Get recent terminal output */
function getTerminalContext(maxChars: number): string | undefined {
  const sessions = terminalStore.sessions;
  if (sessions.length === 0) return undefined;

  let output = '';
  const perSession = Math.floor(maxChars / sessions.length);

  for (const session of sessions) {
    const sessionOutput = session.getRecentOutput(perSession);
    if (sessionOutput.trim()) {
      output += `═══ Terminal: ${session.id} ═══\n`;
      output += sessionOutput.trim();
      output += '\n\n';
    }
  }

  return output.trim() || undefined;
}

/** Get git context (status, recent changes) */
async function getGitContext(workspaceRoot: string, maxChars: number): Promise<string | undefined> {
  // This would integrate with the git service
  // For now, return undefined - can be enhanced later
  return undefined;
}

// ============================================================================
// PROJECT MEMORY
// ============================================================================

/** Load project memory from VOLT.md or similar */
async function loadProjectMemory(workspaceRoot: string): Promise<string | undefined> {
  for (const memFile of MEMORY_FILES) {
    const path = `${workspaceRoot}/${memFile}`;
    // Use quiet read - these files are optional
    const content = await readFileQuiet(path);
    if (content) {
      return content;
    }
  }
  return undefined;
}

// ============================================================================
// MAIN CONTEXT GATHERING FUNCTION
// ============================================================================

/**
 * Gather smart context for AI request
 * 
 * This is the main entry point. It:
 * 1. Analyzes query intent
 * 2. Loads project memory
 * 3. Processes active file with symbol extraction
 * 4. Discovers and scores related files
 * 5. Includes terminal/git context if relevant
 * 6. Manages budget allocation
 */
export async function getSmartContext(query: string = ''): Promise<SmartContext> {
  const workspaceRoot = projectStore.rootPath ?? '';
  const availableBudget = CONFIG.MAX_CONTEXT_CHARS - CONFIG.RESERVED_CHARS;
  const filesInContext = new Set<string>();
  const symbolIndex = new Map<string, { file: string; symbol: CodeSymbol }>();

  let totalSize = 0;

  // Start gathering - emit event for UI
  contextEventsStore.startGathering();

  // 1. ANALYZE QUERY INTENT
  const intent = analyzeQueryIntent(query);
  contextEventsStore.analyzingIntent(intent.type);

  // Initialize context
  const context: SmartContext = {
    intent,
    relatedFiles: [],
    symbolIndex,
    filesInContext,
    workspaceRoot: workspaceRoot || undefined,
    totalSize: 0,
    budgetUsed: 0,
  };

  // 2. LOAD PROJECT MEMORY
  const memoryBudget = Math.floor(availableBudget * CONFIG.BUDGET.projectMemory);
  if (workspaceRoot) {
    const memory = await loadProjectMemory(workspaceRoot);
    if (memory) {
      const { content } = truncateContent(memory, { maxChars: memoryBudget });
      context.projectMemory = content;
      totalSize += content.length;
      contextEventsStore.addActivity('read', 'Loaded project memory (VOLT.md)');
    }
  }

  // 3. PROCESS ACTIVE FILE
  const activeFileBudget = Math.floor(availableBudget * CONFIG.BUDGET.activeFile);
  const activeFile = editorStore.activeFile;
  let activeFileImports: string[] = [];

  if (activeFile && !isExcluded(activeFile.path)) {
    const filename = activeFile.path.split(/[/\\]/).pop() || activeFile.path;
    contextEventsStore.readingFile(filename);

    const cursor = editorStore.cursorPosition;
    const symbols = extractSymbols(activeFile.content, activeFile.path);
    activeFileImports = resolveImports(activeFile.content, activeFile.path, workspaceRoot);

    contextEventsStore.analyzingImports(filename);

    const { content, truncated } = truncateContent(activeFile.content, {
      maxChars: activeFileBudget,
      query,
      cursorLine: cursor.line,
      preserveSymbols: true,
    });

    context.activeFile = {
      path: activeFile.path,
      content,
      relevanceScore: 100,
      reasons: ['Active file'],
      symbols,
      truncated,
      size: content.length,
    };

    filesInContext.add(activeFile.path);
    totalSize += content.length;

    // Index symbols
    for (const sym of symbols) {
      symbolIndex.set(sym.name, { file: activeFile.path, symbol: sym });
    }

    if (symbols.length > 0) {
      contextEventsStore.indexingSymbols(symbols.length);
    }
  }

  // 4. DISCOVER AND ADD RELATED FILES
  const relatedBudget = Math.floor(availableBudget * CONFIG.BUDGET.relatedFiles);
  let relatedUsed = 0;

  const scoringCtx: ScoringContext = {
    query,
    intent,
    activeFilePath: activeFile?.path,
    activeFileImports,
  };

  contextEventsStore.addActivity('search', 'Discovering relevant files...');
  const candidates = await discoverRelevantFiles(scoringCtx, workspaceRoot, filesInContext);

  for (const candidate of candidates) {
    if (filesInContext.has(candidate.path)) continue;
    if (context.relatedFiles.length >= CONFIG.MAX_FILES) break;

    const remainingBudget = relatedBudget - relatedUsed;
    if (remainingBudget < CONFIG.FILE_LIMITS.minUseful) break;

    const perFileBudget = Math.min(remainingBudget, CONFIG.FILE_LIMITS.relatedFile);
    const { content, truncated } = truncateContent(candidate.content, {
      maxChars: perFileBudget,
      query,
      preserveSymbols: true,
    });

    // Emit event for each relevant file found
    const filename = candidate.path.split(/[/\\]/).pop() || candidate.path;
    const reason = candidate.reasons[0] || 'Relevant';
    contextEventsStore.foundRelevantFile(filename, reason);

    context.relatedFiles.push({
      path: candidate.path,
      content,
      relevanceScore: candidate.score,
      reasons: candidate.reasons,
      symbols: candidate.symbols,
      truncated,
      size: content.length,
    });

    filesInContext.add(candidate.path);
    relatedUsed += content.length;
    totalSize += content.length;

    // Index symbols
    for (const sym of candidate.symbols) {
      if (!symbolIndex.has(sym.name)) {
        symbolIndex.set(sym.name, { file: candidate.path, symbol: sym });
      }
    }
  }

  // 5. TERMINAL CONTEXT (if needed)
  if (intent.needsTerminal) {
    contextEventsStore.addActivity('read', 'Checking terminal output...');
    const terminalBudget = Math.floor(availableBudget * CONFIG.BUDGET.terminal);
    const terminalOutput = getTerminalContext(terminalBudget);
    if (terminalOutput) {
      context.terminalOutput = terminalOutput;
      totalSize += terminalOutput.length;
    }
  }

  // 6. GIT CONTEXT (if needed)
  if (intent.needsGit && workspaceRoot) {
    contextEventsStore.addActivity('read', 'Checking git status...');
    const gitBudget = Math.floor(availableBudget * CONFIG.BUDGET.git);
    const gitContext = await getGitContext(workspaceRoot, gitBudget);
    if (gitContext) {
      context.gitContext = gitContext;
      totalSize += gitContext.length;
    }
  }

  // Update totals
  context.totalSize = totalSize;
  context.budgetUsed = totalSize / CONFIG.MAX_CONTEXT_CHARS;

  // End gathering - emit final stats for UI
  contextEventsStore.endGathering({
    filesFound: filesInContext.size,
    symbolsIndexed: symbolIndex.size,
    budgetUsed: Math.round(context.budgetUsed * 100),
  });

  return context;
}

// ============================================================================
// CONTEXT FORMATTING
// ============================================================================

/**
 * Format context into a structured prompt for the AI
 */
export function formatSmartContext(context: SmartContext): string {
  const parts: string[] = [];

  // Header with metadata
  parts.push(`<context version="3.0" files="${context.filesInContext.size}" budget="${(context.budgetUsed * 100).toFixed(1)}%">`);

  // Query intent analysis (helps AI understand what we're looking for)
  parts.push(`
<query_analysis>
  <intent>${context.intent.type}</intent>
  <keywords>${context.intent.keywords.slice(0, 10).join(', ')}</keywords>
  <target_symbols>${context.intent.targetSymbols.join(', ') || 'none'}</target_symbols>
  <target_files>${context.intent.targetFiles.join(', ') || 'none'}</target_files>
</query_analysis>`);

  // Workspace
  if (context.workspaceRoot) {
    parts.push(`\n<workspace>${context.workspaceRoot}</workspace>`);
  }

  // Project memory
  if (context.projectMemory) {
    parts.push(`
<project_memory>
${context.projectMemory}
</project_memory>`);
  }

  // Active file (most important)
  if (context.activeFile) {
    const truncNote = context.activeFile.truncated ? ' truncated="true"' : '';
    const symbolList = context.activeFile.symbols
      .filter(s => s.exported)
      .slice(0, 20)
      .map(s => `${s.kind}:${s.name}`)
      .join(', ');

    parts.push(`
<active_file path="${context.activeFile.path}"${truncNote} score="${context.activeFile.relevanceScore}">
  <symbols>${symbolList || 'none'}</symbols>
  <reasons>${context.activeFile.reasons.join(', ')}</reasons>
  <content>
\`\`\`
${context.activeFile.content}
\`\`\`
  </content>
</active_file>`);
  }

  // Related files
  if (context.relatedFiles.length > 0) {
    parts.push(`\n<related_files count="${context.relatedFiles.length}">`);

    for (const file of context.relatedFiles) {
      const truncNote = file.truncated ? ' truncated="true"' : '';
      const symbolList = file.symbols
        .filter(s => s.exported)
        .slice(0, 10)
        .map(s => `${s.kind}:${s.name}`)
        .join(', ');

      parts.push(`
  <file path="${file.path}"${truncNote} score="${file.relevanceScore}">
    <symbols>${symbolList || 'none'}</symbols>
    <reasons>${file.reasons.slice(0, 3).join(', ')}</reasons>
    <content>
\`\`\`
${file.content}
\`\`\`
    </content>
  </file>`);
    }

    parts.push(`</related_files>`);
  }

  // Terminal output
  if (context.terminalOutput) {
    parts.push(`
<terminal_output>
${context.terminalOutput}
</terminal_output>`);
  }

  // Git context
  if (context.gitContext) {
    parts.push(`
<git_context>
${context.gitContext}
</git_context>`);
  }

  // Symbol index (quick reference for AI)
  if (context.symbolIndex.size > 0) {
    const symbolEntries = [...context.symbolIndex.entries()]
      .slice(0, 50)
      .map(([name, { file, symbol }]) => `${name} (${symbol.kind}) → ${file}:${symbol.line}`)
      .join('\n  ');

    parts.push(`
<symbol_index count="${context.symbolIndex.size}">
  ${symbolEntries}
</symbol_index>`);
  }

  // Files in context list
  const fileList = [...context.filesInContext].join(', ');
  parts.push(`
<files_in_context>${fileList}</files_in_context>`);

  parts.push(`\n</context>`);

  // Instructions for AI
  parts.push(`

═══════════════════════════════════════════════════════════════════════════════
CONTEXT USAGE RULES:
═══════════════════════════════════════════════════════════════════════════════
1. FILES IN CONTEXT: Do NOT call read_file for files listed in <files_in_context>
2. EXACT CONTENT: When editing, use the EXACT content shown (whitespace matters!)
3. TRUNCATED FILES: If marked truncated="true", use read_file for full content
4. SYMBOL INDEX: Use <symbol_index> to quickly locate definitions
5. QUERY INTENT: The <query_analysis> shows what the user is looking for
6. FOCUS: Address the user's request directly, don't describe this context
═══════════════════════════════════════════════════════════════════════════════`);

  return parts.join('\n');
}

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

/** Check if a file is already in context */
export function isFileInContext(context: SmartContext, filePath: string): boolean {
  return context.filesInContext.has(filePath);
}

/** Get context statistics */
export function getContextStats(context: SmartContext): {
  totalChars: number;
  fileCount: number;
  symbolCount: number;
  budgetUsed: number;
  intentType: string;
} {
  return {
    totalChars: context.totalSize,
    fileCount: context.filesInContext.size,
    symbolCount: context.symbolIndex.size,
    budgetUsed: context.budgetUsed,
    intentType: context.intent.type,
  };
}

/** Find symbol across all context files */
export function findSymbolInContext(context: SmartContext, symbolName: string): {
  file: string;
  symbol: CodeSymbol;
} | undefined {
  // Exact match
  const exact = context.symbolIndex.get(symbolName);
  if (exact) return exact;

  // Case-insensitive search
  const lowerName = symbolName.toLowerCase();
  for (const [name, entry] of context.symbolIndex.entries()) {
    if (name.toLowerCase() === lowerName) {
      return entry;
    }
  }

  // Partial match
  for (const [name, entry] of context.symbolIndex.entries()) {
    if (name.toLowerCase().includes(lowerName) || lowerName.includes(name.toLowerCase())) {
      return entry;
    }
  }

  return undefined;
}

/** Get files related to a specific symbol */
export function getFilesForSymbol(context: SmartContext, symbolName: string): string[] {
  const files: string[] = [];

  // Check active file
  if (context.activeFile?.symbols.some(s => s.name.includes(symbolName))) {
    files.push(context.activeFile.path);
  }

  // Check related files
  for (const file of context.relatedFiles) {
    if (file.symbols.some(s => s.name.includes(symbolName))) {
      files.push(file.path);
    }
  }

  return files;
}

/** Preload files into cache (call on workspace open) */
export async function preloadContextCache(paths: string[]): Promise<void> {
  const promises = paths
    .filter(p => isCodeFile(p) && !isExcluded(p))
    .slice(0, 50)
    .map(p => getCachedFile(p));

  await Promise.all(promises);
}

/** Get cache statistics */
export function getCacheStats(): { entries: number; totalSize: number } {
  let totalSize = 0;
  for (const entry of fileCache.values()) {
    totalSize += entry.size;
  }
  return { entries: fileCache.size, totalSize };
}
