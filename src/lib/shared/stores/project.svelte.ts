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
  clearIndex,
  getIndexStatus,
  handleFileChangeBatch,
  indexProject,
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
import { SvelteSet } from 'svelte/reactivity';
import { problemsStore } from './problems.svelte';
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
import {
  cleanupEditorStore,
  cleanupMcpStore,
  closeEditorFilesUnderPath,
  closeAllEditorFiles,
  initGitStore,
  hasOpenEditorFile,
  initializeMcpStore,
  reloadEditorFile,
  resetGitStore,
} from './project-bridge';
import { searchStore } from '$features/search/stores/search.svelte';
import { showToast } from '$shared/stores/toast.svelte';
import {
  projectTreeMutationState,
} from '$core/services/staged-document-projections';
import type { TreeMutationProjection } from '$core/services/staged-document-projections';
import type { StagedResourceRecord } from '$core/services/staged-document-service';
import { workspaceMutationCoordinator } from '$core/services/workspace-mutation-coordinator';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

/** Lock files to watch for package manager detection */
const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'];

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

export type StagedTreeOverlay = Record<string, TreeMutationProjection>;

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
const EXPANDED_PATHS_STORAGE_PREFIX = 'volt.project.expandedPaths:';

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
  stagedTreeOverlay = $state<StagedTreeOverlay>({});
  coreReady = $state(false);
  backgroundReady = $state(false);
  largeRepoMode = $state(false);
  indexedFileCount = $state(0);
  initialIndexDurationMs = $state(0);

  private diagTimer: ReturnType<typeof setTimeout> | null = null;
  private treeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private fileServiceUnsubscribe: (() => void) | null = null;
  private pendingFolderRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  private activationTaskTimers = new Set<ReturnType<typeof setTimeout>>();
  private startupGeneration = 0;
  private startupSerialChain: Promise<void> = Promise.resolve();
  private startupRootHasHeavyDirs = false;
  private stagedOverlayUnsubscribe: (() => void) | null = null;

  // File change handler cleanup
  private unsubscribeFileChange: (() => void) | null = null;

  // Initialization promise to coordinate other stores
  private resolveInitialized: (() => void) | null = null;
  private workspaceLifecycle = new WorkspaceLifecycleManager();
  public initialized = new Promise<void>((resolve) => {
    this.resolveInitialized = resolve;
  });

  constructor() {
    setTerminalProblemMatcherProjectRootResolver(() => this.rootPath);
    this.bindStagedTreeOverlay();
    this.registerWorkspaceLifecycleHooks();
    // Init must be called manually by the app root to avoid HMR loops
  }

  private registerWorkspaceLifecycleHooks(): void {
    this.workspaceLifecycle.register({
      id: 'project-store-core',
      teardown: async (context) => {
        const teardownErrors: Array<{ step: string; error: unknown }> = [];
        const runTeardownStep = async (step: string, task: () => Promise<void>): Promise<void> => {
          try {
            await task();
          } catch (error) {
            console.error(`[ProjectStore] Teardown step failed: ${step}`, error);
            teardownErrors.push({ step, error });
          }
        };

        this.startupGeneration += 1;
        this.startupSerialChain = Promise.resolve();
        this.clearActivationTasks();

        try {
          await runTeardownStep('stop file watching', async () => {
            await this.stopFileWatching();
          });
          await runTeardownStep('stop tsc watcher', async () => {
            await tscWatcher.stop();
          });
          resetWatchedFileDispatch();
          await runTeardownStep('stop lsp servers', async () => {
            await this.stopLspServers();
          });
          await runTeardownStep('cleanup mcp', async () => {
            await cleanupMcpStore();
          });
          await runTeardownStep('cleanup editor store subscriptions', async () => {
            await cleanupEditorStore();
          });
          await resetGitStore();
          await runTeardownStep('clear file index', async () => {
            await clearIndex(false);
          });
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
          this.clearWorkspaceScopedUiState();
          problemsStore.clearAll();
          terminalProblemMatcher.clear();
          await closeAllEditorFiles(true);
          const { terminalStore } = await import('$features/terminal/stores/terminal.svelte');
          await runTeardownStep('kill terminals', async () => {
            await terminalStore.killAll();
          });
        } finally {
          if (!context.preserveVisualState) {
            this.rootPath = null;
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
          this.clearStagedTreeOverlay();
        }

        if (teardownErrors.length > 0) {
          console.warn('[ProjectStore] Workspace teardown completed with errors', teardownErrors);
        }
      },
      activate: async ({ rootPath, reuseExistingWorkspace = false }) => {
        const generation = ++this.startupGeneration;
        this.packageManager = await this.detectPackageManager(rootPath);
        if (!this.isStartupCurrent(rootPath, generation)) return;

        initLspRegistry(rootPath);
        this.startupPhase = 'light';
        this.clearActivationTasks();
        this.startupSerialChain = Promise.resolve();

        this.scheduleActivationTask(rootPath, generation, 120, async () => {
          if (!(await this.isDartWorkspace(rootPath))) return;
          console.log('[ProjectStore] Dart/Flutter workspace detected, starting Dart LSP early...');
          await startDartLsp(rootPath);
        });
        this.scheduleActivationTask(rootPath, generation, 80, async () => {
          await this.startFileWatching(rootPath);
        });
        this.scheduleSerialActivationTask(rootPath, generation, 'core-bg', 150, async () => {
          await initGitStore(rootPath);
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

          if (reuseExistingWorkspace) {
            this.backgroundReady = true;
            return;
          }

          const diagnosticsDelay = this.largeRepoMode ? 4000 : 1800;
          const tscDelay = this.largeRepoMode ? 5500 : 2600;
          const semanticDelay = this.largeRepoMode ? 20000 : 8000;
          const mcpDelay = this.largeRepoMode ? 12000 : 6000;
          const finalizeDelay = this.largeRepoMode ? 7800 : 3400;

          this.scheduleSerialActivationTask(rootPath, generation, 'heavy-bg', diagnosticsDelay, async () => {
            await projectDiagnostics.runDiagnostics(rootPath);
          });
          this.scheduleSerialActivationTask(rootPath, generation, 'heavy-bg', tscDelay, async () => {
            await tscWatcher.start(rootPath);
          });
          this.scheduleSerialActivationTask(rootPath, generation, 'heavy-bg', 1800, async () => {
            if (!(await this.isDartWorkspace(rootPath))) return;
            console.log('[ProjectStore] Verifying Dart LSP after background startup...');
            await startDartLsp(rootPath);
          });
          this.scheduleSerialActivationTask(
            rootPath,
            generation,
            'background-ready',
            mcpDelay,
            async () => {
              await initializeMcpStore(rootPath);
            },
          );
          this.scheduleSerialActivationTask(
            rootPath,
            generation,
            'background-ready',
            semanticDelay,
            async () => {
              await warmSemanticIndex(rootPath);
            },
          );
          this.scheduleSerialActivationTask(rootPath, generation, 'background-ready', finalizeDelay, async () => {
            this.backgroundReady = true;
          });
        });
      },
    });
  }

  private bindStagedTreeOverlay(): void {
    this.stagedOverlayUnsubscribe?.();
    this.stagedOverlayUnsubscribe = workspaceMutationCoordinator.stagedDocuments.subscribe(
      (overlay: StagedTreeOverlay) => {
        this.stagedTreeOverlay = overlay;
      },
      {
        selector: (records: readonly StagedResourceRecord[]) => projectTreeMutationState(records),
        equality: (left: StagedTreeOverlay, right: StagedTreeOverlay) =>
          JSON.stringify(left) === JSON.stringify(right),
      },
    );
  }

  setStagedTreeOverlay(next: StagedTreeOverlay): void {
    this.stagedTreeOverlay = { ...next };
  }

  getTreeMutationProjection(path: string): TreeMutationProjection | null {
    return this.stagedTreeOverlay[this.normalizePath(path)] ?? this.stagedTreeOverlay[path] ?? null;
  }

  private clearStagedTreeOverlay(): void {
    this.stagedTreeOverlay = {};
  }

  private clearActivationTasks(): void {
    for (const timer of this.activationTaskTimers) {
      clearTimeout(timer);
    }
    this.activationTaskTimers.clear();
  }

  private invalidatePendingStartupWork(): void {
    this.startupGeneration += 1;
    this.startupSerialChain = Promise.resolve();
    this.clearActivationTasks();
    clearSemanticQueue();
  }

  private isStartupCurrent(rootPath: string, generation: number): boolean {
    return this.rootPath === rootPath && this.startupGeneration === generation;
  }

  private async isDartWorkspace(rootPath: string): Promise<boolean> {
    const [pubspecInfo, analysisOptionsInfo] = await Promise.all([
      getFileInfoQuiet(`${rootPath}/pubspec.yaml`),
      getFileInfoQuiet(`${rootPath}/analysis_options.yaml`),
    ]);
    return Boolean(pubspecInfo || analysisOptionsInfo);
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
      await this.syncWorkspaceState();
      const lastProject = this.workspaceLifecycle.getPersistedRootPath();
      if (lastProject) {
        console.log('[ProjectStore] Restoring last project:', lastProject);
        const restored = await this.openProject(lastProject);
        if (!restored) {
          this.removeFromRecentProjects(lastProject);
          await this.workspaceLifecycle.clearPersistedRootPath();
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
    try {
      // Check if we are already in this project (and it's valid)
      // This prevents re-initialization loops on HMR or redundant calls
      if (this.rootPath && this.rootPath === path) {
        console.log('[ProjectStore] Project already open:', path);
        return true;
      }

      if (this.rootPath && this.rootPath !== path) {
        // Cancel delayed startup work for the old workspace immediately. This
        // prevents restored-workspace semantic warmup / MCP startup from
        // continuing to launch while the user is already switching folders.
        this.invalidatePendingStartupWork();
      }

      const workspaceOpen = await this.workspaceLifecycle.open(path, this.rootPath);
      this.recentProjects = workspaceOpen.recentProjects;
      if (!workspaceOpen.opened || !workspaceOpen.activeRootPath) {
        if (this.rootPath || workspaceOpen.message) {
          showToast({
            message: workspaceOpen.message ?? `Failed to open folder: ${path}`,
            type: 'error',
          });
        }
        return false;
      }

      const shouldReuseExistingWorkspace = workspaceOpen.unchanged && !this.rootPath;

      if (workspaceOpen.unchanged && !shouldReuseExistingWorkspace) {
        console.log('[ProjectStore] Ignoring reopen for already-active workspace:', path);
        return true;
      }

      const entries = await listDirectory(workspaceOpen.activeRootPath);
      if (entries === null) {
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

      this.rootPath = workspaceOpen.activeRootPath;
      this.projectName = this.extractFolderName(workspaceOpen.activeRootPath);
      this.selectedPaths.clear();
      this.expandedPaths = this.loadExpandedPaths(workspaceOpen.activeRootPath);
      this.tree = this.sortEntries(entries).map((entry) => this.createTreeNode(entry));
      await this.restoreExpandedState(this.tree);
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
      this.recentProjects = workspaceOpen.recentProjects;

      await teardownPromise;
      await this.workspaceLifecycle.activate({
        rootPath: workspaceOpen.activeRootPath,
        previousRootPath,
        reuseExistingWorkspace: shouldReuseExistingWorkspace,
      });

      return true;
    } catch (error) {
      console.error('[ProjectStore] Failed to open project:', error);
      showToast({
        message: `Failed to open folder: ${path}`,
        type: 'error',
      });
      return false;
    } finally {
      this.loading = false;
    }
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
      void this.handleFileChanges(batch);
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
  private async handleFileChanges(batch: FileChangeBatchEvent): Promise<void> {
    // Update the file index incrementally
    const handledIncrementally = await handleFileChangeBatch(batch.changes);
    const hasLockfileChanges = batch.changes.some((change) =>
      change.paths.some((relativePath) => {
        const basename = relativePath.replace(/\\/g, '/').split('/').pop() || '';
        return LOCK_FILES.includes(basename);
      }),
    );
    const shouldRefreshDiagnostics =
      this.rootPath && this.shouldTriggerProjectDiagnostics(batch);

    // If too many changes, trigger a full rescan
    if (!handledIncrementally && this.rootPath) {
      // Large burst (git checkout / install): fall back to a full re-index.
      void indexProject(this.rootPath, false);

      // During huge clone/checkout bursts, per-file tree/LSP/semantic work can
      // overwhelm the UI. Refresh once and let background services catch up.
      this.scheduleTreeRefresh();
      if (hasLockfileChanges) {
        await this.refreshPackageManager();
      }
      if (shouldRefreshDiagnostics) {
        if (this.diagTimer) clearTimeout(this.diagTimer);
        this.diagTimer = setTimeout(() => {
          if (this.rootPath) {
            void projectDiagnostics.runDiagnostics(this.rootPath);
          }
          this.diagTimer = null;
        }, 1500);
      }
      return;
    }

    // Update the file tree for visible changes
    for (const change of batch.changes) {
      // Rename can include [old, new] paths.
      if (change.kind === 'rename' && change.absolutePaths.length >= 2 && change.paths.length >= 2) {
        const oldAbs = change.absolutePaths[0];
        const newAbs = change.absolutePaths[1];
        const newRel = change.paths[1];

        await this.handleFileDeleted(oldAbs);
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
            await this.handleFileDeleted(absPath);
            if (this.rootPath) queueSemanticRemove(this.rootPath, absPath);
            break;
          case 'rename':
            // If we only got the new path, best-effort refresh.
            this.handleFileCreated(absPath, relPath);
            if (this.rootPath) queueSemanticUpsert(this.rootPath, absPath);
            break;
          case 'modify': {
            // If the file is open in the editor, reload it to show new content
            // This handles AI edits appearing in real-time
            const normalizedPath = absPath.replace(/\\/g, '/');
            // Check if open (using internal array to avoid reactive dependency if possible, but state is fine)
            if (await hasOpenEditorFile(normalizedPath)) {
              void reloadEditorFile(absPath);
            }
            if (this.rootPath) queueSemanticUpsert(this.rootPath, absPath);
            break;
          }
        }
      }
    }

    const lspEvents = normalizeWatchedFileChanges(batch.changes);
    if (lspEvents.length > 0) {
      dispatchWatchedFileChanges(lspEvents);
    }

    if (hasLockfileChanges) {
      await this.refreshPackageManager();
      this.scheduleTreeRefresh();
    }

    // Debounce project-wide diagnostics only for relevant source/config changes.
    if (shouldRefreshDiagnostics) {
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
  private async handleFileDeleted(absolutePath: string): Promise<void> {
    // Remove from tree if present
    this.removeNode(absolutePath);
    await closeEditorFilesUnderPath(absolutePath, true);
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
    const result = await this.workspaceLifecycle.teardown({
      previousRootPath: this.rootPath,
      removePersistence: true,
      clearFileTree: true,
    });
    this.recentProjects = result.recentProjects;
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
      this.persistExpandedPaths();
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
    this.persistExpandedPaths();
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
    try {
      const result = await this.workspaceLifecycle.refresh(this.rootPath);
      this.recentProjects = result.recentProjects;
      const activeRootPath = result.activeRootPath ?? this.rootPath;
      if (!result.refreshed || !activeRootPath) {
        if (result.message) {
          showToast({ message: result.message, type: 'error' });
        }
        return;
      }

      const entries = await listDirectory(activeRootPath);
      if (entries === null) return;
      this.rootPath = activeRootPath;
      this.tree = this.sortEntries(entries).map((entry) => this.createTreeNode(entry));
      await this.restoreExpandedState(this.tree);
    } finally {
      this.loading = false;
    }
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

    const nextSelected = new SvelteSet<string>();
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
    const next = new SvelteSet<string>();
    for (const p of this.expandedPaths) {
      if (p === normalizedPath || p.startsWith(normalizedPath + "/")) {
        changed = true;
        continue;
      }
      next.add(p);
    }
    if (changed) {
      this.expandedPaths = next;
      this.persistExpandedPaths();
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
    const next = new SvelteSet<string>();
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
      this.persistExpandedPaths();
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
    this.persistExpandedPaths();
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
    this.persistExpandedPaths();
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
    this.persistExpandedPaths();
  }

  private normalizePath(filePath: string): string {
    let normalized = filePath.replace(/\\/g, '/');
    if (normalized.match(/^[a-zA-Z]:/)) {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
  }

  private getExpandedPathsStorageKey(rootPath: string): string {
    return `${EXPANDED_PATHS_STORAGE_PREFIX}${this.normalizePath(rootPath)}`;
  }

  private loadExpandedPaths(rootPath: string): Set<string> {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(this.getExpandedPathsStorageKey(rootPath));
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(
        parsed
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .map((value) => this.normalizePath(value)),
      );
    } catch {
      return new Set();
    }
  }

  private persistExpandedPaths(rootPath = this.rootPath): void {
    if (typeof window === 'undefined' || !rootPath) return;
    try {
      localStorage.setItem(
        this.getExpandedPathsStorageKey(rootPath),
        JSON.stringify([...this.expandedPaths]),
      );
    } catch {
      // Ignore persistence failures; explorer state should still work in-memory.
    }
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

  /**
   * Remove a project from recent list
   */
  removeFromRecentProjects(path: string): void {
    const normalized = this.normalizePath(path);
    this.recentProjects = this.recentProjects.filter((p) => this.normalizePath(p) !== normalized);
    void this.syncRecentProjectsToBackend();
  }

  public clearWorkspaceScopedUiState(): void {
    searchStore.clear();
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

  private async syncWorkspaceState(): Promise<void> {
    try {
      const state = await this.workspaceLifecycle.getState();
      this.recentProjects = state.recentProjects;
    } catch (error) {
      console.warn('[ProjectStore] Failed to sync workspace state:', error);
    }
  }

  private async syncRecentProjectsToBackend(): Promise<void> {
    try {
      const deduped = await invoke<string[]>('workspace_replace_recent_projects', {
        recentProjects: this.recentProjects,
      });
      this.recentProjects = deduped;
    } catch (error) {
      console.warn('[ProjectStore] Failed to sync recent projects:', error);
    }
  }
}

// Singleton instance
export const projectStore = new ProjectStore();
