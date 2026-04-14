/**
 * Editor state store using Svelte 5 runes
 * Manages open files, active file, and file content
 */

import { fileService } from '$core/services/file-service';
import { stateSnapshotService, type ISnapshotParticipant } from '$core/services/state-snapshot';
import {
  clearReviewHighlight,
  disposeAllModels,
  disposeModel,
  setModelValue,
  setSelection,
} from '$core/services/monaco-models';
import { notifyFileClosed } from '$core/lsp/client';
import { activityStore } from '$shared/stores/activity.svelte';
import {
  isTsJsFile,
  notifyDocumentClosed as notifyTsDocumentClosed,
  notifyDocumentSaved as notifyTsDocumentSaved,
  notifyDocumentChanged as notifyTsDocumentChanged
} from '$core/lsp/typescript-sidecar';
import { detectLanguage } from '$core/services/monaco-loader';
import {
  isTailwindFile,
  notifyTailwindDocumentClosed,
  notifyTailwindDocumentSaved,
  notifyTailwindDocumentChanged
} from '$core/lsp/tailwind-sidecar';
import {
  isEslintFile,
  notifyEslintDocumentClosed,
  notifyEslintDocumentSaved,
  notifyEslintDocumentChanged
} from '$core/lsp/eslint-sidecar';
import {
  isSvelteFile,
  notifySvelteDocumentClosed,
  notifySvelteDocumentSaved,
  notifySvelteDocumentChanged
} from '$core/lsp/svelte-sidecar';
import {
  isHtmlFile,
  notifyHtmlDocumentClosed,
  notifyHtmlDocumentSaved,
  notifyHtmlDocumentChanged
} from '$core/lsp/html-sidecar';
import {
  isCssFile,
  notifyCssDocumentClosed,
  notifyCssDocumentSaved,
  notifyCssDocumentChanged
} from '$core/lsp/css-sidecar';
import {
  isJsonFile,
  notifyJsonDocumentClosed,
  notifyJsonDocumentSaved,
  notifyJsonDocumentChanged
} from '$core/lsp/json-sidecar';
import {
  isDartLspFile,
  notifyDocumentClosed as notifyDartDocumentClosed,
  notifyDocumentSaved as notifyDartDocumentSaved,
  notifyDocumentChanged as notifyDartDocumentChanged
} from '$core/lsp/dart-sidecar';
import {
  isYamlFile,
  notifyDocumentClosed as notifyYamlDocumentClosed,
  notifyDocumentSaved as notifyYamlDocumentSaved,
  notifyDocumentChanged as notifyYamlDocumentChanged
} from '$core/lsp/yaml-sidecar';
import {
  isXmlFile,
  notifyDocumentClosed as notifyXmlDocumentClosed,
  notifyDocumentSaved as notifyXmlDocumentSaved,
  notifyDocumentChanged as notifyXmlDocumentChanged
} from '$core/lsp/xml-sidecar';
import {
  notifyEditorDidClose,
  notifyEditorDidSave,
  type EditorLifecycleTarget,
} from './editor-lsp-lifecycle';

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

function safelyNotify(operation: () => Promise<void>, label: string): void {
  void operation().catch((error) => {
    console.error(`[EditorStore] ${label} failed:`, error);
  });
}

function reportLifecycleError(label: string, error: unknown): void {
  console.error(`[EditorStore] ${label} failed:`, error);
}

const LSP_LIFECYCLE_TARGETS: EditorLifecycleTarget[] = [
  { matches: isTsJsFile, close: notifyTsDocumentClosed, save: notifyTsDocumentSaved },
  { matches: isTailwindFile, close: notifyTailwindDocumentClosed, save: notifyTailwindDocumentSaved },
  { matches: isEslintFile, close: notifyEslintDocumentClosed, save: notifyEslintDocumentSaved },
  { matches: isSvelteFile, close: notifySvelteDocumentClosed, save: notifySvelteDocumentSaved },
  { matches: isHtmlFile, close: notifyHtmlDocumentClosed, save: notifyHtmlDocumentSaved },
  { matches: isCssFile, close: notifyCssDocumentClosed, save: notifyCssDocumentSaved },
  { matches: isJsonFile, close: notifyJsonDocumentClosed, save: notifyJsonDocumentSaved },
  { matches: isDartLspFile, close: notifyDartDocumentClosed, save: notifyDartDocumentSaved },
  { matches: isYamlFile, close: notifyYamlDocumentClosed, save: notifyYamlDocumentSaved },
  { matches: isXmlFile, close: notifyXmlDocumentClosed, save: notifyXmlDocumentSaved },
];

