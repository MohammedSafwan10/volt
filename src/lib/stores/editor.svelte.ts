/**
 * Editor state store using Svelte 5 runes
 * Manages open files, active file, and file content
 */

import { readFile } from '$lib/services/file-system';
import { disposeAllModels, disposeModel } from '$lib/services/monaco-models';
import { notifyFileClosed } from '$lib/services/lsp/client';
import {
  isTsJsFile,
  notifyDocumentClosed as notifyTsDocumentClosed,
  notifyDocumentSaved as notifyTsDocumentSaved
} from '$lib/services/lsp/typescript-sidecar';
import {
  isTailwindFile,
  notifyTailwindDocumentClosed,
  notifyTailwindDocumentSaved
} from '$lib/services/lsp/tailwind-sidecar';
import {
  isEslintFile,
  notifyEslintDocumentClosed,
  notifyEslintDocumentSaved
} from '$lib/services/lsp/eslint-sidecar';
import {
  isSvelteFile,
  notifySvelteDocumentClosed,
  notifySvelteDocumentSaved
} from '$lib/services/lsp/svelte-sidecar';

export interface OpenFile {
  /** Full file path (normalized with forward slashes) */
  path: string;
  /** File name (for display) */
  name: string;
  /** File content */
  content: string;
  /** Original content (for dirty detection) */
  originalContent: string;
  /** Language for syntax highlighting */
  language: string;
}

