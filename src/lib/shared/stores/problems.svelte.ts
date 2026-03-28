import { SvelteMap } from 'svelte/reactivity';
/**
 * Problems store using Svelte 5 runes
 * SaaS-Ready real-time diagnostics management
 * 
 * Features:
 * ✅ Real-time updates from multiple LSP sources
 * ✅ Severity filtering and search
 * ✅ Live activity indicator
 * ✅ Source-aware merging (no overwrites between sources)
 */

import {
  summarizeDiagnosticSources,
  type DiagnosticFreshnessSummary,
  type DiagnosticSourceSnapshot,
} from '$core/services/diagnostics-freshness';
import { writable, type Writable } from 'svelte/store';

export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint';
export type SeverityFilter = ProblemSeverity | 'all';
export type DiagnosticsBasis = 'committed_disk' | 'editor_buffer' | 'staged_tool_output';

export interface DiagnosticSourceState {
  source: string;
  lastUpdated: number;
  isUpdating: boolean;
  isStale: boolean;
}

export interface Problem {
  /** Unique identifier */
  id: string;
  /** File path */
  file: string;
  /** File name (for display) */
  fileName: string;
  /** Line number (1-based) */
  line: number;
  /** Column number (1-based) */
  column: number;
  /** End line number */
  endLine: number;
  /** End column number */
  endColumn: number;
  /** Problem message */
  message: string;
  /** Severity level */
  severity: ProblemSeverity;
  /** Source (e.g., 'typescript', 'eslint') */
  source: string;
  /** Error code if available */
  code?: string;
  /** Timestamp when problem was added */
  timestamp?: number;
}

export interface ProblemsByFile {
  [filePath: string]: Problem[];
}

function problemSortValue(severity: ProblemSeverity): number {
  switch (severity) {
    case 'error':
      return 0;
    case 'warning':
      return 1;
    case 'info':
      return 2;
    case 'hint':
      return 3;
    default:
      return 4;
  }
}

class ProblemsStore {
  private readonly NATIVE_SOURCE = 'monaco-native';
  private readonly problemsByFileStore: Writable<ProblemsByFile>;
  private readonly severityFilterStore: Writable<SeverityFilter>;
  private readonly searchQueryStore: Writable<string>;
  private readonly isUpdatingStore: Writable<boolean>;
  private readonly sourceStatesStore: Writable<Record<string, DiagnosticSourceState>>;
  private readonly diagnosticsBasisStore: Writable<DiagnosticsBasis>;
  private readonly lastUpdateStore: Writable<number>;
  private readonly freshnessNowStore: Writable<number>;

  private normalizePath(filePath: string): string {
    let normalized = filePath.replace(/\\/g, '/');
    if (normalized.match(/^[a-zA-Z]:/)) {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
  }

  /** All problems grouped by file */
  problemsByFile: ProblemsByFile = {};
  
  /** Current severity filter */
  severityFilter: SeverityFilter = 'all';
  
  /** Search query for filtering problems */
  searchQuery = '';
  
  /** Is currently receiving updates (for activity indicator) */
  isUpdating = false;

  /** Diagnostics source health state */
  sourceStates: Record<string, DiagnosticSourceState> = {};

  /** Canonical basis for the currently projected diagnostics */
  diagnosticsBasis: DiagnosticsBasis = 'committed_disk';
  
  /** Last update timestamp */
  lastUpdate = 0;
  
  /** Update timeout for activity indicator */
  private updateTimeout: ReturnType<typeof setTimeout> | null = null;
  private sourceUpdateTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private freshnessNow = Date.now();
  private freshnessTicker: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.problemsByFileStore = writable<ProblemsByFile>(this.problemsByFile);
    this.problemsByFileStore.subscribe((value) => {
      this.problemsByFile = value;
    });
    this.severityFilterStore = writable<SeverityFilter>(this.severityFilter);
    this.severityFilterStore.subscribe((value) => {
      this.severityFilter = value;
    });
    this.searchQueryStore = writable<string>(this.searchQuery);
    this.searchQueryStore.subscribe((value) => {
      this.searchQuery = value;
    });
    this.isUpdatingStore = writable<boolean>(this.isUpdating);
    this.isUpdatingStore.subscribe((value) => {
      this.isUpdating = value;
    });
    this.sourceStatesStore = writable<Record<string, DiagnosticSourceState>>(this.sourceStates);
    this.sourceStatesStore.subscribe((value) => {
      this.sourceStates = value;
    });
    this.diagnosticsBasisStore = writable<DiagnosticsBasis>(this.diagnosticsBasis);
    this.diagnosticsBasisStore.subscribe((value) => {
      this.diagnosticsBasis = value;
    });
    this.lastUpdateStore = writable<number>(this.lastUpdate);
    this.lastUpdateStore.subscribe((value) => {
      this.lastUpdate = value;
    });
    this.freshnessNowStore = writable<number>(this.freshnessNow);
    this.freshnessNowStore.subscribe((value) => {
      this.freshnessNow = value;
    });
  }

