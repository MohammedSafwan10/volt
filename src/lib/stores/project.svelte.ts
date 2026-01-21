/**
 * Project state store using Svelte 5 runes
 * Manages the currently open project/folder and file tree state
 * 
 * Features:
 * - File tree management
 * - Package manager auto-detection (npm/yarn/pnpm)
 * - File watching for lock files (VS Code-like behavior)
 */

import { listDirectory, getFileInfoQuiet } from '$lib/services/file-system';
import { initLspRegistry, disposeLspRegistry } from '$lib/services/lsp/sidecar';
import { stopTsLsp } from '$lib/services/lsp/typescript-sidecar';
import { stopTailwindLsp } from '$lib/services/lsp/tailwind-sidecar';
import { stopEslintLsp, pushEslintConfig } from '$lib/services/lsp/eslint-sidecar';
import { stopSvelteLsp } from '$lib/services/lsp/svelte-sidecar';
import {
  cancelIndexing,
  clearIndex,
  handleFileChangeBatch,
  indexProject,
  getIndexedRoot,
} from '$lib/services/file-index';
import { notifyFileChanges as notifyDartFileChanges, startDartLsp } from '$lib/services/lsp/dart-sidecar';
import { terminalProblemMatcher } from '$lib/services/terminal-problem-matcher';
import {
  startWatching as startFileWatching,
  stopWatching as stopFileWatching,
  onFileChange,
  type FileChangeBatchEvent,
} from '$lib/services/file-watch';
import { projectDiagnostics } from '$lib/services/project-diagnostics';
import { problemsStore } from './problems.svelte';
import { mcpStore } from './mcp.svelte';
import { editorStore } from './editor.svelte';
import { gitStore } from './git.svelte';
import type { FileEntry } from '$lib/types/files';
import { invoke } from '@tauri-apps/api/core';

// Tauri FS plugin for file watching
import { watch, type UnwatchFn, type WatchEvent } from '@tauri-apps/plugin-fs';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

/** Lock files to watch for package manager detection */
const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'];

const RECENT_PROJECTS_KEY = 'volt.recentProjects';
const MAX_RECENT_PROJECTS = 10;

