/**
 * Editor state store using Svelte 5 runes
 * Manages open files, active file, and file content
 */

import { readFile } from '$lib/services/file-system';
import { disposeAllModels, disposeModel } from '$lib/services/monaco-models';
import { notifyFileClosed } from '$lib/services/lsp/client';
import { activityStore } from './activity.svelte';
import {
  isTsJsFile,
  notifyDocumentClosed as notifyTsDocumentClosed,
  notifyDocumentSaved as notifyTsDocumentSaved,
  notifyDocumentChanged as notifyTsDocumentChanged
} from '$lib/services/lsp/typescript-sidecar';
import { detectLanguage } from '$lib/services/monaco-loader';
import {
  isTailwindFile,
  notifyTailwindDocumentClosed,
  notifyTailwindDocumentSaved,
  notifyTailwindDocumentChanged
} from '$lib/services/lsp/tailwind-sidecar';
import {
  isEslintFile,
  notifyEslintDocumentClosed,
  notifyEslintDocumentSaved,
  notifyEslintDocumentChanged
} from '$lib/services/lsp/eslint-sidecar';
import {
  isSvelteFile,
  notifySvelteDocumentClosed,
  notifySvelteDocumentSaved,
  notifySvelteDocumentChanged
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
  /** Line ending style (LF or CRLF) */
  lineEnding: 'LF' | 'CRLF';
  /** File encoding */
  encoding: string;
  /** Whether this editor is read-only */
  readonly?: boolean;
  /** Whether the tab is pinned */
  pinned?: boolean;
}

export const VOLT_SETTINGS_PATH = 'volt://settings';

export function isVoltVirtualPath(path: string): boolean {
  return path.startsWith('volt://');
}

/** Cursor position info for status bar */
export interface CursorPosition {
  line: number;
  column: number;
  /** Number of selected characters (0 if no selection) */
  selected: number;
}

/** Editor model options for status bar */
export interface EditorOptions {
  /** Tab size */
  tabSize: number;
  /** Whether using spaces for indentation */
  insertSpaces: boolean;
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

  /** Current cursor position */
  cursorPosition = $state<CursorPosition>({ line: 1, column: 1, selected: 0 });

  /** Current editor options (indentation) */
  editorOptions = $state<EditorOptions>({ tabSize: 2, insertSpaces: true });

  /** Get the currently active file */
  get activeFile(): OpenFile | null {
    if (!this.activeFilePath) return null;
    return this.openFiles.find((f) => f.path === this.activeFilePath) ?? null;
  }

  /** Update cursor position (called from Monaco editor) */
  setCursorPosition(line: number, column: number, selected = 0): void {
    this.cursorPosition = { line, column, selected };
  }

  /** Update editor options (called from Monaco editor) */
  setEditorOptions(tabSize: number, insertSpaces: boolean): void {
    this.editorOptions = { tabSize, insertSpaces };
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
    const language = detectLanguage(name);

    // Detect line ending from content
    const lineEnding = content.includes('\r\n') ? 'CRLF' : 'LF';

    // Add to open files
    const newFile: OpenFile = {
      path: normalizedPath,
      name,
      content,
      originalContent: content,
      language,
      lineEnding,
      encoding: 'UTF-8'
    };

    this.openFiles = [...this.openFiles, newFile];
    this.activeFilePath = normalizedPath;

    // Reset cursor position for new file
    this.cursorPosition = { line: 1, column: 1, selected: 0 };

    // Record activity
    activityStore.recordActivity(normalizedPath, 'view');

    return true;
  }

  /**
   * Open a virtual document (not backed by the filesystem).
   * Useful for editor UI pages like Settings.
   */
  openVirtualFile(spec: {
    path: string;
    name: string;
    content: string;
    language: string;
    readonly?: boolean;
    pinned?: boolean;
  }): void {
    const normalizedPath = normalizePath(spec.path);

    const existing = this.openFiles.find((f) => f.path === normalizedPath);
    if (existing) {
      this.activeFilePath = normalizedPath;
      return;
    }

    const newFile: OpenFile = {
      path: normalizedPath,
      name: spec.name,
      content: spec.content,
      originalContent: spec.content,
      language: spec.language,
      lineEnding: 'LF',
      encoding: 'UTF-8',
      readonly: spec.readonly ?? true,
      pinned: spec.pinned
    };

    this.openFiles = [...this.openFiles, newFile];
    this.activeFilePath = normalizedPath;
    this.cursorPosition = { line: 1, column: 1, selected: 0 };
  }

  openSettingsTab(): void {
    this.openVirtualFile({
      path: VOLT_SETTINGS_PATH,
      name: 'Settings',
      content: '',
      language: 'volt-settings',
      readonly: true,
      pinned: false
    });
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
      activityStore.recordActivity(normalizedPath, 'view');
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
    activityStore.recordActivity(this.activeFilePath, 'view');
  }

  /**
   * Cycle to the previous tab (Ctrl+Shift+Tab behavior)
   */
  previousTab(): void {
    if (this.openFiles.length <= 1) return;

    const currentIndex = this.openFiles.findIndex(f => f.path === this.activeFilePath);
    const prevIndex = currentIndex <= 0 ? this.openFiles.length - 1 : currentIndex - 1;
    this.activeFilePath = this.openFiles[prevIndex].path;
    activityStore.recordActivity(this.activeFilePath, 'view');
  }

  /**
   * Pin or unpin a tab
   */
  togglePin(path: string): void {
    const normalizedPath = normalizePath(path);
    const file = this.openFiles.find(f => f.path === normalizedPath);
    if (!file) return;

    file.pinned = !file.pinned;

    // Reorder: pinned tabs go to the left
    this.sortTabs();
  }