  private setProblemsByFile(next: ProblemsByFile): void {
    this.problemsByFile = next;
    this.problemsByFileStore.set(next);
  }

  private setSeverityFilterState(next: SeverityFilter): void {
    this.severityFilter = next;
    this.severityFilterStore.set(next);
  }

  private setSearchQueryState(next: string): void {
    this.searchQuery = next;
    this.searchQueryStore.set(next);
  }

  private setIsUpdatingState(next: boolean): void {
    this.isUpdating = next;
    this.isUpdatingStore.set(next);
  }

  private setSourceStates(next: Record<string, DiagnosticSourceState>): void {
    this.sourceStates = next;
    this.sourceStatesStore.set(next);
  }

  private setDiagnosticsBasisState(next: DiagnosticsBasis): void {
    this.diagnosticsBasis = next;
    this.diagnosticsBasisStore.set(next);
  }

  private setLastUpdate(next: number): void {
    this.lastUpdate = next;
    this.lastUpdateStore.set(next);
  }

  private setFreshnessNow(next: number): void {
    this.freshnessNow = next;
    this.freshnessNowStore.set(next);
  }

  /** Get all problems as a flat array (with filters applied) */
  get allProblems(): Problem[] {
    let problems = this.getDedupedProblems();
    
    // Apply severity filter
    if (this.severityFilter !== 'all') {
      problems = problems.filter(p => p.severity === this.severityFilter);
    }
    
    // Apply search filter
    if (this.searchQuery) {
      const query = this.searchQuery.toLowerCase();
      problems = problems.filter(p => 
        p.message.toLowerCase().includes(query) ||
        p.file.toLowerCase().includes(query) ||
        p.source.toLowerCase().includes(query) ||
        (p.code && p.code.toLowerCase().includes(query))
      );
    }
    
    return this.sortProblems(problems);
  }
  
  /** Get all problems WITHOUT filters (for counts) */
  get allProblemsUnfiltered(): Problem[] {
    return this.sortProblems(this.getDedupedProblems());
  }

  private sortProblems(problems: Problem[]): Problem[] {
    return [...problems].sort((a, b) => {
      const severityDiff = problemSortValue(a.severity) - problemSortValue(b.severity);
      if (severityDiff !== 0) return severityDiff;

      const fileDiff = this.normalizePath(a.file).localeCompare(this.normalizePath(b.file));
      if (fileDiff !== 0) return fileDiff;

      if (a.line !== b.line) return a.line - b.line;
      if (a.column !== b.column) return a.column - b.column;

      return a.message.localeCompare(b.message);
    });
  }

  /**
   * Remove duplicate diagnostics reported by multiple sources.
   * Preference order: non-native sources win over monaco-native fallback.
   */
  private getDedupedProblems(): Problem[] {
    const all = Object.values(this.problemsByFile).flat();
    const byFingerprint = new SvelteMap<string, Problem>();

    const fingerprint = (problem: Problem): string => {
      return [
        this.normalizePath(problem.file),
        problem.line,
        problem.column,
        problem.endLine,
        problem.endColumn,
        problem.severity,
        problem.code ?? '',
        problem.message.trim(),
      ].join('|');
    };

    for (const problem of all) {
      const key = fingerprint(problem);
      const existing = byFingerprint.get(key);
      if (!existing) {
        byFingerprint.set(key, problem);
        continue;
      }

      const existingIsNative = (existing.source || '') === this.NATIVE_SOURCE;
      const nextIsNative = (problem.source || '') === this.NATIVE_SOURCE;

      if (existingIsNative && !nextIsNative) {
        byFingerprint.set(key, problem);
      }
    }

    return Array.from(byFingerprint.values());
  }

