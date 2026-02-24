/**
 * Prettier Formatting Service
 * 
 * Provides document formatting using Prettier via backend run_command.
 * Respects workspace .prettierrc* configuration files.
 * 
 * Features:
 * - Format document command
 * - Format on save (optional)
 * - Supports TS/JS/TSX/JSX/JSON/CSS/HTML/Markdown
 * - Non-blocking async formatting
 */

import { invoke } from '@tauri-apps/api/core';
import { projectStore } from '$lib/stores/project.svelte';
import { editorStore } from '$lib/stores/editor.svelte';
import { showToast } from '$lib/stores/toast.svelte';
import { logOutput } from '$lib/stores/output.svelte';
import { getFileInfoQuiet, writeFile, deletePathQuiet } from '$lib/services/file-system';
import { getModelValue, setModelValue } from '$lib/services/monaco-models';

/** File extensions that Prettier can format */
const PRETTIER_EXTENSIONS = new Set([
  // JavaScript/TypeScript
  'js', 'mjs', 'cjs', 'jsx',
  'ts', 'mts', 'cts', 'tsx',
  // Web
  'html', 'htm',
  'css', 'scss', 'less',
  // Data formats
  'json', 'jsonc',
  'yaml', 'yml',
  // Markdown
  'md', 'mdx',
  // Svelte/Vue
  'svelte', 'vue',
  // GraphQL
  'graphql', 'gql'
]);

/** Prettier parser mapping for file extensions */
const PARSER_MAP: Record<string, string> = {
  // JavaScript/TypeScript
  'js': 'babel',
  'mjs': 'babel',
  'cjs': 'babel',
  'jsx': 'babel',
  'ts': 'typescript',
  'mts': 'typescript',
  'cts': 'typescript',
  'tsx': 'typescript',
  // Web
  'html': 'html',
  'htm': 'html',
  'css': 'css',
  'scss': 'scss',
  'less': 'less',
  // Data formats
  'json': 'json',
  'jsonc': 'json',
  'yaml': 'yaml',
  'yml': 'yaml',
  // Markdown
  'md': 'markdown',
  'mdx': 'mdx',
  // Svelte/Vue
  'svelte': 'svelte',
  'vue': 'vue',
  // GraphQL
  'graphql': 'graphql',
  'gql': 'graphql'
};

/**
 * Check if a file can be formatted by Prettier
 */
export function isPrettierFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return PRETTIER_EXTENSIONS.has(ext);
}

/**
 * Get the Prettier parser for a file extension
 */
function getParser(filepath: string): string | null {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return PARSER_MAP[ext] || null;
}

/**
 * Check if Prettier is available in the project
 */
async function isPrettierAvailable(): Promise<boolean> {
  const rootPath = projectStore.rootPath;
  if (!rootPath) return false;

  const sep = rootPath.includes('\\') ? '\\' : '/';
  
  // Check for prettier in node_modules
  const prettierPath = `${rootPath}${sep}node_modules${sep}.bin${sep}prettier`;
  const prettierInfo = await getFileInfoQuiet(prettierPath);
  
  // Also check for prettier.cmd on Windows
  if (!prettierInfo) {
    const prettierCmdPath = `${rootPath}${sep}node_modules${sep}.bin${sep}prettier.cmd`;
    const prettierCmdInfo = await getFileInfoQuiet(prettierCmdPath);
    return prettierCmdInfo !== null;
  }
  
  return prettierInfo !== null;
}

/**
 * Get the Prettier executable path
 */
function getPrettierPath(): string {
  const rootPath = projectStore.rootPath;
  if (!rootPath) return 'prettier';

  const sep = rootPath.includes('\\') ? '\\' : '/';
  
  // Use local prettier from node_modules
  // On Windows, use prettier.cmd
  const isWindows = navigator.platform.toLowerCase().includes('win');
  const binName = isWindows ? 'prettier.cmd' : 'prettier';
  
  return `${rootPath}${sep}node_modules${sep}.bin${sep}${binName}`;
}

