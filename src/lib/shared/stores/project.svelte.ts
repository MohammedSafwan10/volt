/**
 * Project state store using Svelte 5 runes
 * Manages the currently open project/folder and file tree state
 * 
 * Features:
 * - File tree management
 * - Package manager auto-detection (npm/yarn/pnpm)
 * - File watching for lock files (VS Code-like behavior)
 */

import { listDirectory, getFileInfoQuiet } from '$core/services/file-system';
import { dirname } from '@tauri-apps/api/path';
import { initLspRegistry, disposeLspRegistry } from '$core/lsp/sidecar';
import { stopTsLsp } from '$core/lsp/typescript-sidecar';
import { stopTailwindLsp } from '$core/lsp/tailwind-sidecar';
import { stopEslintLsp, pushEslintConfig } from '$core/lsp/eslint-sidecar';
import { stopSvelteLsp } from '$core/lsp/svelte-sidecar';
import { stopHtmlLsp } from '$core/lsp/html-sidecar';
import { stopCssLsp } from '$core/lsp/css-sidecar';
import { stopJsonLsp } from '$core/lsp/json-sidecar';
import { stopYamlLsp } from '$core/lsp/yaml-sidecar';
import { stopXmlLsp } from '$core/lsp/xml-sidecar';
import {
  cancelIndexing,
  clearIndex,
  getIndexStatus,
  handleFileChangeBatch,
  indexProject,
  getIndexedRoot,
} from '$core/services/file-index';
import { startDartLsp, stopDartLsp } from '$core/lsp/dart-sidecar';
import {
  dispatchWatchedFileChanges,
  normalizeWatchedFileChanges,
  resetWatchedFileDispatch,
} from '$core/lsp/sidecar/watched-files';
import {
  terminalProblemMatcher,
  setTerminalProblemMatcherProjectRootResolver,
} from '$features/terminal/services/terminal-problem-matcher';
import { fileService } from '$core/services/file-service';
import {
  startWatching as startFileWatching,
  stopWatching as stopFileWatching,
  onFileChange,
} from '$core/services/file-watch';
import type { FileChangeBatchEvent } from '$core/services/file-watch';
import { projectDiagnostics } from '$core/services/project-diagnostics';
import { tscWatcher } from '$core/services/tsc-watcher';
import { problemsStore } from './problems.svelte';
import { mcpStore } from '$features/mcp/stores/mcp.svelte';
import { editorStore } from '$features/editor/stores/editor.svelte';
import { gitStore } from '$features/git/stores/git.svelte';
import type { FileEntry } from '$core/types/files';
import { invoke } from '@tauri-apps/api/core';
import { clearContextV2Cache } from '$core/ai/context/context-v2';
import {
  clearSemanticQueue,
  queueSemanticRemove,
  queueSemanticUpsert,
  warmSemanticIndex,
} from '$core/ai/retrieval/semantic-index';
import { WorkspaceLifecycleManager } from '$core/workspace/workspace-lifecycle';

// Tauri FS plugin for file watching
import { watch, type UnwatchFn, type WatchEvent } from '@tauri-apps/plugin-fs';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

/** Lock files to watch for package manager detection */
const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'];

const RECENT_PROJECTS_KEY = 'volt.recentProjects';
const CURRENT_PROJECT_KEY = 'volt.currentProject';
const MAX_RECENT_PROJECTS = 10;

export interface TreeNode extends FileEntry {
  children: TreeNode[] | null;
  expanded: boolean;
  loading: boolean;
}

export type ProjectStartupPhase =
  | 'idle'
  | 'paint'
  | 'light'
  | 'core-bg'
  | 'heavy-bg'
  | 'background-ready';

