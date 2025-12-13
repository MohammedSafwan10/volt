/**
 * TypeScript types for file system operations
 * Mirrors Rust types from src-tauri/src/commands/file_ops.rs
 */

/**
 * File entry returned from directory listing
 */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
}

/**
 * Detailed file information
 */
export interface FileInfo {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  isReadonly: boolean;
  size: number;
  created: number | null;
  modified: number | null;
  accessed: number | null;
}

/**
 * Typed error from Rust file operations
 * Uses discriminated union based on 'type' field
 */
export type FileErrorType =
  | 'NotFound'
  | 'PermissionDenied'
  | 'FileLocked'
  | 'PathTooLong'
  | 'InvalidPath'
  | 'IoError';

export interface FileError {
  type: FileErrorType;
  path?: string;
  message?: string;
}

/**
 * Check if an error is a FileError
 */
export function isFileError(error: unknown): error is FileError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof (error as FileError).type === 'string'
  );
}

/**
 * Get user-friendly error message from FileError
 */
export function getFileErrorMessage(error: FileError): string {
  switch (error.type) {
    case 'NotFound':
      return `File not found: ${error.path || 'unknown path'}`;
    case 'PermissionDenied':
      return `Permission denied: ${error.path || 'unknown path'}`;
    case 'FileLocked':
      return `File is open in another program: ${error.path || 'unknown path'}`;
    case 'PathTooLong':
      return `Path is too long: ${error.path || 'unknown path'}`;
    case 'InvalidPath':
      return `Invalid path: ${error.path || 'unknown path'}`;
    case 'IoError':
      return error.message || 'An I/O error occurred';
    default:
      return 'An unknown error occurred';
  }
}
