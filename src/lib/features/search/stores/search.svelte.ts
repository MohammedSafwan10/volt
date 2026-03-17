/**
 * Search state store using Svelte 5 runes
 * Manages workspace search state and results
 */

import {
  workspaceSearchStream,
  cancelWorkspaceSearch,
  replaceInFile,
  replaceOneInFile,
  type SearchOptions,
  type SearchResults,
  type FileSearchResult,
  type SearchMatch
} from '$features/search/services/search';
import { getSemanticStatus } from '$core/ai/retrieval/semantic-index';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { setModelValue } from '$core/services/monaco-models';
import { editorStore } from '$features/editor/stores/editor.svelte';
import { showToast } from '$shared/stores/toast.svelte';
import { registerCleanup } from '$core/services/hmr-cleanup';

export type { SearchResults, FileSearchResult, SearchMatch };
export type FileMatches = FileSearchResult;
export type SearchEngineStatus = 'unknown' | 'rg-bundled' | 'rg-system' | 'legacy-fallback';
export type SemanticBackendStatus =
  | 'unknown'
  | 'local-onnx'
  | 'local-onnx-fallback'
  | 'disabled'
  | 'error';

class SearchStore {
  // Search query
  query = $state('');
  
  // Search options
  caseSensitive = $state(false);
  useRegex = $state(false);
  wholeWord = $state(false);
  
  // Replace text
  replaceText = $state('');
  
  // Include/exclude patterns
  includePatterns = $state('');
  excludePatterns = $state('');
  
  // Search state
  searching = $state(false);
  results = $state<SearchResults | null>(null);
  lastSearchCancelled = $state(false);
  searchEngineStatus = $state<SearchEngineStatus>('unknown');
  semanticBackendStatus = $state<SemanticBackendStatus>('unknown');
  searchEngineHint = $state<string | null>(null);
  
  // Expanded files in results (for collapsible file groups)
  expandedFiles = $state<Set<string>>(new Set());
  
  // Currently selected result for highlighting
  selectedFile = $state<string | null>(null);
  selectedMatch = $state<SearchMatch | null>(null);

  private searchSeq = 0;
  private requestId = 0;
  private inFlightRequestId: number | null = null;
  private unlistenStream: UnlistenFn | null = null;

  private streamFileMap: Map<string, FileSearchResult> | null = null;
  private streamPendingFiles: FileSearchResult[] = [];
  private streamLatestTotalMatches = 0;
  private streamLatestTruncated = false;
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private mapSearchEngineStatus(telemetry?: {
    engine: string;
    fallbackUsed: boolean;
    rgSource: string;
  }): SearchEngineStatus {
    if (!telemetry) return this.searchEngineStatus;
    if (telemetry.engine === 'rg' && telemetry.rgSource === 'bundled') return 'rg-bundled';
    if (telemetry.engine === 'rg' && telemetry.rgSource === 'system') return 'rg-system';
    if (telemetry.engine === 'legacy') return 'legacy-fallback';
    return 'unknown';
  }

  private mapSemanticStatus(backend: string): SemanticBackendStatus {
    if (backend === 'local-onnx') return 'local-onnx';
    if (backend === 'local-onnx-fallback') return 'local-onnx-fallback';
    if (backend === 'disabled') return 'disabled';
    return 'error';
  }

  private async refreshSemanticStatus(rootPath: string): Promise<void> {
    const status = await getSemanticStatus(rootPath);
    if (!status) return;
    this.semanticBackendStatus = this.mapSemanticStatus(status.backend);
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
  }

