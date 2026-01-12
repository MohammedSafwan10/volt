/**
 * Diff View Service - Highlights changed lines in the editor (Kiro-style)
 * Opens the actual file and highlights the changed area with green background
 */

import { editorStore } from '$lib/stores/editor.svelte';
import { setReviewHighlight, clearReviewHighlight, revealLine, getActiveEditor } from '$lib/services/monaco-models';

export interface DiffViewOptions {
  /** File path (absolute or relative) */
  path: string;
  /** Absolute path for opening the file */
  absolutePath?: string;
  /** First changed line number */
  firstChangedLine?: number;
  /** Last changed line number */
  lastChangedLine?: number;
}

// Track which tool calls have active highlights
const activeHighlights = new Map<string, string>(); // toolCallId -> filePath

/**
 * Open a file and highlight the changed lines (Kiro-style diff view)
 * - Opens/focuses the actual file in the editor
 * - Highlights changed lines with green background
 * - Scrolls to the changed area
 * - Clicking again toggles the highlight off
 */
export async function openDiffView(options: DiffViewOptions, toolCallId?: string): Promise<void> {
  const { path, absolutePath, firstChangedLine, lastChangedLine } = options;
  
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
    // File is already open, just focus it
    editorStore.setActiveFile(openFile.path);
  } else {
    // Open the file
    await editorStore.openFile(filePath);
  }
  
  // Wait a bit for the editor to load the file
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Get the actual path used by the editor
  const activeFile = editorStore.activeFile;
  if (!activeFile) return;
  
  // Apply highlight if we have line info
  if (typeof firstChangedLine === 'number' && typeof lastChangedLine === 'number') {
    const success = setReviewHighlight(activeFile.path, firstChangedLine, lastChangedLine);
    
    if (success) {
      // Track this highlight
      if (toolCallId) {
        activeHighlights.set(toolCallId, activeFile.path);
      }
      
      // Scroll to the changed area
      revealLine(activeFile.path, firstChangedLine);
      
      // Focus the editor
      const editor = getActiveEditor();
      if (editor) {
        editor.focus();
      }
    }
  } else if (typeof firstChangedLine === 'number') {
    // Only have first line, highlight just that line
    const success = setReviewHighlight(activeFile.path, firstChangedLine, firstChangedLine);
    if (success && toolCallId) {
      activeHighlights.set(toolCallId, activeFile.path);
    }
    revealLine(activeFile.path, firstChangedLine);
  }
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
