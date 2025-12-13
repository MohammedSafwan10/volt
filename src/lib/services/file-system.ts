/**
 * TypeScript wrapper for Rust file commands
 * Provides file system operations with proper error handling and toast notifications
 */

import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { showToast } from '$lib/stores/toast.svelte';
import { logOutput } from '$lib/stores/output.svelte';
import {
  type FileEntry,
  type FileInfo,
  type FileError,
  isFileError,
  getFileErrorMessage
} from '$lib/types/files';

interface ListDirDetailedResult {
  entries: FileEntry[];
  skipped: FileError[];
}

function formatSkippedListErrors(skipped: FileError[]): string {
  const counts = new Map<string, number>();
  for (const e of skipped) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}: ${count}`);

  return `Skipped ${skipped.length} item${skipped.length === 1 ? '' : 's'} (${parts.join(', ')})`;
}

/**
 * Handle errors from Rust commands
 * Shows toast notification and logs technical details
 * Returns null to indicate failure without throwing
 */
function handleError(
  error: unknown,
  operation: string,
  retry?: () => unknown | Promise<unknown>
): null {
  let userMessage: string;
  let showRetry = false;

  if (isFileError(error)) {
    userMessage = getFileErrorMessage(error);
    showRetry = error.type === 'FileLocked';
  } else if (error instanceof Error) {
    userMessage = `${operation} failed: ${error.message}`;
  } else {
    userMessage = `${operation} failed`;
  }

  // Log technical details for debugging
  console.error(`[FileSystem] ${operation} error:`, error);

  const shouldShowRetry = showRetry || Boolean(retry);

  // Show toast notification
  showToast({
    message: userMessage,
    type: 'error',
    action: shouldShowRetry
      ? {
          label: 'Retry',
          onClick: () => {
            try {
              if (retry) {
                void retry();
              } else {
                console.log('[FileSystem] Retry requested');
              }
            } catch (retryError) {
              console.error('[FileSystem] Retry handler error:', retryError);
            }
          }
        }
      : undefined
  });

  return null;
}

/**
 * Read file contents as UTF-8 string
 */
export async function readFile(path: string): Promise<string | null> {
  try {
    logOutput('File System', `Reading file: ${path}`);
    const content = await invoke<string>('read_file', { path });
    logOutput('File System', `Read ${content.length} bytes from ${path}`);
    return content;
  } catch (error) {
    logOutput('File System', `Error reading file: ${path}`);
    return handleError(error, 'Read file');
  }
}

/**
 * Write content to file (creates if not exists, overwrites if exists)
 */
export async function writeFile(
  path: string,
  content: string
): Promise<boolean> {
  try {
    logOutput('File System', `Writing file: ${path}`);
    await invoke('write_file', { path, content });
    logOutput('File System', `Wrote ${content.length} bytes to ${path}`);
    return true;
  } catch (error) {
    logOutput('File System', `Error writing file: ${path}`);
    handleError(error, 'Write file', () => writeFile(path, content));
    return false;
  }
}

/**
 * List directory contents
 */
export async function listDirectory(
  path: string
): Promise<FileEntry[] | null> {
  try {
    logOutput('File System', `Listing directory: ${path}`);
    const result = await invoke<ListDirDetailedResult>('list_dir_detailed', { path });

    if (Array.isArray(result.skipped) && result.skipped.length > 0) {
      console.warn('[FileSystem] Some directory entries were skipped:', {
        path,
        skipped: result.skipped
      });
      logOutput('File System', formatSkippedListErrors(result.skipped));
      showToast({
        message: formatSkippedListErrors(result.skipped),
        type: 'warning'
      });
    }

    logOutput('File System', `Listed ${result.entries.length} entries in ${path}`);
    return result.entries;
  } catch (error) {
    logOutput('File System', `Error listing directory: ${path}`);
    return handleError(error, 'List directory', () => listDirectory(path));
  }
}

/**
 * Create a new empty file
 */
export async function createFile(path: string): Promise<boolean> {
  try {
    await invoke('create_file', { path });
    showToast({
      message: 'File created',
      type: 'success'
    });
    return true;
  } catch (error) {
    handleError(error, 'Create file', () => createFile(path));
    return false;
  }
}

/**
 * Create a new directory
 */
export async function createDirectory(path: string): Promise<boolean> {
  try {
    await invoke('create_dir', { path });
    showToast({
      message: 'Folder created',
      type: 'success'
    });
    return true;
  } catch (error) {
    handleError(error, 'Create folder', () => createDirectory(path));
    return false;
  }
}

/**
 * Delete a file or directory
 */
export async function deletePath(path: string): Promise<boolean> {
  try {
    await invoke('delete_path', { path });
    showToast({
      message: 'Deleted successfully',
      type: 'success'
    });
    return true;
  } catch (error) {
    handleError(error, 'Delete', () => deletePath(path));
    return false;
  }
}

/**
 * Rename/move a file or directory
 */
export async function renamePath(
  oldPath: string,
  newPath: string
): Promise<boolean> {
  try {
    // Tauri command args are camelCased (oldPath/newPath)
    await invoke('rename_path', { oldPath, newPath });
    return true;
  } catch (error) {
    handleError(error, 'Rename', () => renamePath(oldPath, newPath));
    return false;
  }
}

/**
 * Get detailed file information
 */
export async function getFileInfo(path: string): Promise<FileInfo | null> {
  try {
    return await invoke<FileInfo>('get_file_info', { path });
  } catch (error) {
    return handleError(error, 'Get file info', () => getFileInfo(path));
  }
}

/**
 * Get detailed file information, but treat NotFound as a normal "null" result
 * and do not show toast notifications.
 *
 * This is useful for probing existence (e.g. lockfile/package manager detection)
 * without spamming the user.
 */
export async function getFileInfoQuiet(path: string): Promise<FileInfo | null> {
  try {
    return await invoke<FileInfo>('get_file_info', { path });
  } catch (error) {
    if (isFileError(error) && error.type === 'NotFound') {
      return null;
    }

    console.error(`[FileSystem] Get file info (quiet) error for ${path}:`, error);
    logOutput('File System', `Get file info (quiet) error: ${path}`);
    return null;
  }
}

// ============================================================================
// Dialog Functions (using Tauri dialog plugin)
// ============================================================================

/**
 * Open system file picker dialog
 * Returns selected file path or null if cancelled
 */
export async function openFileDialog(): Promise<string | null> {
  try {
    const result = await open({
      multiple: false,
      directory: false
    });

    // Result is string | string[] | null
    if (result === null) {
      return null;
    }

    return typeof result === 'string' ? result : result[0] ?? null;
  } catch (error) {
    handleError(error, 'Open file dialog');
    return null;
  }
}

/**
 * Open system folder picker dialog
 * Returns selected folder path or null if cancelled
 */
export async function openFolderDialog(): Promise<string | null> {
  try {
    const result = await open({
      multiple: false,
      directory: true
    });

    // Result is string | string[] | null
    if (result === null) {
      return null;
    }

    return typeof result === 'string' ? result : result[0] ?? null;
  } catch (error) {
    handleError(error, 'Open folder dialog');
    return null;
  }
}

/**
 * Open system save file dialog
 * Returns selected save path or null if cancelled
 */
export async function saveFileDialog(
  defaultName?: string
): Promise<string | null> {
  try {
    const result = await save({
      defaultPath: defaultName
    });

    return result;
  } catch (error) {
    handleError(error, 'Save file dialog');
    return null;
  }
}