  /** Get error count (unfiltered for badge) */
  get errorCount(): number {
    return this.allProblemsUnfiltered.filter(p => p.severity === 'error').length;
  }

  /** Get warning count (unfiltered for badge) */
  get warningCount(): number {
    return this.allProblemsUnfiltered.filter(p => p.severity === 'warning').length;
  }

  /** Get info count (unfiltered for badge) */
  get infoCount(): number {
    return this.allProblemsUnfiltered.filter(p => p.severity === 'info' || p.severity === 'hint').length;
  }

  /** Get total problem count (filtered) */
  get totalCount(): number {
    return this.allProblems.length;
  }
  
  /** Get total unfiltered count */
  get totalUnfilteredCount(): number {
    return this.allProblemsUnfiltered.length;
  }

  private ensureFreshnessTicker(): void {
    const hasTrackedSources = Object.keys(this.sourceStates).length > 0;
    if (!hasTrackedSources) {
      this.stopFreshnessTicker();
      return;
    }

    if (this.freshnessTicker) return;
    this.freshnessTicker = setInterval(() => {
      this.setFreshnessNow(Date.now());
    }, 1000);
  }

  private stopFreshnessTicker(): void {
    if (!this.freshnessTicker) return;
    clearInterval(this.freshnessTicker);
    this.freshnessTicker = null;
  }

  get diagnosticsFreshness(): DiagnosticFreshnessSummary {
    this.ensureFreshnessTicker();

    const snapshots = Object.values(this.sourceStates).map((source): DiagnosticSourceSnapshot => ({
      source: source.source,
      lastUpdated: source.lastUpdated,
      isUpdating: source.isUpdating,
      isStale: source.isStale,
      fileCount: this.filesWithSource(source.source).length,
      problemCount: this.allProblemsUnfiltered.filter((problem) => problem.source === source.source).length,
    }));

    return summarizeDiagnosticSources(snapshots, this.freshnessNow);
  }

  setDiagnosticsBasis(next: DiagnosticsBasis): void {
    this.setDiagnosticsBasisState(next);
  }
  
  /** Set severity filter */
  setSeverityFilter(filter: SeverityFilter): void {
    this.setSeverityFilterState(filter);
  }
  
  /** Set search query */
  setSearchQuery(query: string): void {
    this.setSearchQueryState(query);
  }
  
  /** Mark as updating (shows activity indicator) */
  private markUpdating(): void {
    this.setIsUpdatingState(true);
    this.setLastUpdate(Date.now());
    
    // Auto-clear after 500ms of no updates
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    this.updateTimeout = setTimeout(() => {
      this.setIsUpdatingState(false);
    }, 500);
  }

