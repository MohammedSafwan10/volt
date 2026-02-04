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

export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint';
export type SeverityFilter = ProblemSeverity | 'all';

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

class ProblemsStore {
  private normalizePath(filePath: string): string {
    let normalized = filePath.replace(/\\/g, '/');
    if (normalized.match(/^[a-zA-Z]:/)) {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
  }

  /** All problems grouped by file */
  problemsByFile = $state<ProblemsByFile>({});
  
  /** Current severity filter */
  severityFilter = $state<SeverityFilter>('all');
  
  /** Search query for filtering problems */
  searchQuery = $state('');
  
  /** Is currently receiving updates (for activity indicator) */
  isUpdating = $state(false);
  
  /** Last update timestamp */
  lastUpdate = $state(0);
  
  /** Update timeout for activity indicator */
  private updateTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Get all problems as a flat array (with filters applied) */
  get allProblems(): Problem[] {
    let problems = Object.values(this.problemsByFile).flat();
    
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
    
    return problems;
  }
  
  /** Get all problems WITHOUT filters (for counts) */
  get allProblemsUnfiltered(): Problem[] {
    return Object.values(this.problemsByFile).flat();
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
  
  /** Set severity filter */
  setSeverityFilter(filter: SeverityFilter): void {
    this.severityFilter = filter;
  }
  
  /** Set search query */
  setSearchQuery(query: string): void {
    this.searchQuery = query;
  }
  
  /** Mark as updating (shows activity indicator) */
  private markUpdating(): void {
    this.isUpdating = true;
    this.lastUpdate = Date.now();
    
    // Auto-clear after 500ms of no updates
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    this.updateTimeout = setTimeout(() => {
      this.isUpdating = false;
    }, 500);
  }

  /**
   * Set problems for a specific file
   * If source is provided, only replaces problems from that source
   * Otherwise replaces all existing problems for that file
   */
  setProblemsForFile(filePath: string, problems: Problem[], source?: string): void {
    this.markUpdating();

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
        this.problemsByFile = rest;
      } else {
        this.problemsByFile = {
          ...this.problemsByFile,
          [normalizedPath]: mergedProblems
        };
      }
    } else {
      // Replace all problems for the file
      if (timestampedProblems.length === 0) {
        const { [normalizedPath]: _, ...rest } = this.problemsByFile;
        this.problemsByFile = rest;
      } else {
        this.problemsByFile = {
          ...this.problemsByFile,
          [normalizedPath]: timestampedProblems
        };
      }
    }
  }

  /**
   * Clear problems for a specific file
   * If source is provided, only clears problems from that source
   */
  clearProblemsForFile(filePath: string, source?: string): void {
    const normalizedPath = this.normalizePath(filePath);
    if (source) {
      const existingProblems = this.problemsByFile[normalizedPath] || [];
      const remainingProblems = existingProblems.filter(p => p.source !== source);

      if (remainingProblems.length === 0) {
        const { [normalizedPath]: _, ...rest } = this.problemsByFile;
        this.problemsByFile = rest;
      } else {
        this.problemsByFile = {
          ...this.problemsByFile,
          [normalizedPath]: remainingProblems
        };
      }
    } else {
      const { [normalizedPath]: _, ...rest } = this.problemsByFile;
      this.problemsByFile = rest;
    }
  }

  /**
   * Clear all problems
   */
  clearAll(): void {
    this.problemsByFile = {};
  }

  /**
   * Get problems for a specific file
   */
  getProblemsForFile(filePath: string): Problem[] {
    const normalizedPath = this.normalizePath(filePath);
    return this.problemsByFile[normalizedPath] || [];
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
}

// Singleton instance
export const problemsStore = new ProblemsStore();
