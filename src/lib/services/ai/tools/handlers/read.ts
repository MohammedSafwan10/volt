/**
 * Read tool handlers - read_file, read_files, list_dir, get_file_tree, get_file_info
 */

import { invoke } from '@tauri-apps/api/core';
import { resolvePath, truncateOutput, extractErrorMessage, formatWithLineNumbers, type ToolResult } from '../utils';

/**
 * Read a single file with optional line range
 * Kiro-style: includes line numbers in output
 */
export async function handleReadFile(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  
  let content: string;
  try {
    content = await invoke<string>('read_file', { path });
  } catch (err) {
    return { success: false, error: `File not found: ${relativePath}` };
  }
  
  const totalLines = content.split('\n').length;
  
  // Handle line range - accept both snake_case and camelCase
  let startLine = Number(args.start_line ?? args.startLine) || 1;
  let endLine = Number(args.end_line ?? args.endLine) || totalLines;
  
  startLine = Math.max(1, startLine);
  endLine = Math.min(endLine, totalLines);
  
  let output = content;
  if (startLine > 1 || endLine < totalLines) {
    const lines = content.split('\n');
    output = lines.slice(startLine - 1, endLine).join('\n');
  }
  
  // Format with line numbers (Kiro-style)
  const formatted = formatWithLineNumbers(output, startLine);
  
  // Add header
  const header = startLine === 1 && endLine === totalLines
    ? `${relativePath} (${totalLines} lines)\n`
    : `${relativePath} lines ${startLine}-${endLine} of ${totalLines}\n`;
  
  const { text, truncated } = truncateOutput(header + formatted);
  
  return { 
    success: true, 
    output: text, 
    truncated,
    meta: { startLine, endLine, totalLines }
  };
}

/**
 * Read multiple files at once
 */
export async function handleReadFiles(args: Record<string, unknown>): Promise<ToolResult> {
  const paths = args.paths as string[] | undefined;
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return { success: false, error: 'No paths provided' };
  }
  
  const results: string[] = [];
  let totalLines = 0;
  
  for (const relativePath of paths) {
    const path = resolvePath(relativePath);
    try {
      const content = await invoke<string>('read_file', { path });
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
 * Get file tree structure
 */
export async function handleGetFileTree(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path || '.');
  const depth = Number(args.depth) || 3;
  const path = resolvePath(relativePath);
  
  try {
    const tree = await invoke<string>('get_file_tree', { path, depth });
    return { success: true, output: tree };
  } catch (err) {
    return { success: false, error: `Cannot get tree: ${relativePath}` };
  }
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