/**
 * Format content using Prettier
 * 
 * @param content - The content to format
 * @param filepath - The file path (used for parser detection and config resolution)
 * @returns Formatted content or null if formatting failed
 */
export async function formatWithPrettier(
  content: string,
  filepath: string
): Promise<string | null> {
  const rootPath = projectStore.rootPath;
  
  // Check if file type is supported
  if (!isPrettierFile(filepath)) {
    logOutput('Prettier', `Unsupported file type: ${filepath}`);
    return null;
  }

  const parser = getParser(filepath);
  if (!parser) {
    logOutput('Prettier', `No parser found for: ${filepath}`);
    return null;
  }

  // Check if Prettier is available
  const available = await isPrettierAvailable();
  if (!available) {
    logOutput('Prettier', 'Prettier not found in project. Install with: npm install -D prettier');
    showToast({
      message: 'Prettier not found. Install with: npm install -D prettier',
      type: 'warning'
    });
    return null;
  }

  try {
    logOutput('Prettier', `Formatting ${filepath} with parser: ${parser}`);
    
    const prettierPath = getPrettierPath();

    // Write a temp file alongside the target file, run prettier on that file via
    // backend run_command, and read formatted content from stdout.

    const lastSlash = Math.max(filepath.lastIndexOf('/'), filepath.lastIndexOf('\\'));
    const sep = lastSlash >= 0 ? filepath[lastSlash] : (rootPath?.includes('\\') ? '\\' : '/');
    const dir = lastSlash >= 0 ? filepath.slice(0, lastSlash) : (rootPath || '.');
    const ext = filepath.split('.').pop()?.toLowerCase() || 'txt';
    const tempPath = `${dir}${sep}.volt-prettier-${crypto.randomUUID()}.${ext}`;

    let wroteTemp = false;
    try {
      const ok = await writeFile(tempPath, content);
      if (!ok) return null;
      wroteTemp = true;

      // Build command arguments
      const args = ['--parser', parser, tempPath];

      const result = await invoke<{
        exit_code: number;
        stdout: string;
        stderr: string;
      }>('run_command', {
        command: prettierPath,
        args,
        cwd: rootPath || undefined,
      });

      if ((result.exit_code ?? 0) !== 0) {
        logOutput('Prettier', `Formatting failed: ${result.stderr}`);
        showToast({
          message: 'Formatting failed. Check Output panel for details.',
          type: 'error'
        });
        return null;
      }

      logOutput('Prettier', `Formatted successfully`);
      return String(result.stdout ?? '');
    } finally {
      if (wroteTemp) {
        await deletePathQuiet(tempPath);
      }
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logOutput('Prettier', `Error: ${message}`);
    console.error('[Prettier] Formatting error:', error);
    showToast({
      message: 'Formatting failed. Check Output panel for details.',
      type: 'error'
    });
    return null;
  }

}

/**
 * Format the current document in the editor
 * This is called from the command palette or menu
 */
export async function formatCurrentDocument(): Promise<boolean> {
  const activeFile = editorStore.activeFile;
  if (!activeFile) {
    showToast({
      message: 'No file open to format',
      type: 'info'
    });
    return false;
  }

  // Get the latest content from Monaco model
  const content = getModelValue(activeFile.path) ?? activeFile.content;
  
  // Format the content
  const formatted = await formatWithPrettier(content, activeFile.path);
  if (formatted === null) {
    return false;
  }

  // Check if content actually changed
  if (formatted === content) {
    showToast({
      message: 'Document already formatted',
      type: 'info'
    });
    return true;
  }

  // Update the Monaco model
  setModelValue(activeFile.path, formatted);
  
  // Update the editor store
  editorStore.updateContent(activeFile.path, formatted);

  showToast({
    message: 'Document formatted',
    type: 'success'
  });

  return true;
}

/**
 * Format content before saving (for format on save feature)
 * Returns the formatted content or the original if formatting fails
 */
export async function formatBeforeSave(
  content: string,
  filepath: string
): Promise<string> {
  if (!isPrettierFile(filepath)) {
    return content;
  }

  const formatted = await formatWithPrettier(content, filepath);
  return formatted ?? content;
}