  private markSourceUpdating(source: string): void {
    const now = Date.now();
    this.setSourceStates({
      ...this.sourceStates,
      [source]: {
        source,
        lastUpdated: now,
        isUpdating: true,
        isStale: false,
      },
    });

    const existing = this.sourceUpdateTimeouts.get(source);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      const current = this.sourceStates[source];
      if (!current) return;
      this.setSourceStates({
        ...this.sourceStates,
        [source]: {
          ...current,
          isUpdating: false,
          isStale: false,
        },
      });
      this.sourceUpdateTimeouts.delete(source);
    }, 500);

    this.sourceUpdateTimeouts.set(source, timeout);
  }

  private touchSource(source?: string): void {
    if (!source || source === 'monaco-native') return;
    this.markUpdating();
    this.markSourceUpdating(source);
  }

  markSourceFresh(source: string): void {
    if (!source || source === 'monaco-native') return;
    const now = Date.now();
    this.setSourceStates({
      ...this.sourceStates,
      [source]: {
        source,
        lastUpdated: now,
        isUpdating: false,
        isStale: false,
      },
    });

    const existing = this.sourceUpdateTimeouts.get(source);
    if (existing) {
      clearTimeout(existing);
      this.sourceUpdateTimeouts.delete(source);
    }
  }

  markSourceStale(source: string): void {
    if (!source || source === 'monaco-native') return;
    const current = this.sourceStates[source];
    const now = Date.now();
    this.setSourceStates({
      ...this.sourceStates,
      [source]: {
        source,
        lastUpdated: current?.lastUpdated ?? now,
        isUpdating: false,
        isStale: true,
      },
    });

    const existing = this.sourceUpdateTimeouts.get(source);
    if (existing) {
      clearTimeout(existing);
      this.sourceUpdateTimeouts.delete(source);
    }
  }

  /**
   * Set problems for a specific file
   * If source is provided, only replaces problems from that source
   * Otherwise replaces all existing problems for that file
   */
  setProblemsForFile(filePath: string, problems: Problem[], source?: string): void {
    this.touchSource(source);

    const normalizedPath = this.normalizePath(filePath);
    
    // Add timestamp to new problems
    const timestampedProblems = problems.map(p => ({
      ...p,
      file: normalizedPath,
      timestamp: Date.now()
    }));
    
    if (source) {
      // Merge with existing problems from other sources
      const existingProblems = this.problemsByFile[normalizedPath] || [];
      const otherSourceProblems = existingProblems.filter(p => p.source !== source);
      const mergedProblems = [...otherSourceProblems, ...timestampedProblems];

      if (mergedProblems.length === 0) {
        const { [normalizedPath]: _, ...rest } = this.problemsByFile;
        this.setProblemsByFile(rest);
      } else {
        this.setProblemsByFile({
          ...this.problemsByFile,
          [normalizedPath]: mergedProblems
        });
      }
    } else {
      // Replace all problems for the file
      if (timestampedProblems.length === 0) {
        const { [normalizedPath]: _, ...rest } = this.problemsByFile;
        this.setProblemsByFile(rest);
      } else {
        this.setProblemsByFile({
          ...this.problemsByFile,
          [normalizedPath]: timestampedProblems
        });
      }
    }
  }

  /**
   * Clear problems for a specific file
   * If source is provided, only clears problems from that source
   */
  clearProblemsForFile(filePath: string, source?: string): void {
    this.touchSource(source);
    const normalizedPath = this.normalizePath(filePath);
    if (source) {
      const existingProblems = this.problemsByFile[normalizedPath] || [];
      const remainingProblems = existingProblems.filter(p => p.source !== source);

      if (remainingProblems.length === 0) {
        const { [normalizedPath]: _, ...rest } = this.problemsByFile;
        this.setProblemsByFile(rest);
      } else {
        this.setProblemsByFile({
          ...this.problemsByFile,
          [normalizedPath]: remainingProblems
        });
      }
    } else {
      const { [normalizedPath]: _, ...rest } = this.problemsByFile;
      this.setProblemsByFile(rest);
    }
  }

  /**
   * Clear all problems
   */
  clearAll(): void {
    this.setProblemsByFile({});
    this.setIsUpdatingState(false);
    this.setSourceStates({});
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
    for (const timeout of this.sourceUpdateTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.sourceUpdateTimeouts.clear();
    this.stopFreshnessTicker();
  }

  /**
   * Get problems for a specific file
   */
  getProblemsForFile(filePath: string): Problem[] {
    const normalizedPath = this.normalizePath(filePath);
    return this.problemsByFile[normalizedPath] || [];
  }

  getDedupedProblemsForFile(filePath: string): Problem[] {
    const normalizedPath = this.normalizePath(filePath);
    return this.allProblemsUnfiltered.filter(
      (problem) => this.normalizePath(problem.file) === normalizedPath,
    );
  }

  /**
   * Get files with problems, sorted by error count
   */
  get filesWithProblems(): string[] {
    return Object.keys(this.problemsByFile).sort((a, b) => {
      const aErrors = this.problemsByFile[a].filter(p => p.severity === 'error').length;
      const bErrors = this.problemsByFile[b].filter(p => p.severity === 'error').length;
      if (aErrors !== bErrors) return bErrors - aErrors;
      return a.localeCompare(b);
    });
  }

  filesWithSource(source: string): string[] {
    return Object.keys(this.problemsByFile).filter((filePath) =>
      (this.problemsByFile[filePath] || []).some((problem) => problem.source === source),
    );
  }
}

// Singleton instance
export const problemsStore = new ProblemsStore();