function getFileExt(path: string): string {
  const name = path.split('/').pop() ?? path;
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

const BINARY_LIKE_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'tif',
  'tiff',
  'zip',
  '7z',
  'rar',
  'exe',
  'dll',
  'bin',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp3',
  'wav',
  'ogg',
  'oga',
  'flac',
  'aac',
  'm4a',
  'mp4',
  'mpeg',
  'mpg',
  'webm',
  'mov',
  'avi',
  'm4v',
  'ogv',
]);

interface EditorSnapshot {
  openFilePaths: string[];
  activeFilePath: string | null;
  pinnedPaths: string[];
}

export class EditorStore implements ISnapshotParticipant {
  readonly snapshotPriority = 2;

  /** List of open files */
  openFiles = $state<OpenFile[]>([]);

  /** Path of the currently active file */
  activeFilePath = $state<string | null>(null);

  /** Current cursor position */
  cursorPosition = $state<CursorPosition>({ line: 1, column: 1, selected: 0 });

  /** Current editor options (indentation) */
  editorOptions = $state<EditorOptions>({ tabSize: 2, insertSpaces: true });

  fileServiceUnsubscribe: (() => void) | null = null;
  private fileServiceInitRetryQueued = false;

  getSnapshot(): EditorSnapshot {
    const diskFiles = this.openFiles.filter(f => !isVoltVirtualPath(f.path));
    return {
      openFilePaths: diskFiles.map(f => f.path),
      activeFilePath: this.activeFilePath && !isVoltVirtualPath(this.activeFilePath)
        ? this.activeFilePath
        : (diskFiles[0]?.path ?? null),
      pinnedPaths: diskFiles.filter(f => f.pinned).map(f => f.path),
    };
  }

  restoreSnapshot(data: unknown): void {
    const snap = data as EditorSnapshot;
    if (!snap) return;
    // Re-open files from disk after reload completes
    // We defer this to avoid blocking the restore sequence
    if (Array.isArray(snap.openFilePaths) && snap.openFilePaths.length > 0) {
      const pathsToOpen = snap.openFilePaths;
      const activePath = snap.activeFilePath;
      const pinnedSet = new Set<string>(snap.pinnedPaths ?? []);
      queueMicrotask(() => {
        void this.restoreOpenFiles(pathsToOpen, activePath, pinnedSet);
      });
    }
  }

  private async restoreOpenFiles(
    paths: string[],
    activePath: string | null,
    pinnedPaths: Set<string>,
  ): Promise<void> {
    for (const path of paths) {
      try {
        await this.openFile(path);
        if (pinnedPaths.has(path)) {
          this.togglePin(path);
        }
      } catch (err) {
        console.warn(`[EditorStore] Failed to restore file: ${path}`, err);
      }
    }
    if (activePath) {
      this.setActiveFile(activePath);
    }
  }

  initialize(): void {
    if (this.fileServiceUnsubscribe || this.fileServiceInitRetryQueued) return;

    try {
      this.fileServiceUnsubscribe = fileService.subscribeAll((event) => {
        this.handleFileServiceChange(event);
      });
    } catch (error) {
      const isFileServiceTdz =
        error instanceof ReferenceError &&
        /fileService/.test(error.message);
      if (!isFileServiceTdz) {
        throw error;
      }

      this.fileServiceInitRetryQueued = true;
      queueMicrotask(() => {
        this.fileServiceInitRetryQueued = false;
        this.initialize();
      });
    }
  }

