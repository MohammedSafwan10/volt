/**
 * TSC Watch Service
 * 
 * Runs `tsc --watch --noEmit` in the background and streams errors
 * to the Problems panel in real-time.
 * 
 * This provides VS Code-level "all errors visible without opening files" behavior.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { exists } from '@tauri-apps/plugin-fs';
import { problemsStore, type Problem } from '$shared/stores/problems.svelte';
import { registerCleanup } from '$core/services/hmr-cleanup';
import { hasProblemsFromSource } from '$core/services/diagnostics-source-utils';

const WATCH_ID = 'tsc-watch';
const SOURCE = 'TypeScript (build)';

interface TscWatcherState {
  isRunning: boolean;
  rootPath: string | null;
  errorCount: number;
  warningCount: number;
}

class TscWatcher {
  private state: TscWatcherState = {
    isRunning: false,
    rootPath: null,
    errorCount: 0,
    warningCount: 0,
  };

  private unlisteners: UnlistenFn[] = [];
  private currentBuffer: string[] = [];
  private isCollecting = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Check if watcher is running */
  get isRunning(): boolean {
    return this.state.isRunning;
  }

  /** Get current error count */
  get errorCount(): number {
    return this.state.errorCount;
  }

  /** Get current warning count */
  get warningCount(): number {
    return this.state.warningCount;
  }

  /**
   * Start watching a project for TypeScript errors
   */
  async start(rootPath: string): Promise<void> {
    if (this.state.isRunning) {
      if (this.state.rootPath === rootPath) {
        console.log('[TscWatcher] Already watching this project');
        return;
      }
      // Different project - stop and restart
      await this.stop();
    }

    // Check if tsconfig.json exists
    const tsconfigPath = `${rootPath}/tsconfig.json`.replace(/\\/g, '/');
    const hasTsconfig = await exists(tsconfigPath);
    if (!hasTsconfig) {
      console.log('[TscWatcher] No tsconfig.json found, skipping');
      return;
    }

    console.log('[TscWatcher] Starting watch for:', rootPath);

    // Set up event listeners
    await this.setupListeners();

    // Determine command based on OS
    const isWindows = navigator.userAgent.includes('Windows');
    const command = isWindows ? 'npx.cmd' : 'npx';
    const args = ['--no-install', 'tsc', '--watch', '--noEmit', '--pretty', 'false'];

    try {
      await invoke('start_watch_command', {
        watchId: WATCH_ID,
        command,
        args,
        cwd: rootPath,
      });

      this.state.isRunning = true;
      this.state.rootPath = rootPath;
      console.log('[TscWatcher] Watch started successfully');
    } catch (error) {
      console.error('[TscWatcher] Failed to start:', error);
      await this.cleanup();
    }
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning) return;

    console.log('[TscWatcher] Stopping watch');

    try {
      await invoke('stop_watch_command', { watchId: WATCH_ID });
    } catch {
      // Ignore - might already be stopped
    }

    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // Remove event listeners
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];

    // Clear state
    this.state.isRunning = false;
    this.state.rootPath = null;
    this.currentBuffer = [];
    this.isCollecting = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async setupListeners(): Promise<void> {
    // Listen for stdout
    const unlistenStdout = await listen<string>(`watch://${WATCH_ID}//stdout`, (event) => {
      this.handleOutput(event.payload);
    });
    this.unlisteners.push(unlistenStdout);

    // Listen for stderr
    const unlistenStderr = await listen<string>(`watch://${WATCH_ID}//stderr`, (event) => {
      // TSC sometimes outputs to stderr
      this.handleOutput(event.payload);
    });
    this.unlisteners.push(unlistenStderr);

    // Listen for exit
    const unlistenExit = await listen<number>(`watch://${WATCH_ID}//exit`, (event) => {
      console.log('[TscWatcher] Process exited with code:', event.payload);
      this.cleanup();
    });
    this.unlisteners.push(unlistenExit);
  }

  private handleOutput(line: string): void {
    // TSC watch mode outputs markers for start/end of compilation
    // "Starting compilation in watch mode..." or "Starting incremental compilation..."
    // "Found X errors. Watching for file changes."

    if (line.includes('Starting') && (line.includes('compilation') || line.includes('Watching'))) {
      // New compilation starting - clear buffer
      this.currentBuffer = [];
      this.isCollecting = true;
      return;
    }

    if (line.includes('Watching for file changes') || line.includes('Found') && line.includes('error')) {
      // Compilation finished - parse collected errors
      this.isCollecting = false;
      this.parseAndUpdateProblems();
      return;
    }

    if (this.isCollecting) {
      this.currentBuffer.push(line);
    }

    // Debounce parsing in case of rapid output
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      if (this.currentBuffer.length > 0 && !this.isCollecting) {
        this.parseAndUpdateProblems();
      }
    }, 500);
  }

  private parseAndUpdateProblems(): void {
    if (!this.state.rootPath) return;

    const problemsByFile: Record<string, Problem[]> = {};
    let errorCount = 0;
    let warningCount = 0;

    // Parse tsc output
    // Format: FILE(LINE,COL): error|warning TSCODE: MESSAGE
    // Example: src/index.ts(1,5): error TS2322: Type '...'
    const regex = /^(.+?)\((\d+),(\d+)\): (error|warning|info) (TS\d+): (.+)$/;

    for (const line of this.currentBuffer) {
      const match = line.trim().match(regex);
      if (match) {
        const [, relativePath, lineStr, colStr, severityStr, code, message] = match;

        const fullPath = this.resolvePath(this.state.rootPath!, relativePath);
        const lineNum = parseInt(lineStr, 10);
        const colNum = parseInt(colStr, 10);
        const severity = severityStr === 'error' ? 'error' : 'warning';

        if (severity === 'error') errorCount++;
        else warningCount++;

        const problem: Problem = {
          id: `tsc-watch-${fullPath}-${lineNum}-${colNum}`,
          file: fullPath,
          fileName: relativePath.split(/[/\\]/).pop() || relativePath,
          line: lineNum,
          column: colNum,
          endLine: lineNum,
          endColumn: colNum + 1,
          severity,
          message: message.trim(),
          code,
          source: SOURCE,
        };

        if (!problemsByFile[fullPath]) {
          problemsByFile[fullPath] = [];
        }
        problemsByFile[fullPath].push(problem);
      }
    }

    // Update counts
    this.state.errorCount = errorCount;
    this.state.warningCount = warningCount;

    // Clear all previous tsc-watch problems first
    this.clearTscProblems();

    // Update store with new problems
    for (const [path, problems] of Object.entries(problemsByFile)) {
      problemsStore.setProblemsForFile(path, problems, SOURCE);
    }

    console.log(`[TscWatcher] Found ${errorCount} errors, ${warningCount} warnings`);

    // Clear buffer
    this.currentBuffer = [];
  }

  private clearTscProblems(): void {
    // Remove all problems with our source without touching diagnostics
    // produced by other providers for the same file.
    const allFiles = Object.keys(problemsStore.problemsByFile);
    for (const file of allFiles) {
      const problems = problemsStore.problemsByFile[file] || [];
      if (hasProblemsFromSource(problems, SOURCE)) {
        problemsStore.clearProblemsForFile(file, SOURCE);
      }
    }
  }

  private resolvePath(root: string, relativePath: string): string {
    // Normalize path separators
    let normalized = relativePath.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
      // Already absolute - just normalize
      normalized = normalized.replace(/\\/g, '/');
    } else {
      // Join with root
      const rootNormalized = root.replace(/\\/g, '/').replace(/\/$/, '');
      normalized = `${rootNormalized}/${normalized}`;
    }
    
    // Lowercase drive letter for Windows path consistency with Monaco
    if (normalized.match(/^[A-Z]:/)) {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    
    return normalized;
  }
}

// Singleton instance
export const tscWatcher = new TscWatcher();

// Register HMR cleanup to prevent orphaned event listeners
registerCleanup('tsc-watcher', () => tscWatcher.stop());