const LARGE_REPO_FILE_THRESHOLD = 12_000;
const LARGE_REPO_INDEX_MS_THRESHOLD = 1_500;
const LARGE_REPO_HEAVY_DIRS = new Set(['node_modules', '.next', 'dist', 'build']);
const NON_DIAGNOSTIC_DIRS = new Set([
  '.agent',
  '.agents',
  '.augment',
  '.factory',
  '.git',
  '.kiro',
  '.next',
  '.qoder',
  '.trae',
  '.windsurf',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);
const DIAGNOSTIC_RELEVANT_EXTENSIONS = new Set([
  '.astro',
  '.cjs',
  '.css',
  '.cts',
  '.dart',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.scss',
  '.sass',
  '.less',
  '.svelte',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);
const DIAGNOSTIC_RELEVANT_FILENAMES = new Set([
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'package.json',
  'svelte.config.js',
  'tsconfig.base.json',
  'tsconfig.build.json',
  'tsconfig.eslint.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
]);

class ProjectStore {
  // Current project root path
  rootPath = $state<string | null>(null);

  // Project name (folder name)
  projectName = $state<string>('');

  // File tree root nodes
  tree = $state<TreeNode[]>([]);

  // Loading state for initial load
  loading = $state(false);

  // Recent projects list
  recentProjects = $state<string[]>([]);

  // Currently selected file paths (Set for O(1) lookups)
  selectedPaths = $state<Set<string>>(new Set());

  // Expanded folder paths (normalized)
  expandedPaths = $state<Set<string>>(new Set());

  // Helper for single selection (last selected item)
  selectedPath = $derived([...this.selectedPaths].pop() || null);

  // Detected package manager for the project
  packageManager = $state<PackageManager>('npm');
  startupPhase = $state<ProjectStartupPhase>('idle');
  uiReady = $state(false);
  coreReady = $state(false);
  backgroundReady = $state(false);
  largeRepoMode = $state(false);
  indexedFileCount = $state(0);
  initialIndexDurationMs = $state(0);

  // File watcher unlisten function
  private unwatch: UnwatchFn | null = null;
  private unwatchLockFiles: UnwatchFn | null = null;
  private diagTimer: any = null;
  private treeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private fileServiceUnsubscribe: (() => void) | null = null;
  private pendingFolderRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  private activationTaskTimers = new Set<ReturnType<typeof setTimeout>>();
  private startupGeneration = 0;
  private startupSerialChain: Promise<void> = Promise.resolve();
  private startupRootHasHeavyDirs = false;

  // Fallback polling when fs watch is unavailable (e.g. scope restrictions)
  private lockFilePollTimer: ReturnType<typeof setInterval> | null = null;
  private lockFileLastModified = new Map<string, number | null>();
  private lockFilePollInFlight = false;

  // File change handler cleanup
  private unsubscribeFileChange: (() => void) | null = null;

  // Initialization promise to coordinate other stores
  private resolveInitialized: (() => void) | null = null;
  private workspaceLifecycle = new WorkspaceLifecycleManager();
  public initialized = new Promise<void>((resolve) => {
    this.resolveInitialized = resolve;
  });

  constructor() {
    this.loadRecentProjects();
    setTerminalProblemMatcherProjectRootResolver(() => this.rootPath);
    this.registerWorkspaceLifecycleHooks();
    // Init must be called manually by the app root to avoid HMR loops
  }

  private registerWorkspaceLifecycleHooks(): void {
    this.workspaceLifecycle.register({
      id: 'project-store-core',
      teardown: async (context) => {
        this.startupGeneration += 1;
        this.startupSerialChain = Promise.resolve();
        this.clearActivationTasks();
        await this.stopFileWatching();
        await this.stopWatchingLockFiles();
        await tscWatcher.stop();
        resetWatchedFileDispatch();
        await this.stopLspServers();
        await mcpStore.cleanup();
        gitStore.reset();
        await clearIndex(false);
        clearContextV2Cache();
        clearSemanticQueue();
        projectDiagnostics.reset();
        if (this.treeRefreshTimer) {
          clearTimeout(this.treeRefreshTimer);
          this.treeRefreshTimer = null;
        }
        if (this.diagTimer) {
          clearTimeout(this.diagTimer);
          this.diagTimer = null;
        }
        for (const timer of this.pendingFolderRefreshes.values()) {
          clearTimeout(timer);
        }
        this.pendingFolderRefreshes.clear();
        problemsStore.clearAll();
        terminalProblemMatcher.clear();
        editorStore.closeAllFiles(true);
        const { terminalStore } = await import('$features/terminal/stores/terminal.svelte');
        await terminalStore.killAll();
        if (!context.preserveVisualState) {
          this.rootPath = null;
          if (context.removePersistence && typeof window !== 'undefined') {
            localStorage.removeItem(CURRENT_PROJECT_KEY);
          }
          this.projectName = '';
          if (context.clearFileTree) {
            this.tree = [];
          }
        }
        this.selectedPaths.clear();
        this.expandedPaths = new Set();
        this.packageManager = 'npm';
        this.startupPhase = 'idle';
        this.uiReady = false;
        this.coreReady = false;
        this.backgroundReady = false;
        this.largeRepoMode = false;
        this.indexedFileCount = 0;
        this.initialIndexDurationMs = 0;
        this.startupRootHasHeavyDirs = false;
      },
      activate: async ({ rootPath }) => {
        const generation = ++this.startupGeneration;
        this.packageManager = await this.detectPackageManager(rootPath);
        if (!this.isStartupCurrent(rootPath, generation)) return;

        initLspRegistry(rootPath);
        this.startupPhase = 'light';
        this.clearActivationTasks();
        this.startupSerialChain = Promise.resolve();

        this.scheduleActivationTask(rootPath, generation, 0, async () => {
          await this.startWatchingLockFiles(rootPath);
        });
        this.scheduleActivationTask(rootPath, generation, 80, async () => {
          await this.startFileWatching(rootPath);
        });
        this.scheduleSerialActivationTask(rootPath, generation, 'core-bg', 150, async () => {
          await gitStore.init(rootPath);
        });
        this.scheduleSerialActivationTask(rootPath, generation, 'core-bg', 450, async () => {
          const startedAt = Date.now();
          await indexProject(rootPath);
          if (!this.isStartupCurrent(rootPath, generation)) return;

          const indexDurationMs = Date.now() - startedAt;
          const status = getIndexStatus();
          this.indexedFileCount = status.count;
          this.initialIndexDurationMs = indexDurationMs;
          this.largeRepoMode = this.classifyLargeRepo(status.count, indexDurationMs);
          this.coreReady = true;

          const diagnosticsDelay = this.largeRepoMode ? 3000 : 700;
          const tscDelay = this.largeRepoMode ? 4500 : 1400;
          const semanticDelay = this.largeRepoMode ? 12000 : 2600;
          const mcpDelay = this.largeRepoMode ? 7000 : 2200;
          const finalizeDelay = this.largeRepoMode ? 7800 : 3400;

          this.scheduleSerialActivationTask(rootPath, generation, 'heavy-bg', diagnosticsDelay, async () => {
            await projectDiagnostics.runDiagnostics(rootPath);
          });
          this.scheduleSerialActivationTask(rootPath, generation, 'heavy-bg', tscDelay, async () => {
            await tscWatcher.start(rootPath);
          });
          this.scheduleSerialActivationTask(rootPath, generation, 'heavy-bg', 1800, async () => {
            const pubspecInfo = await getFileInfoQuiet(`${rootPath}/pubspec.yaml`);
            if (pubspecInfo) {
              console.log('[ProjectStore] Dart project detected, starting LSP...');
              await startDartLsp(rootPath);
            }
          });
          this.scheduleSerialActivationTask(
            rootPath,
            generation,
            this.largeRepoMode ? 'background-ready' : 'heavy-bg',
            mcpDelay,
            async () => {
              await mcpStore.initialize(rootPath);
            },
          );
          if (!this.largeRepoMode) {
            this.scheduleSerialActivationTask(rootPath, generation, 'heavy-bg', semanticDelay, async () => {
              await warmSemanticIndex(rootPath);
            });
          }
          this.scheduleSerialActivationTask(rootPath, generation, 'background-ready', finalizeDelay, async () => {
            this.backgroundReady = true;
          });
        });
      },
    });
  }

  private clearActivationTasks(): void {
    for (const timer of this.activationTaskTimers) {
      clearTimeout(timer);
    }
    this.activationTaskTimers.clear();
  }

  private isStartupCurrent(rootPath: string, generation: number): boolean {
    return this.rootPath === rootPath && this.startupGeneration === generation;
  }

  private classifyLargeRepo(indexedCount: number, indexDurationMs: number): boolean {
    return (
      this.startupRootHasHeavyDirs ||
      indexedCount > LARGE_REPO_FILE_THRESHOLD ||
      indexDurationMs > LARGE_REPO_INDEX_MS_THRESHOLD
    );
  }

  private scheduleActivationTask(
    rootPath: string,
    generation: number,
    delayMs: number,
    task: () => Promise<void>,
  ): void {
    const timer = setTimeout(() => {
      this.activationTaskTimers.delete(timer);
      if (!this.isStartupCurrent(rootPath, generation)) return;
      void task().catch((error) => {
        console.warn('[ProjectStore] Activation task failed:', error);
      });
    }, delayMs);
    this.activationTaskTimers.add(timer);
  }

  private scheduleSerialActivationTask(
    rootPath: string,
    generation: number,
    phase: ProjectStartupPhase,
    delayMs: number,
    task: () => Promise<void>,
  ): void {
    const timer = setTimeout(() => {
      this.activationTaskTimers.delete(timer);
      if (!this.isStartupCurrent(rootPath, generation)) return;
      this.startupSerialChain = this.startupSerialChain.then(async () => {
        if (!this.isStartupCurrent(rootPath, generation)) return;
        this.startupPhase = phase;
        await task();
      }).catch((error) => {
        console.warn('[ProjectStore] Serial activation task failed:', error);
      });
    }, delayMs);
    this.activationTaskTimers.add(timer);
  }

  /**
   * Initialize the store and restore state
   */
  public async init(): Promise<void> {
    if (typeof window === 'undefined') {
      this.resolveInitialized?.();
      return;
    }

    try {
      const lastProject = localStorage.getItem(CURRENT_PROJECT_KEY);
      if (lastProject) {
        console.log('[ProjectStore] Restoring last project:', lastProject);
        // We check if the directory still exists before opening
        const exists = await invoke('get_file_info', { path: lastProject }).then(() => true).catch(() => false);
        if (exists) {
          await this.openProject(lastProject);
        } else {
          localStorage.removeItem(CURRENT_PROJECT_KEY);
        }
      }
    } finally {
      this.resolveInitialized?.();
    }

    // Subscribe once to fileService changes to keep tree in sync even if file watching lags.
    if (!this.fileServiceUnsubscribe) {
      this.fileServiceUnsubscribe = fileService.subscribeAll((event) => {
        if (!this.rootPath) return;

        const normalizedRoot = this.normalizePath(this.rootPath);
        const normalizedPath = this.normalizePath(event.path);
        if (!normalizedPath.startsWith(normalizedRoot)) return;

        // If tree is empty for any reason, self-heal with a refresh.
        if (this.tree.length === 0) {
          this.scheduleTreeRefresh();
          return;
        }

        // If the node isn't present yet (new file), refresh the parent folder.
        const existing = this.findNode(event.path);
        if (!existing) {
          void this.refreshParentFolder(normalizedPath);
        }
      });
    }
  }

  /**
   * Open a project folder
   */
  async openProject(path: string): Promise<boolean> {
    this.loading = true;

    // Check if we are already in this project (and it's valid)
    // This prevents re-initialization loops on HMR or redundant calls
    if (this.rootPath && this.rootPath === path) {
      console.log('[ProjectStore] Project already open:', path);
      this.loading = false;
      return true;
    }

    const entries = await listDirectory(path);
    if (entries === null) {
      // Keep the currently-open project visible if a refresh/switch fails.
      this.loading = false;
      return false;
    }

    const previousRootPath = this.rootPath;
    const teardownPromise = previousRootPath
      ? this.workspaceLifecycle.teardown({
          removePersistence: false,
          clearFileTree: false,
          previousRootPath,
          preserveVisualState: true,
        })
      : Promise.resolve();

    this.rootPath = path;
    if (typeof window !== 'undefined') {
      localStorage.setItem(CURRENT_PROJECT_KEY, path);
    }
    this.projectName = this.extractFolderName(path);
    this.tree = this.sortEntries(entries).map((entry) => this.createTreeNode(entry));
    this.selectedPaths.clear();
    this.expandedPaths = new Set();
    this.startupRootHasHeavyDirs = entries.some((entry) =>
      LARGE_REPO_HEAVY_DIRS.has(entry.name.toLowerCase()),
    );
    this.startupPhase = 'paint';
    this.uiReady = true;
    this.coreReady = false;
    this.backgroundReady = false;
    this.largeRepoMode = false;
    this.indexedFileCount = 0;
    this.initialIndexDurationMs = 0;
    this.loading = false;
    this.addToRecentProjects(path);

    await teardownPromise;
    await this.workspaceLifecycle.activate({ rootPath: path });

    return true;
  }

  /**
   * Start file watching for incremental index updates
   * This enables Quick Open and file tree to update without full rescans
   */
  private async startFileWatching(projectPath: string): Promise<void> {
    // Stop any existing file watcher
    await this.stopFileWatching();

    // Register handler for file changes
    this.unsubscribeFileChange = onFileChange((batch: FileChangeBatchEvent) => {
      this.handleFileChanges(batch);
    });

    // Start the file watcher
    await startFileWatching(projectPath);
  }

  /**
   * Stop file watching
   */
  private async stopFileWatching(): Promise<void> {
    if (this.unsubscribeFileChange) {
      this.unsubscribeFileChange();
      this.unsubscribeFileChange = null;
    }
    await stopFileWatching();
  }

  /**
   * Handle file changes from the file watcher
   * Updates both the file index and the file tree
   */
  private handleFileChanges(batch: FileChangeBatchEvent): void {
    // Update the file index incrementally
    const handledIncrementally = handleFileChangeBatch(batch.changes);

    // If too many changes, trigger a full rescan
    if (!handledIncrementally && this.rootPath) {
      // Large burst (git checkout / install): fall back to a full re-index.
      void indexProject(this.rootPath, false);

      // Also refresh the file tree after a short debounce so new files appear.
      if (this.treeRefreshTimer) clearTimeout(this.treeRefreshTimer);
      this.treeRefreshTimer = setTimeout(() => {
        if (this.rootPath) {
          void this.refreshTree();
        }
        this.treeRefreshTimer = null;
      }, 500);
    }

    // Update the file tree for visible changes
    for (const change of batch.changes) {
      // Rename can include [old, new] paths.
      if (change.kind === 'rename' && change.absolutePaths.length >= 2 && change.paths.length >= 2) {
        const oldAbs = change.absolutePaths[0];
        const newAbs = change.absolutePaths[1];
        const newRel = change.paths[1];

        this.handleFileDeleted(oldAbs);
        this.handleFileCreated(newAbs, newRel);
        if (this.rootPath) {
          queueSemanticRemove(this.rootPath, oldAbs);
          queueSemanticUpsert(this.rootPath, newAbs);
        }
        continue;
      }

      for (let i = 0; i < change.absolutePaths.length; i++) {
        const absPath = change.absolutePaths[i];
        const relPath = change.paths[i];

        switch (change.kind) {
          case 'create':
            this.handleFileCreated(absPath, relPath);
            if (this.rootPath) queueSemanticUpsert(this.rootPath, absPath);
            break;
          case 'delete':
            this.handleFileDeleted(absPath);
            if (this.rootPath) queueSemanticRemove(this.rootPath, absPath);
            break;
          case 'rename':
            // If we only got the new path, best-effort refresh.
            this.handleFileCreated(absPath, relPath);
            if (this.rootPath) queueSemanticUpsert(this.rootPath, absPath);
            break;
          case 'modify':
            // If the file is open in the editor, reload it to show new content
            // This handles AI edits appearing in real-time
            const normalizedPath = absPath.replace(/\\/g, '/');
            // Check if open (using internal array to avoid reactive dependency if possible, but state is fine)
            if (editorStore.openFiles.some(f => f.path === normalizedPath)) {
              void editorStore.reloadFile(absPath);
            }
            if (this.rootPath) queueSemanticUpsert(this.rootPath, absPath);
            break;
        }
      }
    }

    const lspEvents = normalizeWatchedFileChanges(batch.changes);
    if (lspEvents.length > 0) {
      dispatchWatchedFileChanges(lspEvents);
    }

    // Debounce project-wide diagnostics only for relevant source/config changes.
    if (this.rootPath && this.shouldTriggerProjectDiagnostics(batch)) {
      if (this.diagTimer) clearTimeout(this.diagTimer);
      this.diagTimer = setTimeout(() => {
        if (this.rootPath) {
          void projectDiagnostics.runDiagnostics(this.rootPath);
        }
        this.diagTimer = null;
      }, 600); // faster debounce for quicker diagnostics
    }
  }

  /**
   * Handle a file being created (update tree if parent is expanded)
   */
  private handleFileCreated(absolutePath: string, relativePath: string): void {
    if (!this.rootPath) return;

    // Find the parent directory path
    const parentRelPath = relativePath.includes('/')
      ? relativePath.substring(0, relativePath.lastIndexOf('/'))
      : '';

    const sep = this.rootPath.includes('\\') ? '\\' : '/';
    const parentAbsPath = parentRelPath
      ? `${this.rootPath}${sep}${parentRelPath.replace(/\//g, sep)}`
      : this.rootPath;

    // Check if parent is in the tree and expanded
    const parentNode = parentAbsPath === this.rootPath
      ? null // Root level
      : this.findNode(parentAbsPath);

    // Only update if parent is visible (root or expanded)
    if (parentAbsPath === this.rootPath) {
      void this.refreshTree();
      return;
    }

    if (!parentNode) {
      // Parent not in tree yet (e.g., freshly scaffolded folder). Refresh root tree.
      void this.refreshTree();
      return;
    }

    if (parentNode.expanded && parentNode.children) {
      void this.refreshFolder(parentNode);
    }
  }

  /**
   * Handle a file being deleted
   */
  private handleFileDeleted(absolutePath: string): void {
    // Remove from tree if present
    this.removeNode(absolutePath);
  }

  private shouldTriggerProjectDiagnostics(batch: FileChangeBatchEvent): boolean {
    return batch.changes.some((change) =>
      change.paths.some((relativePath) => this.isDiagnosticsRelevantPath(relativePath)),
    );
  }

  private isDiagnosticsRelevantPath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) return false;

    const segments = normalized
      .split('/')
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean);
    if (segments.length === 0) return false;

    if (segments.some((segment) => NON_DIAGNOSTIC_DIRS.has(segment))) {
      return false;
    }

    const basename = segments[segments.length - 1];
    if (DIAGNOSTIC_RELEVANT_FILENAMES.has(basename)) {
      return true;
    }

    const dotIndex = basename.lastIndexOf('.');
    if (dotIndex === -1) {
      return false;
    }

    return DIAGNOSTIC_RELEVANT_EXTENSIONS.has(basename.slice(dotIndex));
  }

  /**
   * Start watching lock files for package manager changes
   * This enables VS Code-like behavior where running npm/yarn/pnpm install
   * automatically updates the detected package manager
   */
  private async startWatchingLockFiles(projectPath: string): Promise<void> {
    // Stop any existing watcher
    await this.stopWatchingLockFiles();

    try {
      const sep = projectPath.includes('\\') ? '\\' : '/';
      const lockFilePaths = LOCK_FILES.map(f => `${projectPath}${sep}${f}`);

      // Allow the project directory in the FS scope so the fs plugin can watch it.
      // The app already has direct filesystem access via custom commands; this is
      // just to unblock plugin-fs `watch`.
      await invoke('fs_allow_directory', { path: projectPath, recursive: true });

      // Watch the project root for lock file changes
      // Using debounce of 1000ms to avoid rapid re-detection during install
      this.unwatchLockFiles = await watch(
        projectPath,
        (event: WatchEvent) => {
          this.handleLockFileChange(event, projectPath);
        },
        {
          recursive: false, // Only watch root level
          delayMs: 1000 // Debounce for 1 second
        }
      );

      console.log('[ProjectStore] Started watching lock files:', lockFilePaths);
    } catch (error) {
      console.error('[ProjectStore] Failed to start lock file watcher:', error);
      // Fallback: poll lock files periodically so package manager detection still updates.
      await this.startPollingLockFiles(projectPath);
    }
  }

  /**
   * Handle lock file changes
   */
  private handleLockFileChange(event: WatchEvent, projectPath: string): void {
    // Check if any of the changed paths are lock files
    const changedLockFiles = event.paths.filter((p: string) => {
      const fileName = p.split(/[/\\]/).pop() || '';
      return LOCK_FILES.includes(fileName);
    });

    if (changedLockFiles.length > 0) {
      console.log('[ProjectStore] Lock file changed:', changedLockFiles, 'Event:', event.type);

      // Re-detect package manager
      void this.refreshPackageManager();
      // Also refresh tree so externally-created deps/files (e.g. npm install)
      // show up without manual refresh.
      this.scheduleTreeRefresh();
    }
  }

  /**
   * Stop watching lock files
   */
  private async stopWatchingLockFiles(): Promise<void> {
    if (this.unwatchLockFiles) {
      try {
        this.unwatchLockFiles();
        this.unwatchLockFiles = null;
        console.log('[ProjectStore] Stopped watching lock files');
      } catch (error) {
        console.error('[ProjectStore] Error stopping lock file watcher:', error);
      }
    }

    // Always stop polling fallback too
    this.stopPollingLockFiles();
  }

  private getLockFilePaths(projectPath: string): string[] {
    const sep = projectPath.includes('\\') ? '\\' : '/';
    return LOCK_FILES.map((f) => `${projectPath}${sep}${f}`);
  }

  private async startPollingLockFiles(projectPath: string): Promise<void> {
    this.stopPollingLockFiles();

    const lockFilePaths = this.getLockFilePaths(projectPath);
    this.lockFileLastModified.clear();

    // Prime state
    for (const p of lockFilePaths) {
      const info = await getFileInfoQuiet(p);
      this.lockFileLastModified.set(p, info?.modified ?? null);
    }

    this.lockFilePollTimer = setInterval(() => {
      if (!this.rootPath || this.lockFilePollInFlight) return;
      this.lockFilePollInFlight = true;

      void (async () => {
        try {
          let changed = false;

          for (const p of lockFilePaths) {
            const info = await getFileInfoQuiet(p);
            const next = info?.modified ?? null;
            const prev = this.lockFileLastModified.get(p) ?? null;
            if (next !== prev) {
              this.lockFileLastModified.set(p, next);
              changed = true;
            }
          }

          if (changed) {
            console.log('[ProjectStore] Lock files changed (polling fallback)');
            await this.refreshPackageManager();
            this.scheduleTreeRefresh();
          }
        } catch (e) {
          console.error('[ProjectStore] Lock file polling error:', e);
        } finally {
          this.lockFilePollInFlight = false;
        }
      })();
    }, 2000);

    console.log('[ProjectStore] Started polling lock files (fallback)');
  }

  private stopPollingLockFiles(): void {
    if (this.lockFilePollTimer) {
      clearInterval(this.lockFilePollTimer);
      this.lockFilePollTimer = null;
      this.lockFilePollInFlight = false;
      this.lockFileLastModified.clear();
      console.log('[ProjectStore] Stopped polling lock files');
    }
  }

  /**
   * Detect package manager by checking for lock files
   * Priority: pnpm > yarn > npm (check in order of specificity)
   */
  private async detectPackageManager(projectPath: string): Promise<PackageManager> {
    const sep = projectPath.includes('\\') ? '\\' : '/';

    // Check for pnpm-lock.yaml first (most specific)
    const pnpmLock = `${projectPath}${sep}pnpm-lock.yaml`;
    const pnpmInfo = await getFileInfoQuiet(pnpmLock);
    if (pnpmInfo !== null) {
      return 'pnpm';
    }

    // Check for yarn.lock
    const yarnLock = `${projectPath}${sep}yarn.lock`;
    const yarnInfo = await getFileInfoQuiet(yarnLock);
    if (yarnInfo !== null) {
      return 'yarn';
    }

    // Check for package-lock.json (npm)
    const npmLock = `${projectPath}${sep}package-lock.json`;
    const npmInfo = await getFileInfoQuiet(npmLock);
    if (npmInfo !== null) {
      return 'npm';
    }

    // Default to npm if no lock file found
    return 'npm';
  }

  /**
   * Close the current project
   * VS Code behavior: closes all open files and kills all terminals
   */
  async closeProject(): Promise<void> {
    await this.workspaceLifecycle.teardown({
      previousRootPath: this.rootPath,
      removePersistence: true,
      clearFileTree: true,
    });
  }

  /**
   * Stop all LSP servers (called on project close/switch)
   */
  private async stopLspServers(): Promise<void> {
    try {
      // Stop TypeScript LSP sidecar first
      await stopTsLsp();
      // Stop Tailwind LSP sidecar
      await stopTailwindLsp();
      // Stop ESLint LSP sidecar
      await stopEslintLsp();
      // Stop Svelte LSP sidecar
      await stopSvelteLsp();
      // Stop HTML/CSS/JSON/YAML/XML servers as well
      await stopHtmlLsp();
      await stopCssLsp();
      await stopJsonLsp();
      await stopYamlLsp();
      await stopXmlLsp();
      await stopDartLsp();
      // Then dispose the registry
      await disposeLspRegistry();
    } catch (e) {
      console.error('[ProjectStore] Error stopping LSP servers:', e);
    }
  }

  /**
   * Toggle folder expansion
   */
  async toggleFolder(node: TreeNode): Promise<void> {
    if (!node.isDir) return;

    if (node.expanded) {
      node.expanded = false;
      this.expandedPaths.delete(this.normalizePath(node.path));
      this.expandedPaths = new Set(this.expandedPaths);
      return;
    }

    // Load children if not loaded yet
    if (node.children === null) {
      node.loading = true;
      const entries = await listDirectory(node.path);
      node.loading = false;

      if (entries === null) {
        // Error already shown via toast
        return;
      }

      node.children = this.sortEntries(entries).map((entry) => this.createTreeNode(entry));
    }

    node.expanded = true;
    this.expandedPaths.add(this.normalizePath(node.path));
    this.expandedPaths = new Set(this.expandedPaths);
  }

  /**
   * Select single item (replaces existing selection)
   */
  selectItem(path: string): void {
    this.selectedPaths = new Set([path]);
  }

  /**
   * Toggle item selection (Ctrl+Click)
   */
  toggleSelection(path: string): void {
    if (this.selectedPaths.has(path)) {
      this.selectedPaths.delete(path);
      // Re-assign to trigger reactivity (Set itself isn't deeply tracked by value in $state unless replaced or using specialized patterns)
      this.selectedPaths = new Set(this.selectedPaths);
    } else {
      this.selectedPaths.add(path);
      this.selectedPaths = new Set(this.selectedPaths);
    }
  }

  /**
   * Add range to selection (Shift+Click)
   */
  selectRange(paths: string[]): void {
    paths.forEach(p => this.selectedPaths.add(p));
    this.selectedPaths = new Set(this.selectedPaths);
  }

  /**
   * Clear all selections
   */
  clearSelection(): void {
    if (this.selectedPaths.size > 0) {
      this.selectedPaths = new Set();
    }
  }

  /**
   * Select all paths provided
   */
  selectAll(paths: string[]): void {
    this.selectedPaths = new Set(paths);
  }

  /**
   * Refresh a specific folder's contents
   */
  async refreshFolder(node: TreeNode): Promise<void> {
    if (!node.isDir) return;

    node.loading = true;
    const entries = await listDirectory(node.path);
    node.loading = false;

    if (entries === null) return;

    node.children = this.sortEntries(entries).map((entry) => this.createTreeNode(entry));
    await this.restoreExpandedState(node.children);
  }

  /**
   * Refresh the entire tree
   */
  async refreshTree(): Promise<void> {
    if (!this.rootPath) return;

    this.loading = true;
    const entries = await listDirectory(this.rootPath);
    this.loading = false;

    if (entries === null) return;
    this.tree = this.sortEntries(entries).map((entry) => this.createTreeNode(entry));
    await this.restoreExpandedState(this.tree);
  }

  /**
   * Re-detect package manager (call after npm/yarn/pnpm install)
   * Useful when lock files are created after project was opened
   * Also notifies running ESLint server of the change
   */
  async refreshPackageManager(): Promise<void> {
    if (!this.rootPath) return;
    const detected = await this.detectPackageManager(this.rootPath);
    if (detected !== this.packageManager) {
      this.packageManager = detected;

      // Notify ESLint server of the configuration change
      // This avoids a full server restart while updating the packageManager setting
      await pushEslintConfig();
    }
  }

  /**
   * Find a node by path
   */
  findNode(path: string, nodes: TreeNode[] = this.tree): TreeNode | null {
    const normalizedTarget = this.normalizePath(path);
    for (const node of nodes) {
      if (this.normalizePath(node.path) === normalizedTarget) return node;
      if (node.children) {
        const found = this.findNode(path, node.children);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Add a new node to the tree (after file/folder creation)
   */
  addNode(parentPath: string, entry: FileEntry): void {
    const parentNode = this.findNode(parentPath);
    if (parentNode && parentNode.children) {
      const newNode = this.createTreeNode(entry);
      parentNode.children = this.sortEntries([...parentNode.children, newNode]);
    } else if (parentPath === this.rootPath) {
      const newNode = this.createTreeNode(entry);
      this.tree = this.sortEntries([...this.tree, newNode]);
    }
  }

  /**
   * Remove a node from the tree (after deletion)
   */
  removeNode(path: string): void {
    const normalizedPath = this.normalizePath(path);
    const removeFromArray = (nodes: TreeNode[]): TreeNode[] => {
      return nodes.filter((node) => {
        if (this.normalizePath(node.path) === normalizedPath) return false;
        if (node.children) {
          node.children = removeFromArray(node.children);
        }
        return true;
      });
    };

    this.tree = removeFromArray(this.tree);

    const nextSelected = new Set<string>();
    let selectionChanged = false;
    for (const selectedPath of this.selectedPaths) {
      if (this.normalizePath(selectedPath) === normalizedPath) {
        selectionChanged = true;
        continue;
      }
      nextSelected.add(selectedPath);
    }
    if (selectionChanged) {
      this.selectedPaths = nextSelected;
    }
    let changed = false;
    const next = new Set<string>();
    for (const p of this.expandedPaths) {
      if (p === normalizedPath || p.startsWith(normalizedPath + "/")) {
        changed = true;
        continue;
      }
      next.add(p);
    }
    if (changed) {
      this.expandedPaths = next;
    }
  }

  /**
   * Update a node's name (after rename)
   */
  updateNodePath(oldPath: string, newPath: string, newName: string): void {
    const node = this.findNode(oldPath);
    if (node) {
      node.path = newPath;
      node.name = newName;

      // Update children paths if it's a directory
      if (node.children) {
        this.updateChildrenPaths(node.children, oldPath, newPath);
      }

      if (this.selectedPaths.has(oldPath)) {
        this.selectedPaths.delete(oldPath);
        this.selectedPaths.add(newPath);
        this.selectedPaths = new Set(this.selectedPaths);
      }
    }

    const normalizedOld = this.normalizePath(oldPath);
    const normalizedNew = this.normalizePath(newPath);
    let updated = false;
    const next = new Set<string>();
    for (const p of this.expandedPaths) {
      if (p === normalizedOld) {
        next.add(normalizedNew);
        updated = true;
      } else if (p.startsWith(normalizedOld + "/")) {
        next.add(normalizedNew + p.slice(normalizedOld.length));
        updated = true;
      } else {
        next.add(p);
      }
    }
    if (updated) {
      this.expandedPaths = next;
    }
  }

  // Private helpers

  /**
   * Collapse all folders in the tree
   */
  collapseAllFolders(): void {
    const collapse = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.isDir) {
          node.expanded = false;
          if (node.children) collapse(node.children);
        }
      }
    };
    collapse(this.tree);
    this.expandedPaths = new Set();
  }

  /**
   * Expand folders up to a max depth (default 2) to avoid huge workspace lag.
   */
  async expandAllFolders(maxDepth = 2): Promise<void> {
    const expand = async (nodes: TreeNode[], depth: number): Promise<void> => {
      for (const node of nodes) {
        if (!node.isDir) continue;
        node.expanded = true;
        this.expandedPaths.add(this.normalizePath(node.path));

        if (node.children === null && depth < maxDepth) {
          node.loading = true;
          const entries = await listDirectory(node.path);
          node.loading = false;
          if (entries !== null) {
            node.children = this.sortEntries(entries).map((entry) =>
              this.createTreeNode(entry),
            );
          }
        }

        if (Array.isArray(node.children) && node.children.length > 0 && depth < maxDepth) {
          await expand(node.children, depth + 1);
        }
      }
    };

    await expand(this.tree, 0);
    this.expandedPaths = new Set(this.expandedPaths);
  }

  /**
   * Expand a single folder up to a max depth (default 2)
   */
  async expandFolder(node: TreeNode, maxDepth = 2): Promise<void> {
    if (!node.isDir) return;

    const expand = async (current: TreeNode, depth: number): Promise<void> => {
      if (!current.isDir) return;
      current.expanded = true;
      this.expandedPaths.add(this.normalizePath(current.path));

      if (current.children === null && depth < maxDepth) {
        current.loading = true;
        const entries = await listDirectory(current.path);
        current.loading = false;
        if (entries !== null) {
          current.children = this.sortEntries(entries).map((entry) =>
            this.createTreeNode(entry),
          );
        }
      }

      if (Array.isArray(current.children) && current.children.length > 0 && depth < maxDepth) {
        for (const child of current.children) {
          await expand(child, depth + 1);
        }
      }
    };

    await expand(node, 0);
    this.expandedPaths = new Set(this.expandedPaths);
  }

  private normalizePath(filePath: string): string {
    let normalized = filePath.replace(/\\/g, '/');
    if (normalized.match(/^[a-zA-Z]:/)) {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
  }

  private async restoreExpandedState(nodes: TreeNode[]): Promise<void> {
    for (const node of nodes) {
      if (!node.isDir) continue;
      const normalized = this.normalizePath(node.path);
      if (this.expandedPaths.has(normalized)) {
        node.expanded = true;
        if (node.children === null) {
          node.loading = true;
          const entries = await listDirectory(node.path);
          node.loading = false;
          if (entries !== null) {
            node.children = this.sortEntries(entries).map((entry) =>
              this.createTreeNode(entry),
            );
          }
        }
        if (Array.isArray(node.children) && node.children.length > 0) {
          await this.restoreExpandedState(node.children);
        }
      }
    }
  }

  private createTreeNode(entry: FileEntry): TreeNode {
    const normalized = this.normalizePath(entry.path);
    return {
      ...entry,
      children: entry.isDir ? null : [],
      expanded: entry.isDir ? this.expandedPaths.has(normalized) : false,
      loading: false
    };
  }

  private sortEntries<T extends FileEntry>(entries: T[]): T[] {
    return [...entries].sort((a, b) => {
      // Directories first
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      // Then alphabetically (case-insensitive)
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }

  private extractFolderName(path: string): string {
    // Handle both Windows and Unix paths
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  }

  private updateChildrenPaths(children: TreeNode[], oldParent: string, newParent: string): void {
    for (const child of children) {
      if (child.path.startsWith(oldParent)) {
        child.path = newParent + child.path.slice(oldParent.length);
      } else {
        child.path = child.path.replace(oldParent, newParent);
      }
      if (child.children) {
        this.updateChildrenPaths(child.children, oldParent, newParent);
      }
    }
  }

  private loadRecentProjects(): void {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
      if (stored) {
        this.recentProjects = JSON.parse(stored);
      }
    } catch {
      // Ignore errors
    }
  }

  private saveRecentProjects(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(this.recentProjects));
    } catch {
      // Ignore errors
    }
  }

  private addToRecentProjects(path: string): void {
    // Remove if already exists
    this.recentProjects = this.recentProjects.filter((p) => p !== path);
    // Add to front
    this.recentProjects = [path, ...this.recentProjects].slice(0, MAX_RECENT_PROJECTS);
    this.saveRecentProjects();
  }

  /**
   * Remove a project from recent list
   */
  removeFromRecentProjects(path: string): void {
    this.recentProjects = this.recentProjects.filter((p) => p !== path);
    this.saveRecentProjects();
  }

  private scheduleTreeRefresh(): void {
    if (this.treeRefreshTimer) clearTimeout(this.treeRefreshTimer);
    this.treeRefreshTimer = setTimeout(() => {
      if (this.rootPath) {
        void this.refreshTree();
      }
      this.treeRefreshTimer = null;
    }, 200);
  }

  private scheduleFolderRefresh(folderPath: string): void {
    const normalized = this.normalizePath(folderPath);
    const existing = this.pendingFolderRefreshes.get(normalized);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingFolderRefreshes.delete(normalized);
      const node = this.findNode(normalized);
      if (node && node.isDir && node.expanded) {
        void this.refreshFolder(node);
      } else if (normalized === this.normalizePath(this.rootPath ?? '')) {
        void this.refreshTree();
      } else {
        // Folder isn't visible; do nothing to avoid flicker.
      }
    }, 150);
    this.pendingFolderRefreshes.set(normalized, timer);
  }

  private async refreshParentFolder(absolutePath: string): Promise<void> {
    if (!this.rootPath) return;
    try {
      const parent = await dirname(absolutePath);
      const normalizedRoot = this.normalizePath(this.rootPath);
      const normalizedParent = this.normalizePath(parent);
      if (!normalizedParent.startsWith(normalizedRoot)) {
        this.scheduleTreeRefresh();
        return;
      }
      this.scheduleFolderRefresh(normalizedParent);
    } catch {
      this.scheduleTreeRefresh();
    }
  }
}

// Singleton instance
export const projectStore = new ProjectStore();