/**
 * Normalize file path to use forward slashes consistently.
 * This prevents duplicate tabs when the same file is opened with different slash styles.
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

class EditorStore {
  /** List of open files */
  openFiles = $state<OpenFile[]>([]);
  
  /** Path of the currently active file */
  activeFilePath = $state<string | null>(null);

  /** Get the currently active file */
  get activeFile(): OpenFile | null {
    if (!this.activeFilePath) return null;
    return this.openFiles.find(f => f.path === this.activeFilePath) ?? null;
  }

  /** Check if a file is dirty (has unsaved changes) */
  isDirty(path: string): boolean {
    const normalizedPath = normalizePath(path);
    const file = this.openFiles.find(f => f.path === normalizedPath);
    if (!file) return false;
    return file.content !== file.originalContent;
  }

  /** Check if any file is dirty */
  get hasUnsavedChanges(): boolean {
    return this.openFiles.some(f => f.content !== f.originalContent);
  }

  /**
   * Open a file in the editor
   * If already open, just switch to it
   */
  async openFile(path: string): Promise<boolean> {
    // Normalize path to prevent duplicate tabs with different slash styles
    const normalizedPath = normalizePath(path);
    
    // Check if already open
    const existing = this.openFiles.find(f => f.path === normalizedPath);
    if (existing) {
      this.activeFilePath = normalizedPath;
      return true;
    }

    // Read file content (use original path for file system access)
    const content = await readFile(path);
    if (content === null) {
      // Error already shown via toast in readFile
      return false;
    }

    // Extract filename
    const name = normalizedPath.split('/').pop() || normalizedPath;

    // Detect language from extension
    const language = this.detectLanguage(name);

    // Add to open files
    const newFile: OpenFile = {
      path: normalizedPath,
      name,
      content,
      originalContent: content,
      language
    };

    this.openFiles = [...this.openFiles, newFile];
    this.activeFilePath = normalizedPath;

    return true;
  }

  /**
   * Close a file
   * Returns false if file has unsaved changes and user cancels
   * Selects the nearest neighbor (prefer right, then left) when closing active tab
   */
  closeFile(path: string, force = false): boolean {
    const normalizedPath = normalizePath(path);
    const fileIndex = this.openFiles.findIndex(f => f.path === normalizedPath);
    if (fileIndex === -1) return true;

    const file = this.openFiles[fileIndex];

    // Check for unsaved changes
    if (!force && this.isDirty(normalizedPath)) {
      const confirmed = confirm(`"${file.name}" has unsaved changes. Close anyway?`);
      if (!confirmed) return false;
    }

    // Determine next active file before removing (VS Code behavior: prefer right neighbor, then left)
    let nextActivePath: string | null = null;
    if (this.activeFilePath === normalizedPath && this.openFiles.length > 1) {
      if (fileIndex < this.openFiles.length - 1) {
        // There's a tab to the right - select it
        nextActivePath = this.openFiles[fileIndex + 1].path;
      } else if (fileIndex > 0) {
        // No tab to the right, select the one to the left
        nextActivePath = this.openFiles[fileIndex - 1].path;
      }
    }

    // Remove from open files
    this.openFiles = this.openFiles.filter(f => f.path !== normalizedPath);
    disposeModel(normalizedPath);
    notifyFileClosed(file.language);
    
    // Notify TypeScript LSP sidecar about the file being closed
    if (isTsJsFile(normalizedPath)) {
      notifyTsDocumentClosed(normalizedPath);
    }
    
    // Notify Tailwind LSP sidecar about the file being closed
    if (isTailwindFile(normalizedPath)) {
      notifyTailwindDocumentClosed(normalizedPath);
    }
    
    // Notify ESLint LSP sidecar about the file being closed
    if (isEslintFile(normalizedPath)) {
      notifyEslintDocumentClosed(normalizedPath);
    }
    
    // Notify Svelte LSP sidecar about the file being closed
    if (isSvelteFile(normalizedPath)) {
      notifySvelteDocumentClosed(normalizedPath);
    }

    // Update active file
    if (this.activeFilePath === normalizedPath) {
      this.activeFilePath = nextActivePath;
    }

    return true;
  }

  /**
   * Close all files
   * Returns false if any file has unsaved changes and user cancels
   */
  closeAllFiles(force = false): boolean {
    if (!force && this.hasUnsavedChanges) {
      const confirmed = confirm('You have unsaved changes. Close all files anyway?');
      if (!confirmed) return false;
    }

    for (const file of this.openFiles) {
      notifyFileClosed(file.language);
      
      // Notify TypeScript LSP sidecar about the file being closed
      if (isTsJsFile(file.path)) {
        notifyTsDocumentClosed(file.path);
      }
      
      // Notify Tailwind LSP sidecar about the file being closed
      if (isTailwindFile(file.path)) {
        notifyTailwindDocumentClosed(file.path);
      }
      
      // Notify ESLint LSP sidecar about the file being closed
      if (isEslintFile(file.path)) {
        notifyEslintDocumentClosed(file.path);
      }
      
      // Notify Svelte LSP sidecar about the file being closed
      if (isSvelteFile(file.path)) {
        notifySvelteDocumentClosed(file.path);
      }
    }
    this.openFiles = [];
    this.activeFilePath = null;
    disposeAllModels();
    return true;
  }

  /**
   * Set the active file
   */
  setActiveFile(path: string): void {
    const normalizedPath = normalizePath(path);
    if (this.openFiles.some(f => f.path === normalizedPath)) {
      this.activeFilePath = normalizedPath;
    }
  }

  /**
   * Cycle to the next tab (Ctrl+Tab behavior)
   */
  nextTab(): void {
    if (this.openFiles.length <= 1) return;
    
    const currentIndex = this.openFiles.findIndex(f => f.path === this.activeFilePath);
    const nextIndex = (currentIndex + 1) % this.openFiles.length;
    this.activeFilePath = this.openFiles[nextIndex].path;
  }

  /**
   * Cycle to the previous tab (Ctrl+Shift+Tab behavior)
   */
  previousTab(): void {
    if (this.openFiles.length <= 1) return;
    
    const currentIndex = this.openFiles.findIndex(f => f.path === this.activeFilePath);
    const prevIndex = currentIndex <= 0 ? this.openFiles.length - 1 : currentIndex - 1;
    this.activeFilePath = this.openFiles[prevIndex].path;
  }

  /**
   * Update file content (called when editor content changes)
   */
  updateContent(path: string, content: string): void {
    const normalizedPath = normalizePath(path);
    const file = this.openFiles.find(f => f.path === normalizedPath);
    if (file) {
      file.content = content;
    }
  }

  /**
   * Mark file as saved (update original content to match current)
   */
  markSaved(path: string): void {
    const normalizedPath = normalizePath(path);
    const file = this.openFiles.find(f => f.path === normalizedPath);
    if (file) {
      file.originalContent = file.content;
      
      // Notify TypeScript LSP sidecar about the file being saved
      if (isTsJsFile(normalizedPath)) {
        notifyTsDocumentSaved(normalizedPath, file.content);
      }
      
      // Notify Tailwind LSP sidecar about the file being saved
      if (isTailwindFile(normalizedPath)) {
        notifyTailwindDocumentSaved(normalizedPath, file.content);
      }
      
      // Notify ESLint LSP sidecar about the file being saved
      if (isEslintFile(normalizedPath)) {
        notifyEslintDocumentSaved(normalizedPath, file.content);
      }
      
      // Notify Svelte LSP sidecar about the file being saved
      if (isSvelteFile(normalizedPath)) {
        notifySvelteDocumentSaved(normalizedPath, file.content);
      }
    }
  }

  /**
   * Reload file content from disk
   */
  async reloadFile(path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    const file = this.openFiles.find(f => f.path === normalizedPath);
    if (!file) return false;

    // Use original path for file system access
    const content = await readFile(path);
    if (content === null) return false;

    file.content = content;
    file.originalContent = content;
    return true;
  }

  /**
   * Detect language from filename
   */
  private detectLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    
    const languageMap: Record<string, string> = {
      // JavaScript/TypeScript
      'js': 'javascript',
      'mjs': 'javascript',
      'cjs': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'mts': 'typescript',
      'cts': 'typescript',
      
      // Web
      'html': 'html',
      'htm': 'html',
      'css': 'css',
      'scss': 'scss',
      'sass': 'scss',
      'less': 'less',
      
      // Data formats
      'json': 'json',
      'jsonc': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'svg': 'xml',
      
      // Markdown
      'md': 'markdown',
      'mdx': 'markdown',
      
      // Config files
      'toml': 'ini',
      'ini': 'ini',
      'env': 'ini',
      
      // Shell
      'sh': 'shell',
      'bash': 'shell',
      'zsh': 'shell',
      'ps1': 'powershell',
      'bat': 'bat',
      'cmd': 'bat',
      
      // Other languages
      'py': 'python',
      'rs': 'rust',
      'go': 'go',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'sql': 'sql',
      'graphql': 'graphql',
      'gql': 'graphql',
      
      // Svelte/Vue
      'svelte': 'svelte',
      'vue': 'html'
    };

    return languageMap[ext] || 'plaintext';
  }
}

// Singleton instance
export const editorStore = new EditorStore();
