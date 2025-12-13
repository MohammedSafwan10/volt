/**
 * Project state store using Svelte 5 runes
 * Manages the currently open project/folder and file tree state
 */

import { listDirectory } from '$lib/services/file-system';
import { initLspRegistry, disposeLspRegistry } from '$lib/services/lsp/sidecar';
import type { FileEntry } from '$lib/types/files';

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

  constructor() {
    this.loadRecentProjects();
  }

  /**
   * Open a project folder
   */
  async openProject(path: string): Promise<boolean> {
    this.loading = true;

    // Stop any existing LSP servers from previous project
    if (this.rootPath && this.rootPath !== path) {
      await this.stopLspServers();
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

    // Initialize LSP registry with new project root
    initLspRegistry(path);

    return true;
  }

  /**
   * Close the current project
   */
  async closeProject(): Promise<void> {
    // Stop all LSP servers when closing project
    await this.stopLspServers();

    this.rootPath = null;
    this.projectName = '';
    this.tree = [];
    this.selectedPath = null;
  }

  /**
   * Stop all LSP servers (called on project close/switch)
   */
  private async stopLspServers(): Promise<void> {
    try {
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
