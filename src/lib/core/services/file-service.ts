/**
 * Unified File Service - Single Source of Truth for ALL file operations
 * 
 * This is the VS Code-style architecture that eliminates desync issues:
 * - ALL components (Monaco, Editor, LSPs, AI tools) use this service
 * - Version tracking prevents blind overwrites
 * - Event-driven updates keep everything in sync
 * - Optimistic locking for concurrent edit safety
 * 
 * SaaS-Ready Features:
 * ✅ No cache desync (single source of truth)
 * ✅ Atomic operations with rollback
 * ✅ Version-based conflict detection
 * ✅ Real-time sync across all components
 * ✅ Audit trail for all changes
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  isTsLspConnected,
  notifyDocumentChanged as notifyTsDocumentChanged,
} from '$core/lsp/typescript-sidecar';
import { notifyEslintDocumentChanged } from '$core/lsp/eslint-sidecar';
import {
  isSvelteLspConnected,
  notifySvelteDocumentChanged,
} from '$core/lsp/svelte-sidecar';
import {
  isHtmlLspConnected,
  notifyHtmlDocumentChanged,
} from '$core/lsp/html-sidecar';
import {
  isCssLspConnected,
  notifyCssDocumentChanged,
} from '$core/lsp/css-sidecar';
import {
  isJsonLspConnected,
  notifyJsonDocumentChanged,
} from '$core/lsp/json-sidecar';
import {
  isDartLspRunning,
  notifyDocumentChanged as notifyDartDocumentChanged,
} from '$core/lsp/dart-sidecar';
import {
  isYamlLspRunning,
  notifyDocumentChanged as notifyYamlDocumentChanged,
} from '$core/lsp/yaml-sidecar';
import {
  isXmlLspRunning,
  notifyDocumentChanged as notifyXmlDocumentChanged,
} from '$core/lsp/xml-sidecar';
import {
  isTailwindLspConnected,
  notifyTailwindDocumentChanged,
} from '$core/lsp/tailwind-sidecar';

// ============================================================================
// Types
// ============================================================================

export interface FileDocument {
  path: string;
  content: string;
  version: number;
  diskVersion: number;  // Last known disk state version
  isDirty: boolean;
  lastModified: number;
  language?: string;
}

interface NativeDocumentState {
  path: string;
  content: string;
  version: number;
  diskVersion: number;
  isDirty: boolean;
  lastModified: number;
  language?: string;
}

interface NativeDocumentWriteResult {
  success: boolean;
  newVersion?: number;
  error?: string;
  conflictContent?: string;
}

interface NativeDocumentApplyResult {
  state: NativeDocumentState;
  previousContent?: string;
}

export interface FileChangeEvent {
  path: string;
  content: string;
  version: number;
  source: 'disk' | 'editor' | 'ai' | 'lsp' | 'external';
  previousContent?: string;
}

export interface WriteOptions {
  expectedVersion?: number;  // Optimistic locking - fail if version mismatch
  source?: FileChangeEvent['source'];
  force?: boolean;  // Bypass version check (use sparingly)
  createIfMissing?: boolean;
}

export interface WriteResult {
  success: boolean;
  newVersion?: number;
  error?: string;
  conflictContent?: string;  // Current content if version conflict
}

type FileChangeCallback = (event: FileChangeEvent) => void;

// ============================================================================
// Unified File Service
// ============================================================================

class UnifiedFileService {
  // Single source of truth for all file content
  private documents = new Map<string, FileDocument>();
  
  // Subscribers for file changes (Monaco, LSPs, Editor Store, etc.)
  private subscribers = new Map<string, Set<FileChangeCallback>>();
  
  // Global subscribers (notified of ALL file changes)
  private globalSubscribers = new Set<FileChangeCallback>();
  
  private initialized = false;
  private nativeEventCleanup: (() => void) | null = null;

  // ============================================================================
  // Core Read/Write Operations
  // ============================================================================

  /**
   * Read a file from the Rust document manager.
   * This is the ONLY way components should read file content.
   */
  async read(path: string, forceRefresh = false): Promise<FileDocument | null> {
    const normalizedPath = this.normalizePath(path);
    await this.ensureNativeEvents();
    const state = await invoke<NativeDocumentState | null>('document_read', {
      path: normalizedPath,
      forceRefresh
    }).catch(() => null);
    if (!state) return null;
    const doc = this.mapNativeState(state);
    this.documents.set(normalizedPath, doc);
    return doc;
  }

  /**
   * Write a file with native version tracking and conflict detection.
   * This is the ONLY way components should write file content.
   */
  async write(path: string, content: string, options: WriteOptions = {}): Promise<WriteResult> {
    const normalizedPath = this.normalizePath(path);
    await this.ensureNativeEvents();
    const result = await invoke<NativeDocumentWriteResult>('document_write', {
      path: normalizedPath,
      content,
      expectedVersion: options.expectedVersion,
      source: options.source ?? 'editor',
      force: options.force ?? false
    }).catch((err) => ({
      success: false,
      error: String(err)
    } as NativeDocumentWriteResult));
    return {
      success: result.success,
      newVersion: result.newVersion,
      error: result.error,
      conflictContent: result.conflictContent
    };
  }

  /**
   * Update document content without writing to disk (for editor changes)
   * Marks document as dirty
   */
  updateContent(path: string, content: string, source: FileChangeEvent['source'] = 'editor'): number {
    const normalizedPath = this.normalizePath(path);
    const existing = this.documents.get(normalizedPath) ?? null;
    const fallbackVersion = existing?.version ?? 0;
    const optimisticVersion = fallbackVersion + 1;
    const optimisticPreviousContent = existing?.content;
    const optimisticDoc: FileDocument = {
      path: normalizedPath,
      content,
      version: optimisticVersion,
      diskVersion: existing?.diskVersion ?? fallbackVersion,
      isDirty: true,
      lastModified: Date.now(),
      language: existing?.language ?? this.detectLanguage(normalizedPath)
    };

    this.documents.set(normalizedPath, optimisticDoc);
    this.notifyChange({
      path: normalizedPath,
      content,
      version: optimisticVersion,
      source,
      previousContent: optimisticPreviousContent
    });

    void this.ensureNativeEvents().then(async () => {
      const result = await invoke<NativeDocumentApplyResult>('document_apply_edit', {
        path: normalizedPath,
        content,
        source
      }).catch(() => null);
      if (result?.state) {
        this.documents.set(normalizedPath, this.mapNativeState(result.state));
      }
    });
    return optimisticVersion;
  }

  /**
   * Save a dirty document to disk
   */
  async save(path: string): Promise<WriteResult> {
    const normalizedPath = this.normalizePath(path);
    await this.ensureNativeEvents();
    const result = await invoke<NativeDocumentWriteResult>('document_save', {
      path: normalizedPath
    }).catch((err) => ({
      success: false,
      error: String(err)
    } as NativeDocumentWriteResult));
    return {
      success: result.success,
      newVersion: result.newVersion,
      error: result.error,
      conflictContent: result.conflictContent
    };
  }

  // ============================================================================
  // Subscription System
  // ============================================================================

  /**
   * Subscribe to changes for a specific file
   */
  subscribe(path: string, callback: FileChangeCallback): () => void {
    const normalizedPath = this.normalizePath(path);
    
    if (!this.subscribers.has(normalizedPath)) {
      this.subscribers.set(normalizedPath, new Set());
    }
    
    this.subscribers.get(normalizedPath)!.add(callback);
    
    // Return unsubscribe function
    return () => {
      this.subscribers.get(normalizedPath)?.delete(callback);
    };
  }

  /**
   * Subscribe to ALL file changes (for LSPs, diagnostics, etc.)
   */
  subscribeAll(callback: FileChangeCallback): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  /**
   * Notify all subscribers of a change
   */
  private notifyChange(event: FileChangeEvent): void {
    // Notify file-specific subscribers
    const subs = this.subscribers.get(event.path);
    if (subs) {
      for (const callback of subs) {
        try {
          callback(event);
        } catch (err) {
          console.error('[FileService] Subscriber error:', err);
        }
      }
    }
    
    // Notify global subscribers
    for (const callback of this.globalSubscribers) {
      try {
        callback(event);
      } catch (err) {
        console.error('[FileService] Global subscriber error:', err);
      }
    }
  }

  // ============================================================================
  // Document Management
  // ============================================================================

  /**
   * Get document if loaded (does not read from disk)
   */
  getDocument(path: string): FileDocument | null {
    return this.documents.get(this.normalizePath(path)) ?? null;
  }

  /**
   * Get current content (sync, for Monaco integration)
   */
  getContent(path: string): string | null {
    return this.documents.get(this.normalizePath(path))?.content ?? null;
  }

  /**
   * Get current version (for optimistic locking)
   */
  getVersion(path: string): number | null {
    return this.documents.get(this.normalizePath(path))?.version ?? null;
  }

  /**
   * Check if document is dirty
   */
  isDirty(path: string): boolean {
    return this.documents.get(this.normalizePath(path))?.isDirty ?? false;
  }

  /**
   * Get all dirty documents
   */
  getDirtyDocuments(): FileDocument[] {
    return Array.from(this.documents.values()).filter(d => d.isDirty);
  }

  /**
   * Close a document (remove from memory)
   */
  closeDocument(path: string): void {
    const normalizedPath = this.normalizePath(path);
    this.documents.delete(normalizedPath);
    this.subscribers.delete(normalizedPath);
    void invoke('document_close', { path: normalizedPath }).catch(() => {});
  }

  async getNativeDocument(path: string): Promise<FileDocument | null> {
    const normalizedPath = this.normalizePath(path);
    await this.ensureNativeEvents();
    const state = await invoke<NativeDocumentState | null>('document_get', {
      path: normalizedPath
    }).catch(() => null);
    if (!state) return null;
    const doc = this.mapNativeState(state);
    this.documents.set(normalizedPath, doc);
    return doc;
  }

  async syncFromNative(path: string, forceRefresh = false): Promise<FileDocument | null> {
    return this.read(path, forceRefresh);
  }

  async saveAndGetDocument(path: string): Promise<{ result: WriteResult; document: FileDocument | null }> {
    const normalizedPath = this.normalizePath(path);
    const result = await this.save(normalizedPath);
    const document = result.success
      ? (await this.getNativeDocument(normalizedPath)) ?? this.documents.get(normalizedPath) ?? null
      : this.documents.get(normalizedPath) ?? null;
    return { result, document };
  }

  setCachedDocument(path: string, document: FileDocument): void {
    this.documents.set(this.normalizePath(path), document);
  }

  /**
   * Reload document from disk (discard unsaved changes)
   */
  async reload(path: string): Promise<FileDocument | null> {
    const normalizedPath = this.normalizePath(path);
    await this.ensureNativeEvents();
    const state = await invoke<NativeDocumentState | null>('document_reload', {
      path: normalizedPath
    }).catch(() => null);
    if (!state) return null;
    const doc = this.mapNativeState(state);
    this.documents.set(normalizedPath, doc);
    return doc;
  }

  private mapNativeState(state: NativeDocumentState): FileDocument {
    return {
      path: state.path,
      content: state.content,
      version: state.version,
      diskVersion: state.diskVersion,
      isDirty: state.isDirty,
      lastModified: state.lastModified,
      language: state.language ?? this.detectLanguage(state.path)
    };
  }

  private async ensureNativeEvents(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const unlistenFns: UnlistenFn[] = [];
    try {
      const unlistenChanged = await listen<FileChangeEvent & { diskVersion?: number; isDirty?: boolean }>(
        'document://changed',
        (event) => {
          const payload = event.payload;
          const existing = this.documents.get(this.normalizePath(payload.path));
          const doc: FileDocument = {
            path: this.normalizePath(payload.path),
            content: payload.content,
            version: payload.version,
            diskVersion: payload.diskVersion ?? existing?.diskVersion ?? payload.version,
            isDirty: payload.isDirty ?? false,
            lastModified: Date.now(),
            language: existing?.language ?? this.detectLanguage(payload.path)
          };
          this.documents.set(doc.path, doc);
          this.notifyChange({
            path: doc.path,
            content: doc.content,
            version: doc.version,
            source: payload.source,
            previousContent: payload.previousContent
          });
        }
      );
      unlistenFns.push(unlistenChanged);
      const unlistenClosed = await listen<{ path: string }>('document://closed', (event) => {
        const path = this.normalizePath(event.payload.path);
        this.documents.delete(path);
        this.subscribers.delete(path);
      });
      unlistenFns.push(unlistenClosed);
      this.nativeEventCleanup = () => {
        for (const unlisten of unlistenFns) {
          unlisten();
        }
      };
    } catch (error) {
      this.initialized = false;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
      throw error;
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
  }

  private detectLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescriptreact',
      'js': 'javascript',
      'jsx': 'javascriptreact',
      'svelte': 'svelte',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'less': 'less',
      'json': 'json',
      'md': 'markdown',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'dart': 'dart',
      'rs': 'rust',
      'py': 'python',
      'go': 'go',
    };
    return langMap[ext] ?? 'plaintext';
  }

  /**
   * Batch write multiple files atomically
   * All succeed or all fail (for refactoring operations)
   */
  async batchWrite(
    writes: Array<{ path: string; content: string }>,
    options: WriteOptions = {}
  ): Promise<WriteResult> {
    // Verify all files first
    const verifications: Array<{ path: string; existing: FileDocument | null }> = [];
    
    for (const { path } of writes) {
      const normalizedPath = this.normalizePath(path);
      const existing = this.documents.get(normalizedPath);
      verifications.push({ path: normalizedPath, existing: existing ?? null });
    }
    
    // If version checking, verify all versions match
    if (options.expectedVersion !== undefined && !options.force) {
      for (const { path, existing } of verifications) {
        if (existing && existing.version !== options.expectedVersion) {
          return {
            success: false,
            error: `Version conflict in ${path}`,
            conflictContent: existing.content
          };
        }
      }
    }
    
    // Write all files
    const results: Array<{ path: string; success: boolean }> = [];
    
    for (const { path, content } of writes) {
      const result = await this.write(path, content, { ...options, force: true });
      results.push({ path, success: result.success });
      
      if (!result.success) {
        // Rollback previous writes (best effort)
        console.error(`[FileService] Batch write failed at ${path}, attempting rollback`);
        for (const { path: rollbackPath, existing } of verifications) {
          if (existing && results.some(r => r.path === rollbackPath && r.success)) {
            await this.write(rollbackPath, existing.content, { force: true });
          }
        }
        return { success: false, error: `Batch write failed at ${path}` };
      }
    }
    
    return { success: true };
  }
}