  private parsePatternList(input: string): string[] {
    // Accept comma-separated, whitespace-separated, or newline-separated lists.
    // (VS Code commonly uses one pattern per line, but users often paste space-separated too.)
    return input
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /**
   * Perform search with current options
   */
  async search(rootPath: string): Promise<void> {
    if (!this.query.trim() || !rootPath) {
      this.results = null;
      this.lastSearchCancelled = false;
      return;
    }

    const seq = ++this.searchSeq;

    // Cancel any in-flight search to keep UI responsive.
    if (this.inFlightRequestId) {
      void cancelWorkspaceSearch(this.inFlightRequestId);
    }
    if (this.unlistenStream) {
      this.unlistenStream();
      this.unlistenStream = null;
    }
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }

    const requestId = ++this.requestId;
    this.inFlightRequestId = requestId;

    this.searching = true;
    this.lastSearchCancelled = false;
    this.results = {
      files: [],
      totalMatches: 0,
      totalFiles: 0,
      truncated: false
    };

    // Incremental merge state for this search
    this.streamFileMap = new Map();
    this.streamPendingFiles = [];
    this.streamLatestTotalMatches = 0;
    this.streamLatestTruncated = false;

    const flushStream = (): void => {
      this.streamFlushTimer = null;
      if (seq !== this.searchSeq || requestId !== this.inFlightRequestId) return;
      if (!this.results) return;
      if (!this.streamFileMap) return;

      if (this.streamPendingFiles.length === 0) {
        // Still update totals while searching
        this.results = {
          files: this.results.files,
          totalMatches: this.streamLatestTotalMatches,
          totalFiles: this.results.files.length,
          truncated: this.streamLatestTruncated
        };
        return;
      }

      const expanded = new Set(this.expandedFiles);

      for (const file of this.streamPendingFiles) {
        const key = file.path;
        const isNew = !this.streamFileMap.has(key);
        this.streamFileMap.set(key, file);

        if (isNew) {
          const count = this.streamFileMap.size;
          if (count <= 10) {
            expanded.add(key);
          } else if (expanded.size < 3) {
            expanded.add(key);
          }
        }
      }

      this.streamPendingFiles = [];

      const files = Array.from(this.streamFileMap.values()).sort((a, b) =>
        a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
      );

      this.expandedFiles = expanded;
      this.results = {
        files,
        totalMatches: this.streamLatestTotalMatches,
        totalFiles: files.length,
        truncated: this.streamLatestTruncated
      };
    };

    const options: SearchOptions = {
      query: this.query,
      rootPath,
      caseSensitive: this.caseSensitive,
      useRegex: this.useRegex,
      wholeWord: this.wholeWord,
      includePatterns: this.includePatterns ? this.parsePatternList(this.includePatterns) : [],
      excludePatterns: this.excludePatterns ? this.parsePatternList(this.excludePatterns) : [],
      maxResults: 5000,
      requestId
    };

    this.unlistenStream = await workspaceSearchStream(options, {
      onChunk: (chunk) => {
        if (seq !== this.searchSeq || requestId !== this.inFlightRequestId) return;

        this.streamLatestTotalMatches = chunk.totalMatches;
        this.streamLatestTruncated = chunk.truncated;
        this.streamPendingFiles.push(...chunk.files);

        if (!this.streamFlushTimer) {
          this.streamFlushTimer = setTimeout(flushStream, 50);
        }
      },
      onDone: (done) => {
        if (seq !== this.searchSeq || done.requestId !== requestId) return;

        if (this.streamFlushTimer) {
          clearTimeout(this.streamFlushTimer);
          this.streamFlushTimer = null;
        }
        // Flush any pending files immediately
        flushStream();

        this.searching = false;
        this.lastSearchCancelled = done.cancelled;
        if (!done.cancelled) {
          const files = this.results?.files ?? [];
          this.results = {
            files,
            totalMatches: done.totalMatches,
            totalFiles: done.totalFiles,
            truncated: done.truncated,
            telemetry: done.telemetry
          };
          this.searchEngineStatus = this.mapSearchEngineStatus(done.telemetry);
          this.searchEngineHint = done.telemetry?.fallbackReason ?? null;
        }

        if (this.inFlightRequestId === requestId) {
          this.inFlightRequestId = null;
        }

        if (this.unlistenStream) {
          this.unlistenStream();
          this.unlistenStream = null;
        }

        this.streamFileMap = null;
        this.streamPendingFiles = [];
      },
      onError: (evt) => {
        if (seq !== this.searchSeq || evt.requestId !== requestId) return;
        // Errors here are unexpected (cancel is handled separately).
        showToast({ message: `Search error: ${evt.error.message || evt.error.type}`, type: 'error' });
      }
    });

    await this.refreshSemanticStatus(rootPath);
  }

  /**
   * Clear search results
   */
  clear(): void {
    this.query = '';
    this.results = null;
    this.lastSearchCancelled = false;
    this.expandedFiles = new Set();
    this.selectedFile = null;
    this.selectedMatch = null;
    this.searchEngineHint = null;
    if (this.inFlightRequestId) {
      void cancelWorkspaceSearch(this.inFlightRequestId);
      this.inFlightRequestId = null;
    }
    if (this.unlistenStream) {
      this.unlistenStream();
      this.unlistenStream = null;
    }
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
    this.streamFileMap = null;
    this.streamPendingFiles = [];
  }

  /**
   * Toggle file expansion in results
   */
  toggleFileExpanded(path: string): void {
    const newSet = new Set(this.expandedFiles);
    if (newSet.has(path)) {
      newSet.delete(path);
    } else {
      newSet.add(path);
    }
    this.expandedFiles = newSet;
  }

  /**
   * Expand all files in results
   */
  expandAll(): void {
    if (this.results) {
      this.expandedFiles = new Set(this.results.files.map(f => f.path));
    }
  }

  /**
   * Collapse all files in results
   */
  collapseAll(): void {
    this.expandedFiles = new Set();
  }

  /**
   * Select a match for highlighting
   */
  selectMatch(file: string, match: SearchMatch): void {
    this.selectedFile = file;
    this.selectedMatch = match;
  }

