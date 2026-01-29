/**
 * Shared utilities for tool handlers
 */

import { projectStore } from '$lib/stores/project.svelte';

// Maximum output size (100KB)
export const MAX_OUTPUT_SIZE = 100 * 1024;

/**
 * Truncate output if too large
 */
export function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_SIZE) {
    return { text: output, truncated: false };
  }
  return {
    text: output.slice(0, MAX_OUTPUT_SIZE) + '\n\n[Output truncated - exceeded 100KB]',
    truncated: true
  };
}

/**
 * Extract error message from unknown error
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return 'Unknown error';
}

/**
 * Resolve relative path to absolute using workspace root
 */
export function resolvePath(relativePath: string): string {
  const root = projectStore.rootPath;
  if (!root) return relativePath;

  // Already absolute
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    return relativePath;
  }

  // Join with root
  const separator = root.includes('\\') ? '\\' : '/';
  return root.endsWith(separator) ? root + relativePath : root + separator + relativePath;
}

/**
 * Validate path is within workspace
 */
export function validatePathInWorkspace(path: string, workspaceRoot: string): { valid: boolean; absolutePath: string; error?: string } {
  if (!workspaceRoot) {
    return { valid: false, absolutePath: '', error: 'No workspace is open' };
  }

  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/');

  // Build absolute path
  let absolutePath: string;
  if (normalizedPath.startsWith('/') || /^[A-Za-z]:/.test(normalizedPath)) {
    absolutePath = normalizedPath;
  } else {
    absolutePath = normalizedRoot.endsWith('/')
      ? normalizedRoot + normalizedPath
      : normalizedRoot + '/' + normalizedPath;
  }

  // Normalize (resolve . and ..)
  const parts = absolutePath.split('/').filter(p => p !== '');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.') continue;
    else if (part === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  let finalPath: string;
  if (/^[A-Za-z]:$/.test(parts[0] || '')) {
    finalPath = resolved.join('/');
  } else {
    finalPath = '/' + resolved.join('/');
  }

  // Check if within workspace
  const normalizedFinal = finalPath.toLowerCase();
  const normalizedRootLower = normalizedRoot.toLowerCase();
  const rootWithSlash = normalizedRootLower.endsWith('/') ? normalizedRootLower : normalizedRootLower + '/';
  const isWithin = normalizedFinal === normalizedRootLower || normalizedFinal.startsWith(rootWithSlash);

  if (!isWithin) {
    return { valid: false, absolutePath: finalPath, error: `Path "${path}" is outside workspace` };
  }

  return { valid: true, absolutePath: finalPath };
}

/**
 * Compare paths for equality (handles different separators)
 */
export function isSameOrSuffixPath(openPath: string, absPath: string, relPath: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const openNorm = normalize(openPath);
  const absNorm = normalize(absPath);
  const relNorm = normalize(relPath);

  if (openNorm === absNorm || openNorm === relNorm) return true;

  const relSuffix = '/' + relNorm.replace(/^\/+/, '');
  if (openNorm.endsWith(relSuffix)) return true;
  if (openNorm.endsWith(relNorm) && (openNorm.length === relNorm.length || openNorm[openNorm.length - relNorm.length - 1] === '/')) {
    return true;
  }

  return false;
}

/**
 * Format file content with line numbers
 */
export function formatWithLineNumbers(content: string, startLine: number = 1): string {
  const lines = content.split('\n');
  const maxLineNum = startLine + lines.length - 1;
  const padding = String(maxLineNum).length;

  return lines
    .map((line, i) => {
      const lineNum = String(startLine + i).padStart(padding, ' ');
      return `${lineNum}│${line}`;
    })
    .join('\n');
}

/**
 * Tool result type
 */
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  truncated?: boolean;
  meta?: Record<string, any>;
  data?: any;
  tool?: string;
  code?: string;
  retryable?: boolean;
  timestamp?: number;
}