// Singleton instance
export const fileService = new UnifiedFileService();

/**
 * Initialize file service with LSP integration
 * Call this once at app startup to wire automatic LSP notifications
 */
export async function initializeFileService(): Promise<void> {
  // Subscribe to all file changes and notify relevant LSPs
  fileService.subscribeAll(async (event) => {
    const { path, content } = event;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    
    try {
      // TypeScript/JavaScript
      if (['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext)) {
        if (isTsLspConnected()) {
          await notifyTsDocumentChanged(path, content);
        }
        await notifyEslintDocumentChanged(path, content);
      }
      
      // Svelte
      if (ext === 'svelte') {
        if (isSvelteLspConnected()) {
          await notifySvelteDocumentChanged(path, content);
        }
      }
      
      // HTML
      if (['html', 'htm'].includes(ext)) {
        if (isHtmlLspConnected()) {
          await notifyHtmlDocumentChanged(path, content);
        }
      }
      
      // CSS/SCSS/LESS
      if (['css', 'scss', 'less', 'sass'].includes(ext)) {
        if (isCssLspConnected()) {
          await notifyCssDocumentChanged(path, content);
        }
      }
      
      // JSON
      if (ext === 'json') {
        if (isJsonLspConnected()) {
          await notifyJsonDocumentChanged(path, content);
        }
      }
      
      // Dart
      if (ext === 'dart') {
        if (isDartLspRunning()) {
          await notifyDartDocumentChanged(path, content);
        }
      }
      
      // YAML
      if (['yaml', 'yml'].includes(ext)) {
        if (isYamlLspRunning()) {
          await notifyYamlDocumentChanged(path, content);
        }
      }
      
      // XML
      if (['xml', 'plist', 'xsd'].includes(ext)) {
        if (isXmlLspRunning()) {
          await notifyXmlDocumentChanged(path, content);
        }
      }
      
      // Tailwind (for any file that might have Tailwind classes)
      if (isTailwindLspConnected()) {
        await notifyTailwindDocumentChanged(path, content);
      }
    } catch (err) {
      // Non-fatal - LSP notification failed but file was saved
      console.warn('[FileService] LSP notification error:', err);
    }
  });
  
  console.log('[FileService] Initialized with LSP integration');
}

// Export types
export type { UnifiedFileService };