  /**
   * Replace in a single file
   */
  async replaceInSingleFile(path: string): Promise<boolean> {
    if (!this.query.trim()) {
      return false;
    }

    const normalizedPath = this.normalizePath(path);

    // Safety: avoid overwriting unsaved edits.
    if (editorStore.isDirty(normalizedPath)) {
      const confirmed = confirm(
        `"${normalizedPath.split('/').pop() || normalizedPath}" has unsaved changes. Replace will overwrite them. Continue?`
      );
      if (!confirmed) return false;
    }

    const result = await replaceInFile({
      path,
      search: this.query,
      replace: this.replaceText,
      caseSensitive: this.caseSensitive,
      useRegex: this.useRegex,
      wholeWord: this.wholeWord
    });

    if (result) {
      // If the file is open, sync Monaco model + editor store so we don't re-save old content.
      const updated = setModelValue(normalizedPath, result.content);
      if (updated) {
        editorStore.updateContent(normalizedPath, result.content);
        editorStore.markSaved(normalizedPath);
      }

      showToast({
        message: `Replaced ${result.replacements} occurrence${result.replacements === 1 ? '' : 's'} in file`,
        type: 'success'
      });
      return true;
    }

    return false;
  }

  private getNextMatch(): { filePath: string; match: SearchMatch } | null {
    if (this.selectedFile && this.selectedMatch) {
      return { filePath: this.selectedFile, match: this.selectedMatch };
    }

    const firstFile = this.results?.files?.[0];
    const firstMatch = firstFile?.matches?.[0];
    if (!firstFile || !firstMatch) return null;
    return { filePath: firstFile.path, match: firstMatch };
  }

  /**
   * Replace the currently selected match, or the next match if none selected.
   */
  async replaceNext(rootPath: string): Promise<boolean> {
    if (!this.query.trim() || !this.results) {
      return false;
    }

    const target = this.getNextMatch();
    if (!target) return false;

    const normalizedPath = this.normalizePath(target.filePath);

    // Safety: avoid overwriting unsaved edits.
    if (editorStore.isDirty(normalizedPath)) {
      const confirmed = confirm(
        `"${normalizedPath.split('/').pop() || normalizedPath}" has unsaved changes. Replace will overwrite them. Continue?`
      );
      if (!confirmed) return false;
    }

    const result = await replaceOneInFile({
      path: target.filePath,
      line: target.match.line,
      columnStart: target.match.columnStart,
      columnEnd: target.match.columnEnd,
      expected: target.match.matchText,
      replace: this.replaceText
    });

    if (result) {
      const updated = setModelValue(normalizedPath, result.content);
      if (updated) {
        editorStore.updateContent(normalizedPath, result.content);
        editorStore.markSaved(normalizedPath);
      }

      showToast({ message: 'Replaced 1 occurrence', type: 'success' });

      await this.search(rootPath);
      return true;
    }

    return false;
  }

  /**
   * Replace all matches in all files
   */
  async replaceAll(rootPath: string): Promise<void> {
    if (!this.results || !this.query.trim()) {
      return;
    }

    let totalReplacements = 0;
    let filesModified = 0;

    for (const file of this.results.files) {
      const normalizedPath = this.normalizePath(file.path);

      // Safety: avoid overwriting unsaved edits.
      if (editorStore.isDirty(normalizedPath)) {
        const confirmed = confirm(
          `"${normalizedPath.split('/').pop() || normalizedPath}" has unsaved changes. Replace will overwrite them. Continue?`
        );
        if (!confirmed) {
          continue;
        }
      }

      const result = await replaceInFile({
        path: file.path,
        search: this.query,
        replace: this.replaceText,
        caseSensitive: this.caseSensitive,
        useRegex: this.useRegex,
        wholeWord: this.wholeWord
      });

      if (result && result.replacements > 0) {
        totalReplacements += result.replacements;
        filesModified++;

        // Sync Monaco/editor state for open files.
        const updated = setModelValue(normalizedPath, result.content);
        if (updated) {
          editorStore.updateContent(normalizedPath, result.content);
          editorStore.markSaved(normalizedPath);
        }
      }
    }

    showToast({
      message: `Replaced ${totalReplacements} occurrence${totalReplacements === 1 ? '' : 's'} in ${filesModified} file${filesModified === 1 ? '' : 's'}`,
      type: 'success'
    });

    // Re-run search to update results
    await this.search(rootPath);
  }

  /**
   * Toggle case sensitive option
   */
  toggleCaseSensitive(): void {
    this.caseSensitive = !this.caseSensitive;
  }

  /**
   * Toggle regex option
   */
  toggleRegex(): void {
    this.useRegex = !this.useRegex;
  }

  /**
   * Toggle whole word option
   */
  toggleWholeWord(): void {
    this.wholeWord = !this.wholeWord;
  }
}

// Singleton instance
export const searchStore = new SearchStore();

registerCleanup('search-store', () => {
  searchStore.clear();
});
