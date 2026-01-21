/**
 * Problems store using Svelte 5 runes
 * Manages diagnostic problems from Monaco Editor (TypeScript, etc.)
 */

export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint';

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
}

export interface ProblemsByFile {
  [filePath: string]: Problem[];
}

class ProblemsStore {
  /** All problems grouped by file */
  problemsByFile = $state<ProblemsByFile>({});

  /** Get all problems as a flat array */
  get allProblems(): Problem[] {
    return Object.values(this.problemsByFile).flat();
  }

  /** Get error count */
  get errorCount(): number {
    return this.allProblems.filter(p => p.severity === 'error').length;
  }

  /** Get warning count */
  get warningCount(): number {
    return this.allProblems.filter(p => p.severity === 'warning').length;
  }

  /** Get info count */
  get infoCount(): number {
    return this.allProblems.filter(p => p.severity === 'info' || p.severity === 'hint').length;
  }

  /** Get total problem count */
  get totalCount(): number {
    return this.allProblems.length;
  }

  /**
   * Set problems for a specific file
   * If source is provided, only replaces problems from that source
   * Otherwise replaces all existing problems for that file
   */
  setProblemsForFile(filePath: string, problems: Problem[], source?: string): void {
    console.log(`[ProblemsStore] Setting ${problems.length} problems for ${filePath} from source: ${source || 'unknown'}`);
    if (source) {
      // Merge with existing problems from other sources
      const existingProblems = this.problemsByFile[filePath] || [];
      const otherSourceProblems = existingProblems.filter(p => p.source !== source);
      const mergedProblems = [...otherSourceProblems, ...problems];

      if (mergedProblems.length === 0) {
        const { [filePath]: _, ...rest } = this.problemsByFile;
        this.problemsByFile = rest;
      } else {
        this.problemsByFile = {
          ...this.problemsByFile,
          [filePath]: mergedProblems
        };
      }
    } else {
      // Replace all problems for the file
      if (problems.length === 0) {
        const { [filePath]: _, ...rest } = this.problemsByFile;
        this.problemsByFile = rest;
      } else {
        this.problemsByFile = {
          ...this.problemsByFile,
          [filePath]: problems
        };
      }
    }
  }

  /**
   * Clear problems for a specific file
   * If source is provided, only clears problems from that source
   */
  clearProblemsForFile(filePath: string, source?: string): void {
    if (source) {
      const existingProblems = this.problemsByFile[filePath] || [];
      const remainingProblems = existingProblems.filter(p => p.source !== source);

      if (remainingProblems.length === 0) {
        const { [filePath]: _, ...rest } = this.problemsByFile;
        this.problemsByFile = rest;
      } else {
        this.problemsByFile = {
          ...this.problemsByFile,
          [filePath]: remainingProblems
        };
      }
    } else {
      const { [filePath]: _, ...rest } = this.problemsByFile;
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
    return this.problemsByFile[filePath] || [];
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
