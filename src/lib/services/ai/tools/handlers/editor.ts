/**
 * Editor context tool handlers - get_active_file, get_selection, get_open_files
 */

import { editorStore } from '$lib/stores/editor.svelte';
import { truncateOutput, formatWithLineNumbers, type ToolResult } from '../utils';

/**
 * Get currently active file in editor
 */
export async function handleGetActiveFile(): Promise<ToolResult> {
  const activeFile = editorStore.activeFile;
  
  if (!activeFile) {
    return { success: true, output: 'No file is currently open' };
  }
  
  const lines = activeFile.content.split('\n').length;
  const formatted = formatWithLineNumbers(activeFile.content);
  
  const { text, truncated } = truncateOutput(
    `${activeFile.path} (${lines} lines)\n${formatted}`
  );
  
  return { success: true, output: text, truncated };
}

/**
 * Get selected text in editor
 */
export async function handleGetSelection(): Promise<ToolResult> {
  // Dynamic import to avoid circular dependency
  const { getEditorSelection } = await import('$lib/services/monaco-models');
  const selection = getEditorSelection();

  if (!selection || !selection.text) {
    return { success: true, output: 'No text selected' };
  }

  const { text, truncated } = truncateOutput(
    `Selection from ${selection.path || 'unknown'}:\n${selection.text}`
  );

  return { success: true, output: text, truncated };
}

/**
 * Get list of open files/tabs
 */
export async function handleGetOpenFiles(): Promise<ToolResult> {
  const openFiles = editorStore.openFiles;
  
  if (openFiles.length === 0) {
    return { success: true, output: 'No files open' };
  }
  
  const activeFile = editorStore.activeFile;
  const lines = openFiles.map(f => {
    const isActive = f.path === activeFile?.path;
    const modified = editorStore.isDirty(f.path) ? ' (modified)' : '';
    return `${isActive ? '→ ' : '  '}${f.path}${modified}`;
  });
  
  return { 
    success: true, 
    output: `${openFiles.length} files open:\n${lines.join('\n')}` 
  };
}
