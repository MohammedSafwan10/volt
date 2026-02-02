/**
 * Diff View Service - Monaco DiffEditor integration
 * 
 * Two modes:
 * 1. openDiffView() - Quick highlight mode (green background on changed lines)
 * 2. openFullDiffView() - Full Monaco DiffEditor with red/green inline diff (VS Code style)
 */

import { editorStore } from '$lib/stores/editor.svelte';
import { diffStore } from '$lib/stores/diff.svelte';
import { setReviewHighlight, clearReviewHighlight, revealLine, getActiveEditor } from '$lib/services/monaco-models';
import { detectLanguage } from '$lib/services/monaco-loader';

export interface DiffViewOptions {
  /** File path (absolute or relative) */
  path: string;
  /** Absolute path for opening the file */
  absolutePath?: string;
  /** First changed line number */
  firstChangedLine?: number;
  /** Last changed line number */
  lastChangedLine?: number;
  /** Original content (for combined diffs) */
  originalContent?: string;
  /** Tool call IDs (for combined diffs) */
  toolCallIds?: string[];
}

export interface FullDiffViewOptions {
  /** File path for title and language detection */
  filePath: string;
  /** Original content (before changes) - shows as RED */
  originalContent: string;
  /** Modified content (after changes) - shows as GREEN */
  modifiedContent: string;
  /** Optional language override */
  language?: string;
  /** Optional title override */
  title?: string;
  /** Tool call ID for tracking */
  toolCallId?: string;
  /** Whether to start in inline mode (default: true) */
  inlineMode?: boolean;
}

// Track which tool calls have active highlights
const activeHighlights = new Map<string, string>(); // toolCallId -> filePath

/**
 * Open full Monaco DiffEditor with proper red/green inline diff
 * This is the VS Code Copilot style diff view
 * 
 * - Deleted lines show in RED
 * - Added lines show in GREEN
 * - Supports inline and side-by-side modes
 * - Navigation between changes
 * - Accept/Reject buttons
 */
export function openFullDiffView(options: FullDiffViewOptions): void {
  const fileName = options.filePath.split(/[/\\]/).pop() || 'file';
  const language = options.language || detectLanguage(options.filePath);
  
  diffStore.openDiff({
    filePath: options.filePath,
    originalContent: options.originalContent,
    modifiedContent: options.modifiedContent,
    language,
    title: options.title || `Changes: ${fileName}`,
    toolCallId: options.toolCallId,
    inlineMode: options.inlineMode ?? true,
  });
}

/**
 * Close the full diff view and return to normal editor
 */
export function closeFullDiffView(): void {
  diffStore.closeDiff();
}

/**
 * Check if full diff view is active
 */
export function isFullDiffViewActive(): boolean {
  return diffStore.isActive;
}

/**
 * Open a file and highlight the changed lines (Kiro-style diff view)
 * - Opens/focuses the actual file in the editor
 * - Highlights changed lines with green background
 * - Scrolls to the changed area
 * - Clicking again toggles the highlight off
 */
export async function openDiffView(options: DiffViewOptions, toolCallId?: string): Promise<void> {
  const { path, absolutePath, firstChangedLine, lastChangedLine, originalContent } = options;

  // Use absolute path if available, otherwise use relative path
  const filePath = absolutePath || path;

  // Check if this tool call already has an active highlight - toggle it off
  if (toolCallId && activeHighlights.has(toolCallId)) {
    const highlightedPath = activeHighlights.get(toolCallId)!;
    clearReviewHighlight(highlightedPath);
    activeHighlights.delete(toolCallId);
    return;
  }

  // Open or focus the file in the editor
  const openFile = editorStore.openFiles.find(f =>
    f.path === filePath ||
    f.path.endsWith('/' + path) ||
    f.path.endsWith('\\' + path) ||
    f.path === path
  );

  if (openFile) {
    // File is already open, focus it
    editorStore.setActiveFile(openFile.path);
  } else {
    // Open the file
    await editorStore.openFile(filePath);
  }

  // Wait for the editor to load the file and for the store to update
  await new Promise(resolve => setTimeout(resolve, 50));

  // Get the actual path used by the editor from the store to ensure we are highlighting the RIGHT model
  const activePath = editorStore.activeFile?.path;
  if (!activePath) {
    console.warn('[openDiffView] No active file found after opening:', filePath);
    return;
  }

  // For combined diffs with original content, compute the full diff range
  if (originalContent !== undefined) {
    const activeFileState = editorStore.activeFile!;
    const currentContent = activeFileState.content;
    const { startLine, endLine } = computeDiffRange(originalContent, currentContent);

    if (startLine > 0 && endLine >= startLine) {
      const success = setReviewHighlight(activePath, startLine, endLine);
      if (success && toolCallId) {
        activeHighlights.set(toolCallId, activePath);
      }
      revealLine(activePath, startLine);

      const editor = getActiveEditor();
      if (editor) editor.focus();
    }
    return;
  }

  // Apply highlight if we have line info
  if (typeof firstChangedLine === 'number' && typeof lastChangedLine === 'number') {
    const success = setReviewHighlight(activePath, firstChangedLine, lastChangedLine);

    if (success) {
      // Track this highlight
      if (toolCallId) {
        activeHighlights.set(toolCallId, activePath);
      }

      // Scroll to the changed area
      revealLine(activePath, firstChangedLine);

      // Focus the editor
      const editor = getActiveEditor();
      if (editor) {
        editor.focus();
      }
    }
  } else if (typeof firstChangedLine === 'number') {
    // Only have first line, highlight just that line
    const success = setReviewHighlight(activePath, firstChangedLine, firstChangedLine);
    if (success && toolCallId) {
      activeHighlights.set(toolCallId, activePath);
    }
    revealLine(activePath, firstChangedLine);
  }
}

/**
 * Compute the range of lines that differ between original and current content
 */
function computeDiffRange(original: string, current: string): { startLine: number; endLine: number } {
  const originalLines = original.split('\n');
  const currentLines = current.split('\n');

  // Find first differing line
  let startLine = 1;
  const minLen = Math.min(originalLines.length, currentLines.length);
  for (let i = 0; i < minLen; i++) {
    if (originalLines[i] !== currentLines[i]) {
      startLine = i + 1;
      break;
    }
    if (i === minLen - 1) {
      // All common lines match, diff starts after
      startLine = minLen + 1;
    }
  }

  // Find last differing line (from the end)
  let endLine = currentLines.length;
  let origEnd = originalLines.length - 1;
  let currEnd = currentLines.length - 1;

  while (origEnd >= startLine - 1 && currEnd >= startLine - 1) {
    if (originalLines[origEnd] !== currentLines[currEnd]) {
      endLine = currEnd + 1;
      break;
    }
    origEnd--;
    currEnd--;
    endLine = currEnd + 1;
  }

  // Ensure valid range
  if (endLine < startLine) {
    endLine = startLine;
  }

  return { startLine, endLine };
}

/**
 * Clear diff highlight for a specific tool call
 */
export function clearDiffHighlight(toolCallId: string): void {
  if (activeHighlights.has(toolCallId)) {
    const path = activeHighlights.get(toolCallId)!;
    clearReviewHighlight(path);
    activeHighlights.delete(toolCallId);
  }
}

/**
 * Check if a tool call has an active highlight
 */
export function hasActiveHighlight(toolCallId: string): boolean {
  return activeHighlights.has(toolCallId);
}

// Re-export for convenience
export { clearReviewHighlight } from '$lib/services/monaco-models';
