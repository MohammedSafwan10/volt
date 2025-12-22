/**
 * Smart Context Service 2.0
 * Automatically gathers relevant IDE state for AI requests with query-awareness
 */

import { editorStore } from '$lib/stores/editor.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { assistantStore } from '$lib/stores/assistant.svelte';
import { activityStore } from '$lib/stores/activity.svelte';
import { terminalStore } from '$lib/stores/terminal.svelte';
import { readFile } from '$lib/services/file-system';

export interface SmartContext {
  activeFile?: {
    path: string;
    content: string;
    cursorLine?: number;
    cursorColumn?: number;
    selection?: string;
  };
  relatedFiles: Array<{
    path: string;
    content: string;
    reason: string;
    score?: number;
  }>;
  recentFiles: string[];
  openTabs: string[];
  openTabsContent?: Array<{
    path: string;
    content: string;
    isDirty: boolean;
  }>;
  terminalHistory?: string;
  workspaceRoot?: string;
  focusedSymbols?: string[];
}

/**
 * Smart Truncation: Keeps imports, exports, cursor context, and matching lines.
 * Truncates repetitive or long function bodies to save context space.
 */
function telescopeContent(content: string, query?: string, cursorLine?: number): string {
  const lines = content.split('\n');
  if (lines.length <= 150) return content;

  const keepLines = new Set<number>();

  // Always keep first 20 lines (imports)
  for (let i = 0; i < Math.min(lines.length, 20); i++) keepLines.add(i);

  // Always keep last 5 lines
  for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) keepLines.add(i);

  // Keep cursor context (+/- 30 lines)
  if (cursorLine !== undefined) {
    const start = Math.max(0, cursorLine - 30);
    const end = Math.min(lines.length, cursorLine + 30);
    for (let i = start; i < end; i++) keepLines.add(i);
  }

  // Keep query matches (+/- 5 lines)
  if (query) {
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 3);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (keywords.some(k => line.includes(k))) {
        const start = Math.max(0, i - 5);
        const end = Math.min(lines.length, i + 5);
        for (let j = start; j < end; j++) keepLines.add(j);
      }
    }
  }

  // Keep major symbol definitions (class, function, interface, export)
  const symbolRegex = /^(export\s+)?(class|function|interface|const|let|var|async|type|enum)\s+([a-zA-Z0-9_]+)/;
  for (let i = 0; i < lines.length; i++) {
    if (symbolRegex.test(lines[i].trim())) {
      keepLines.add(i);
      // Also keep the next line if it's the start of a block
      if (lines[i + 1]?.trim().startsWith('{')) keepLines.add(i + 1);
    }
  }

  // Reconstruct with truncation markers
  let result = '';
  let gapStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (keepLines.has(i)) {
      if (gapStart !== -1) {
        const gapSize = i - gapStart;
        result += `\n... [Truncated ${gapSize} lines] ...\n\n`;
        gapStart = -1;
      }
      result += lines[i] + '\n';
    } else {
      if (gapStart === -1) gapStart = i;
    }
  }

  if (gapStart !== -1) {
    result += `\n... [Truncated ${lines.length - gapStart} lines] ...\n`;
  }

  return result.trim();
}

/**
 * Score relevance of a string against a query
 */
function scoreRelevance(text: string, query: string): number {
  if (!query) return 0;
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 3);
  let score = 0;
  const lowerText = text.toLowerCase();

  for (const keyword of keywords) {
    const regex = new RegExp(keyword, 'g');
    const matches = lowerText.match(regex);
    if (matches) {
      score += matches.length;
    }
  }
  return score;
}

/**
 * Resolve dependencies from file content (regex-based)
 * Supports $lib and relative paths
 */
