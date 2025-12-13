/**
 * Editor state store using Svelte 5 runes
 * Manages open files, active file, and file content
 */

import { readFile } from '$lib/services/file-system';
import { disposeAllModels, disposeModel } from '$lib/services/monaco-models';
import { notifyFileClosed } from '$lib/services/lsp/client';

export interface OpenFile {
  /** Full file path */
  path: string;
  /** File name (for display) */
  name: string;
  /** File content */
  content: string;
  /** Original content (for dirty detection) */
  originalContent: string;
  /** Language for syntax highlighting */
  language: string;
}

class EditorStore {
  /** List of open files */
  openFiles = $state<OpenFile[]>([]);
  
  /** Path of the currently active file */
  activeFilePath = $state<string | null>(null);

  /** Get the currently active file */
  get activeFile(): OpenFile | null {
    if (!this.activeFilePath) return null;
    return this.openFiles.find(f => f.path === this.activeFilePath) ?? null;
  }

  /** Check if a file is dirty (has unsaved changes) */
  isDirty(path: string): boolean {
    const file = this.openFiles.find(f => f.path === path);
    if (!file) return false;
    return file.content !== file.originalContent;
  }

  /** Check if any file is dirty */
  get hasUnsavedChanges(): boolean {
    return this.openFiles.some(f => f.content !== f.originalContent);
  }

  /**
   * Open a file in the editor
   * If already open, just switch to it
   */
  async openFile(path: string): Promise<boolean> {
    // Check if already open
    const existing = this.openFiles.find(f => f.path === path);
    if (existing) {
      this.activeFilePath = path;
      return true;
    }

    // Read file content
    const content = await readFile(path);
    if (content === null) {
      // Error already shown via toast in readFile
      return false;
    }

    // Extract filename
    const name = path.split(/[/\\]/).pop() || path;

    // Detect language from extension
    const language = this.detectLanguage(name);

    // Add to open files
    const newFile: OpenFile = {
      path,
      name,
      content,
      originalContent: content,
      language
    };

    this.openFiles = [...this.openFiles, newFile];
    this.activeFilePath = path;

    return true;
  }

  /**
   * Close a file
   * Returns false if file has unsaved changes and user cancels
   * Selects the nearest neighbor (prefer right, then left) when closing active tab
   */
  closeFile(path: string, force = false): boolean {
    const fileIndex = this.openFiles.findIndex(f => f.path === path);
    if (fileIndex === -1) return true;

    const file = this.openFiles[fileIndex];

    // Check for unsaved changes
    if (!force && this.isDirty(path)) {
      const confirmed = confirm(`"${file.name}" has unsaved changes. Close anyway?`);
      if (!confirmed) return false;
    }

    // Determine next active file before removing (VS Code behavior: prefer right neighbor, then left)
    let nextActivePath: string | null = null;
    if (this.activeFilePath === path && this.openFiles.length > 1) {
      if (fileIndex < this.openFiles.length - 1) {
        // There's a tab to the right - select it
        nextActivePath = this.openFiles[fileIndex + 1].path;
      } else if (fileIndex > 0) {
        // No tab to the right, select the one to the left
        nextActivePath = this.openFiles[fileIndex - 1].path;
      }
    }

    // Remove from open files
    this.openFiles = this.openFiles.filter(f => f.path !== path);
    disposeModel(path);
		notifyFileClosed(file.language);

    // Update active file
    if (this.activeFilePath === path) {
      this.activeFilePath = nextActivePath;
    }

    return true;
  }

  /**
   * Close all files
   * Returns false if any file has unsaved changes and user cancels
   */
  closeAllFiles(force = false): boolean {
    if (!force && this.hasUnsavedChanges) {
      const confirmed = confirm('You have unsaved changes. Close all files anyway?');
      if (!confirmed) return false;
    }

		for (const file of this.openFiles) {
			notifyFileClosed(file.language);
		}
    this.openFiles = [];
    this.activeFilePath = null;
    disposeAllModels();
    return true;
  }

  /**
   * Set the active file
   */
  setActiveFile(path: string): void {
    if (this.openFiles.some(f => f.path === path)) {
      this.activeFilePath = path;
    }
  }

  /**
   * Cycle to the next tab (Ctrl+Tab behavior)
   */
  nextTab(): void {
    if (this.openFiles.length <= 1) return;
    
    const currentIndex = this.openFiles.findIndex(f => f.path === this.activeFilePath);
    const nextIndex = (currentIndex + 1) % this.openFiles.length;
    this.activeFilePath = this.openFiles[nextIndex].path;
  }

  /**
   * Cycle to the previous tab (Ctrl+Shift+Tab behavior)
   */
  previousTab(): void {
    if (this.openFiles.length <= 1) return;
    
    const currentIndex = this.openFiles.findIndex(f => f.path === this.activeFilePath);
    const prevIndex = currentIndex <= 0 ? this.openFiles.length - 1 : currentIndex - 1;
    this.activeFilePath = this.openFiles[prevIndex].path;
  }

  /**
   * Update file content (called when editor content changes)
   */
  updateContent(path: string, content: string): void {
    const file = this.openFiles.find(f => f.path === path);
    if (file) {
      file.content = content;
    }
  }

  /**
   * Mark file as saved (update original content to match current)
   */
  markSaved(path: string): void {
    const file = this.openFiles.find(f => f.path === path);
    if (file) {
      file.originalContent = file.content;
    }
  }

  /**
   * Reload file content from disk
   */
  async reloadFile(path: string): Promise<boolean> {
    const file = this.openFiles.find(f => f.path === path);
    if (!file) return false;

    const content = await readFile(path);
    if (content === null) return false;

    file.content = content;
    file.originalContent = content;
    return true;
  }

  /**
   * Detect language from filename
   */
  private detectLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    
    const languageMap: Record<string, string> = {
      // JavaScript/TypeScript
      'js': 'javascript',
      'mjs': 'javascript',
      'cjs': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'mts': 'typescript',
      'cts': 'typescript',
      
      // Web
      'html': 'html',
      'htm': 'html',
      'css': 'css',
      'scss': 'scss',
      'sass': 'scss',
      'less': 'less',
      
      // Data formats
      'json': 'json',
      'jsonc': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'svg': 'xml',
      
      // Markdown
      'md': 'markdown',
      'mdx': 'markdown',
      
      // Config files
      'toml': 'ini',
      'ini': 'ini',
      'env': 'ini',
      
      // Shell
      'sh': 'shell',
      'bash': 'shell',
      'zsh': 'shell',
      'ps1': 'powershell',
      'bat': 'bat',
      'cmd': 'bat',
      
      // Other languages
      'py': 'python',
      'rs': 'rust',
      'go': 'go',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'sql': 'sql',
      'graphql': 'graphql',
      'gql': 'graphql',
      
      // Svelte/Vue
      'svelte': 'html',
      'vue': 'html'
    };

    return languageMap[ext] || 'plaintext';
  }
}

// Singleton instance
export const editorStore = new EditorStore();