  /**
   * Check if a file is pinned
   */
  isPinned(path: string): boolean {
    const normalizedPath = normalizePath(path);
    const file = this.openFiles.find(f => f.path === normalizedPath);
    return file?.pinned ?? false;
  }

  /**
   * Sort tabs: pinned first, then unpinned
   */
  private sortTabs(): void {
    this.openFiles = [
      ...this.openFiles.filter(f => f.pinned),
      ...this.openFiles.filter(f => !f.pinned)
    ];
  }

  /**
   * Reorder tabs by moving a tab from one index to another
   */
  reorderTabs(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= this.openFiles.length) return;
    if (toIndex < 0 || toIndex >= this.openFiles.length) return;

    const file = this.openFiles[fromIndex];
    const targetFile = this.openFiles[toIndex];

    // Don't allow moving unpinned tabs before pinned tabs
    if (!file.pinned && targetFile.pinned) return;
    // Don't allow moving pinned tabs after unpinned tabs
    if (file.pinned && !targetFile.pinned && toIndex > fromIndex) return;

    const newFiles = [...this.openFiles];
    newFiles.splice(fromIndex, 1);
    newFiles.splice(toIndex, 0, file);
    this.openFiles = newFiles;
  }

  /**
   * Update file content (called when editor content changes)
   */
  updateContent(path: string, content: string): void {
    const normalizedPath = normalizePath(path);
    const file = this.openFiles.find(f => f.path === normalizedPath);
    if (file) {
      file.content = content;
      activityStore.recordActivity(normalizedPath, 'edit');
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
    const fileIndex = this.openFiles.findIndex(f => f.path === normalizedPath);
    if (fileIndex === -1) return false;

    // Use original path for file system access
    try {
      const content = await readFile(path);
      if (content === null) return false;

      // Create updated file object and replace in array to trigger Svelte reactivity
      const updatedFile = {
        ...this.openFiles[fileIndex],
        content,
        originalContent: content
      };
      
      // Replace the array to trigger reactivity
      this.openFiles = [
        ...this.openFiles.slice(0, fileIndex),
        updatedFile,
        ...this.openFiles.slice(fileIndex + 1)
      ];

      // Also update the Monaco model so the editor shows the new content
      const { setModelValue, clearReviewHighlight } = await import('$lib/services/monaco-models');
      setModelValue(normalizedPath, content);

      // Clear any AI edit highlights (the green blocks) on reload
      clearReviewHighlight(normalizedPath);

      // Notify LSP servers about the content change to trigger diagnostics
      if (isTsJsFile(normalizedPath)) {
        notifyTsDocumentChanged(normalizedPath, content);
      }
      if (isTailwindFile(normalizedPath)) {
        notifyTailwindDocumentChanged(normalizedPath, content);
      }
      if (isEslintFile(normalizedPath)) {
        notifyEslintDocumentChanged(normalizedPath, content);
      }
      if (isSvelteFile(normalizedPath)) {
        notifySvelteDocumentChanged(normalizedPath, content);
      }

      return true;
    } catch (e) {
      console.error(`[EditorStore] Failed to reload ${path}:`, e);
      return false;
    }
  }

  /**
   * Update internal state when a file is renamed on disk
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const normOld = normalizePath(oldPath);
    const normNew = normalizePath(newPath);

    const file = this.openFiles.find(f => f.path === normOld);
    if (!file) return;

    // Update metadata
    file.path = normNew;
    file.name = newPath.split(/[/\\]/).pop() || newPath;

    // Refresh content from new location
    await this.reloadFile(newPath);

    if (this.activeFilePath === normOld) {
      this.activeFilePath = normNew;
    }

    // Dispose old model if it exists (reloadFile will create/update the new one)
    disposeModel(normOld);
  }

  /**
   * Set the selection in the active editor
   */
  async setSelection(path: string, range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }): Promise<void> {
    const { setSelection } = await import('$lib/services/monaco-models');
    setSelection(path, range);
  }

  /**
   * Update file content in memory without reading from disk
   * Used for Accept/Discard in diff view and other in-memory updates
   * Triggers Svelte reactivity properly
   */
  async updateFileContent(path: string, content: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    const fileIndex = this.openFiles.findIndex(f => f.path === normalizedPath);
    
    if (fileIndex === -1) return false;

    // Create updated file object and replace in array to trigger Svelte reactivity
    const updatedFile = {
      ...this.openFiles[fileIndex],
      content,
      originalContent: content
    };
    
    // Replace the array to trigger reactivity
    this.openFiles = [
      ...this.openFiles.slice(0, fileIndex),
      updatedFile,
      ...this.openFiles.slice(fileIndex + 1)
    ];

    // Also update the Monaco model
    const { setModelValue, clearReviewHighlight } = await import('$lib/services/monaco-models');
    setModelValue(normalizedPath, content);
    clearReviewHighlight(normalizedPath);

    // Notify LSP servers about the content change to trigger diagnostics
    if (isTsJsFile(normalizedPath)) {
      notifyTsDocumentChanged(normalizedPath, content);
    }
    if (isTailwindFile(normalizedPath)) {
      notifyTailwindDocumentChanged(normalizedPath, content);
    }
    if (isEslintFile(normalizedPath)) {
      notifyEslintDocumentChanged(normalizedPath, content);
    }
    if (isSvelteFile(normalizedPath)) {
      notifySvelteDocumentChanged(normalizedPath, content);
    }

    return true;
  }
}

// Singleton instance
export const editorStore = new EditorStore();