export interface TreeNode extends FileEntry {
  children: TreeNode[] | null;
  expanded: boolean;
  loading: boolean;
}

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

  // Currently selected file path
  selectedPath = $state<string | null>(null);

  // Detected package manager for the project
  packageManager = $state<PackageManager>('npm');

  // File watcher unlisten function
  private unwatch: UnwatchFn | null = null;
  private unwatchLockFiles: UnwatchFn | null = null;
  private diagTimer: any = null;

  // Fallback polling when fs watch is unavailable (e.g. scope restrictions)
  private lockFilePollTimer: ReturnType<typeof setInterval> | null = null;
  private lockFileLastModified = new Map<string, number | null>();
  private lockFilePollInFlight = false;

  // File change handler cleanup
  private unsubscribeFileChange: (() => void) | null = null;

  constructor() {
    this.loadRecentProjects();
  }

  /**
   * Open a project folder
   */
  async openProject(path: string): Promise<boolean> {
    this.loading = true;

    // Stop any existing LSP servers and cancel file indexing from previous project
    if (this.rootPath && this.rootPath !== path) {
      await this.stopLspServers();
      await cancelIndexing();
    }

    const entries = await listDirectory(path);
    if (entries === null) {
      // Keep the currently-open project visible if a refresh/switch fails.
      this.loading = false;
      return false;
    }

    this.rootPath = path;
    this.projectName = this.extractFolderName(path);
    this.tree = this.sortEntries(entries).map((entry) => this.createTreeNode(entry));
    this.selectedPath = null;
    this.loading = false;
    this.addToRecentProjects(path);

    // Detect package manager from lock files
    this.packageManager = await this.detectPackageManager(path);

    // Start watching lock files for changes (VS Code-like behavior)
    await this.startWatchingLockFiles(path);

    // Initialize LSP registry with new project root
    initLspRegistry(path);

    // Initialize MCP servers with workspace path
    void mcpStore.initialize(path);

    // Initialize git store for auto-refresh and status badges
    // This runs in background, doesn't block project open
    void gitStore.init(path);

    // Start file watching for incremental index updates
    await this.startFileWatching(path);

    // Initial project index for Quick Open and project-wide analysis
    void indexProject(path);

    // Run project-wide diagnostics (tsc, eslint) in background
    void projectDiagnostics.runDiagnostics(path);

    // Auto-start Dart LSP for Flutter/Dart projects to enable project-wide diagnostics immediately
    void (async () => {
      const pubspecInfo = await getFileInfoQuiet(`${path}/pubspec.yaml`);
      if (pubspecInfo) {
        console.log('[ProjectStore] Dart project detected, starting LSP...');
        await startDartLsp(path);
      }
    })();

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
        continue;
      }

      for (let i = 0; i < change.absolutePaths.length; i++) {
        const absPath = change.absolutePaths[i];
        const relPath = change.paths[i];

        switch (change.kind) {
          case 'create':
            this.handleFileCreated(absPath, relPath);
            break;
          case 'delete':
            this.handleFileDeleted(absPath);
            break;
          case 'rename':
            // If we only got the new path, best-effort refresh.
            this.handleFileCreated(absPath, relPath);
            break;
          case 'modify':
            // If the file is open in the editor, reload it to show new content
            // This handles AI edits appearing in real-time
            const normalizedPath = absPath.replace(/\\/g, '/');
            // Check if open (using internal array to avoid reactive dependency if possible, but state is fine)
            if (editorStore.openFiles.some(f => f.path === normalizedPath)) {
              void editorStore.reloadFile(absPath);
            }
            break;
        }
      }
    }

    // Notify LSPs about file changes (for closed files)
    // Map internal event types to LSP types: create/modify/delete -> create/change/delete
    const lspEvents = [];
    for (const change of batch.changes) {
      // "modify" in backend -> "change" in our LSP helper
      const kind = change.kind === 'modify' ? 'change' : (change.kind as 'create' | 'change' | 'delete');

      // Skip renames for simply notifying changed content, handled as delete+create or custom logic usually
      // For now, treat rename as create of new file for analysis purposes
      if (change.kind === 'rename') {
        // handle as create of new path
        if (change.absolutePaths.length > 1) {
          lspEvents.push({ kind: 'create' as const, path: change.absolutePaths[1] });
          lspEvents.push({ kind: 'delete' as const, path: change.absolutePaths[0] });
        }
        continue;
      }

      for (const absPath of change.absolutePaths) {
        if (kind === 'create' || kind === 'change' || kind === 'delete') {
          lspEvents.push({ kind, path: absPath });
        }
      }
    }

    if (lspEvents.length > 0) {
      // Notify Dart LSP
      void notifyDartFileChanges(lspEvents);
    }

    // Debounce project-wide diagnostics
    if (this.rootPath) {
      if (this.diagTimer) clearTimeout(this.diagTimer);
      this.diagTimer = setTimeout(() => {
        if (this.rootPath) {
          void projectDiagnostics.runDiagnostics(this.rootPath);
        }
        this.diagTimer = null;
      }, 2000); // 2 second debounce
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
    if (parentAbsPath === this.rootPath || (parentNode && parentNode.expanded && parentNode.children)) {
      // Refresh the parent folder to get the new file
      if (parentNode) {
        void this.refreshFolder(parentNode);
      } else {
        // Root level - refresh tree
        void this.refreshTree();
      }
    }
  }

  /**
   * Handle a file being deleted
   */
  private handleFileDeleted(absolutePath: string): void {
    // Remove from tree if present
    this.removeNode(absolutePath);
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
      await invoke('fs_allow_directory', { path: projectPath, recursive: false });

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
    // Stop file watching
    await this.stopFileWatching();

    // Stop watching lock files
    await this.stopWatchingLockFiles();

    // Stop all LSP servers when closing project
    await this.stopLspServers();

    // Stop all MCP servers
    await mcpStore.cleanup();

    // Reset git store
    gitStore.reset();

    // Cancel file indexing and clear the index
    await clearIndex(false);

    // Clear all problems
    problemsStore.clearAll();
    terminalProblemMatcher.clear();

    // Close all open editor tabs (VS Code behavior)
    editorStore.closeAllFiles(true);

    // Kill all terminals (VS Code behavior - terminals are project-specific)
    const { terminalStore } = await import('./terminal.svelte');
    await terminalStore.killAll();

    this.rootPath = null;
    this.projectName = '';
    this.tree = [];
    this.selectedPath = null;
    this.packageManager = 'npm';
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
  }

  /**
   * Select a file or folder
   */
  selectItem(path: string): void {
    this.selectedPath = path;
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
  }

  /**
   * Refresh the entire tree
   */
  async refreshTree(): Promise<void> {
    if (!this.rootPath) return;
    await this.openProject(this.rootPath);
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
    for (const node of nodes) {
      if (node.path === path) return node;
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
    const removeFromArray = (nodes: TreeNode[]): TreeNode[] => {
      return nodes.filter((node) => {
        if (node.path === path) return false;
        if (node.children) {
          node.children = removeFromArray(node.children);
        }
        return true;
      });
    };

    this.tree = removeFromArray(this.tree);

    if (this.selectedPath === path) {
      this.selectedPath = null;
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

      if (this.selectedPath === oldPath) {
        this.selectedPath = newPath;
      }
    }
  }

  // Private helpers

  private createTreeNode(entry: FileEntry): TreeNode {
    return {
      ...entry,
      children: entry.isDir ? null : [],
      expanded: false,
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
}

// Singleton instance
export const projectStore = new ProjectStore();