  resetFileServiceSubscription(): void {
    this.fileServiceUnsubscribe?.();
    this.fileServiceUnsubscribe = null;
    this.fileServiceInitRetryQueued = false;
  }

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
    return fileService.isDirty(normalizedPath);
  }

  /** Check if any file is dirty */
  get hasUnsavedChanges(): boolean {
    return this.openFiles.some(f => fileService.isDirty(f.path));
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

    // Extract filename
    const name = normalizedPath.split('/').pop() || normalizedPath;
    const ext = getFileExt(normalizedPath);
    const isBinaryLike = BINARY_LIKE_EXTENSIONS.has(ext);

    // Read file content for text-like files only.
    // Binary files are opened in preview mode and should not fail file open.
    const content = isBinaryLike ? '' : (await fileService.read(normalizedPath))?.content ?? null;
    if (!isBinaryLike && content === null) {
      // Error already shown via toast in readFile
      return false;
    }

    // Detect language from extension
    const language = detectLanguage(name);

    // Detect line ending from content
    const lineEnding = content && content.includes('\r\n') ? 'CRLF' : 'LF';

    // Add to open files (race-safe: check again after async read)
    const existingAfterRead = this.openFiles.find(f => f.path === normalizedPath);
    if (existingAfterRead) {
      this.activeFilePath = normalizedPath;
      return true;
    }

    const newFile: OpenFile = {
      path: normalizedPath,
      name,
      content: content ?? '',
      originalContent: content ?? '',
      language,
      lineEnding,
      encoding: 'UTF-8',
      readonly: isBinaryLike || undefined,
    };

    this.openFiles = [...this.openFiles.filter(f => f.path !== normalizedPath), newFile];
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
    notifyEditorDidClose(normalizedPath, LSP_LIFECYCLE_TARGETS, reportLifecycleError);

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
      notifyEditorDidClose(file.path, LSP_LIFECYCLE_TARGETS, reportLifecycleError);
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
      fileService.updateContent(normalizedPath, content, 'editor');
      activityStore.recordActivity(normalizedPath, 'edit');
    }
  }

  /**
   * Mark file as saved (update original content to match current)
   */
  markSaved(path: string): void {
    const normalizedPath = normalizePath(path);
    const fileIndex = this.openFiles.findIndex((f) => f.path === normalizedPath);
    if (fileIndex === -1) return;

    const existing = this.openFiles[fileIndex];
    const nativeDoc = fileService.getDocument(normalizedPath);
    const savedContent = nativeDoc?.content ?? existing.content;
    const updatedFile: OpenFile = {
      ...existing,
      content: savedContent,
      originalContent: savedContent,
      language: nativeDoc?.language ?? existing.language,
    };

    this.openFiles = [
      ...this.openFiles.slice(0, fileIndex),
      updatedFile,
      ...this.openFiles.slice(fileIndex + 1),
    ];

    notifyEditorDidSave(normalizedPath, savedContent, LSP_LIFECYCLE_TARGETS, reportLifecycleError);
  }

  getDocumentVersion(path: string): number | null {
    return fileService.getVersion(normalizePath(path));
  }

  /**
   * Reload file content from disk
   */
  async reloadFile(path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    const fileIndex = this.openFiles.findIndex(f => f.path === normalizedPath);
    if (fileIndex === -1) return false;

    const ext = getFileExt(normalizedPath);
    const isBinaryLike = BINARY_LIKE_EXTENSIONS.has(ext);
    if (isBinaryLike) {
      // Binary previews are loaded by viewer components from disk directly.
      return true;
    }

    if (fileService.isDirty(normalizedPath)) {
      return false;
    }

    try {
      const content = (await fileService.reload(normalizedPath))?.content ?? null;
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
      if (isHtmlFile(normalizedPath)) {
        notifyHtmlDocumentChanged(normalizedPath, content);
      }
      if (isCssFile(normalizedPath)) {
        notifyCssDocumentChanged(normalizedPath, content);
      }
      if (isJsonFile(normalizedPath)) {
        notifyJsonDocumentChanged(normalizedPath, content);
      }
      if (isDartLspFile(normalizedPath)) {
        notifyDartDocumentChanged(normalizedPath, content);
      }
      if (isYamlFile(normalizedPath)) {
        notifyYamlDocumentChanged(normalizedPath, content);
      }
      if (isXmlFile(normalizedPath)) {
        notifyXmlDocumentChanged(normalizedPath, content);
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

    const fileIndex = this.openFiles.findIndex(f => f.path === normOld);
    if (fileIndex === -1) return;

    const wasActive = this.activeFilePath === normOld;
    const existing = this.openFiles[fileIndex];
    const renamedFile: OpenFile = {
      ...existing,
      path: normNew,
      name: normNew.split('/').pop() || normNew,
      language: detectLanguage(normNew.split('/').pop() || normNew)
    };
    this.openFiles = [
      ...this.openFiles.slice(0, fileIndex),
      renamedFile,
      ...this.openFiles.slice(fileIndex + 1)
    ];
    const refreshed = await fileService.read(normNew, true);
    if (refreshed) {
      this.applyDocumentToOpenFile(normNew, refreshed, false);
    }
    if (wasActive) {
      this.activeFilePath = normNew;
    }

    // Dispose old model if it exists
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
    if (isHtmlFile(normalizedPath)) {
      notifyHtmlDocumentChanged(normalizedPath, content);
    }
    if (isCssFile(normalizedPath)) {
      notifyCssDocumentChanged(normalizedPath, content);
    }
    if (isJsonFile(normalizedPath)) {
      notifyJsonDocumentChanged(normalizedPath, content);
    }
    if (isDartLspFile(normalizedPath)) {
      notifyDartDocumentChanged(normalizedPath, content);
    }
    if (isYamlFile(normalizedPath)) {
      notifyYamlDocumentChanged(normalizedPath, content);
    }
    if (isXmlFile(normalizedPath)) {
      notifyXmlDocumentChanged(normalizedPath, content);
    }

    return true;
  }

  private handleFileServiceChange(event: {
    path: string;
    content: string;
    source: 'disk' | 'editor' | 'ai' | 'lsp' | 'external';
  }): void {
    const normalizedPath = normalizePath(event.path);
    const nativeDoc = fileService.getDocument(normalizedPath);
    if (!nativeDoc) return;
    const file = this.openFiles.find((entry) => entry.path === normalizedPath);
    if (!file) return;

    const preserveDirtyBuffer =
      (event.source === 'disk' || event.source === 'external') &&
      file.content !== file.originalContent;

    this.applyDocumentToOpenFile(normalizedPath, nativeDoc, preserveDirtyBuffer);
  }

  private applyDocumentToOpenFile(
    normalizedPath: string,
    document: { content: string; isDirty: boolean; language?: string },
    preserveDirtyBuffer: boolean
  ): void {
    const fileIndex = this.openFiles.findIndex((entry) => entry.path === normalizedPath);
    if (fileIndex === -1) return;

    const existing = this.openFiles[fileIndex];
    const updatedFile: OpenFile = {
      ...existing,
      content: preserveDirtyBuffer ? existing.content : document.content,
      originalContent:
        preserveDirtyBuffer && document.isDirty
          ? existing.originalContent
          : document.content,
      language: document.language ?? existing.language
    };

    this.openFiles = [
      ...this.openFiles.slice(0, fileIndex),
      updatedFile,
      ...this.openFiles.slice(fileIndex + 1)
    ];

    if (!preserveDirtyBuffer) {
      setModelValue(normalizedPath, document.content);
      clearReviewHighlight(normalizedPath);
    }
  }
}

// Singleton instance
export const editorStore = new EditorStore();
editorStore.initialize();
stateSnapshotService.registerParticipant('editor', editorStore);

export function disposeEditorStore(): void {
  editorStore.resetFileServiceSubscription();
}