function resolveDependencies(content: string, currentPath: string, workspaceRoot?: string): string[] {
  const deps = new Set<string>();

  const importRegex = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const path = match[1];
    if (path.startsWith('.') || path.startsWith('$lib')) deps.add(path);
  }
  while ((match = requireRegex.exec(content)) !== null) {
    const path = match[1];
    if (path.startsWith('.') || path.startsWith('$lib')) deps.add(path);
  }

  const results: string[] = [];
  const dir = currentPath.substring(0, Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\')) + 1);
  const sep = currentPath.includes('\\') ? '\\' : '/';

  for (let dep of deps) {
    let resolved = '';

    if (dep.startsWith('$lib') && workspaceRoot) {
      // Resolve $lib to src/lib
      resolved = workspaceRoot + sep + 'src' + sep + 'lib' + dep.slice(4).replace(/\//g, sep);
    } else if (dep.startsWith('.')) {
      resolved = dir + dep.replace(/\//g, sep);
    } else {
      continue;
    }

    // Clean up path
    resolved = resolved.replace(/[/\\]\.\//g, sep);

    // Guess extension
    if (!resolved.split(sep).pop()?.includes('.')) {
      if (currentPath.endsWith('.ts')) resolved += '.ts';
      else if (currentPath.endsWith('.svelte')) resolved += '.svelte';
      else resolved += '.js';
    }

    results.push(resolved);
  }

  return results;
}

/**
 * Gather terminal context from all active sessions
 */
function getTerminalContext(): string {
  const sessions = terminalStore.sessions;
  if (sessions.length === 0) return '';

  let output = '=== Terminal History ===\n';
  for (const session of sessions) {
    output += `\n[Terminal: ${session.id}]\n`;
    output += session.getRecentOutput(5000); // Get last 5k chars
    output += '\n';
  }
  return output;
}

/**
 * Gather current IDE state into a formatted context block
 */
export async function getSmartContext(query?: string): Promise<SmartContext> {
  const activeFile = editorStore.activeFile;
  const relatedFiles: SmartContext['relatedFiles'] = [];
  const workspaceRoot = projectStore.rootPath ?? undefined;

  const MAX_CONTEXT_CHARS = 100_000;
  let currentChars = 0;

  // 0. EXCLUDE SENSITIVE AI LOGIC (Prevent internal leaks unless explicitly debugged)
  const EXCLUDED_FILES = [
    'src/lib/services/ai/',
    'src/lib/stores/assistant.svelte.ts',
    '.gemini/',
    '.kiro/'
  ];

  const isExcluded = (path: string) => EXCLUDED_FILES.some(f => path.includes(f));

  // 1. Terminal History (if query looks like it's about errors or execution)
  let terminalHistory = '';
  if (query && (query.includes('error') || query.includes('terminal') || query.includes('run') || query.includes('build'))) {
    terminalHistory = getTerminalContext();
    currentChars += terminalHistory.length;
  }

  // 2. Active File
  if (activeFile) {
    const cursor = editorStore.cursorPosition;
    const content = telescopeContent(activeFile.content, query, cursor.line);
    currentChars += content.length;

    const depPaths = resolveDependencies(activeFile.content, activeFile.path, workspaceRoot);

    for (const path of depPaths.slice(0, 5)) {
      if (isExcluded(path)) continue;

      const openFile = editorStore.openFiles.find(f => f.path === path);
      if (openFile) {
        const fileContent = telescopeContent(openFile.content, query);
        relatedFiles.push({ path, content: fileContent, reason: 'Imported by active file' });
        currentChars += fileContent.length;
      } else {
        try {
          const content = await readFile(path);
          if (content) {
            relatedFiles.push({ path, content, reason: 'Imported by active file' });
            currentChars += content.length;
          }
        } catch { /* ignore */ }
      }
    }
  }

  // 3. Other Open Tabs (Query-Aware Priority)
  const tabsWithScores = editorStore.openFiles
    .filter(f => f.path !== activeFile?.path)
    .map(f => ({
      file: f,
      score: query ? scoreRelevance(f.content + f.path, query) : 0
    }))
    .sort((a, b) => b.score - a.score);

  const openTabsContent: Array<{ path: string; content: string; isDirty: boolean }> = [];

  for (const { file } of tabsWithScores) {
    if (isExcluded(file.path)) continue; // Don't leak AI internal logic

    const content = telescopeContent(file.content, query);
    if (currentChars + content.length < MAX_CONTEXT_CHARS) {
      openTabsContent.push({
        path: file.path,
        content: content,
        isDirty: file.content !== file.originalContent
      });
      currentChars += content.length;
    } else {
      break;
    }
  }

  return {
    activeFile: activeFile ? {
      path: activeFile.path,
      content: telescopeContent(activeFile.content, query, editorStore.cursorPosition.line),
      cursorLine: editorStore.cursorPosition.line,
      cursorColumn: editorStore.cursorPosition.column
    } : undefined,
    relatedFiles,
    recentFiles: activityStore.recentPaths,
    openTabs: editorStore.openFiles.map(f => f.path),
    openTabsContent,
    terminalHistory,
    workspaceRoot
  };
}

/**
 * Format the smart context into a string for the AI prompt
 */
export function formatSmartContext(context: SmartContext): string {
  let output = '<smart_context>\n';

  if (context.workspaceRoot) {
    output += `Workspace Root: ${context.workspaceRoot}\n`;
  }

  if (context.terminalHistory) {
    output += `\n${context.terminalHistory}\n`;
  }

  if (context.activeFile) {
    output += `\n[Active File: ${context.activeFile.path}]\n`;
    if (context.activeFile.cursorLine) {
      output += `Cursor: Line ${context.activeFile.cursorLine}, Col ${context.activeFile.cursorColumn}\n`;
    }
    output += '```\n';
    output += context.activeFile.content;
    output += '\n```\n';
  }

  if (context.openTabsContent && context.openTabsContent.length > 0) {
    output += '\n[Open Files (Prioritized by relevance)]\n';
    for (const file of context.openTabsContent) {
      output += `\nFile: ${file.path} ${file.isDirty ? '(Unsaved)' : ''}\n`;
      output += '```\n';
      output += file.content;
      output += '\n```\n';
    }
  }

  if (context.relatedFiles.length > 0) {
    output += '\n[Imported Logic (Sampled)]\n';
    for (const file of context.relatedFiles) {
      if (context.openTabsContent?.some(f => f.path === file.path)) continue;

      output += `\nFile: ${file.path} (${file.reason})\n`;
      output += '```\n';
      const lines = file.content.split('\n');
      output += lines.slice(0, 150).join('\n') + (lines.length > 150 ? '\n... [Truncated] ...' : '') + '\n';
      output += '```\n';
    }
  }

  output += '</smart_context>\n\n';
  output += `**CRITICAL INSTRUCTIONS FOR CONTEXT HANDLING:**
1. This context is INTERNAL REFERENCE ONLY. NEVER echo, quote, or summarize it to the user.
2. If the user sends a short message like "go", "start", "yes", or "ok", these are CONFIRMATIONS to BEGIN WORKING, not prompts to be continued.
3. DO NOT attempt to complete incomplete sentences or phrases from the user. Interpret them as commands to proceed.
4. Your response should focus on the TASK at hand, NOT on describing the context you received.`;
  return output;
}
