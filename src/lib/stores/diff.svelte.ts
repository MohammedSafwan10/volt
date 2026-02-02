/**
 * Diff View Store - Manages Monaco DiffEditor state
 * Provides proper VS Code-style inline diff with red/green highlighting
 */

export interface DiffState {
  /** Whether diff view is active */
  active: boolean;
  /** File path being diffed */
  filePath: string;
  /** Original content (before changes) */
  originalContent: string;
  /** Modified content (after changes) */
  modifiedContent: string;
  /** Language for syntax highlighting */
  language: string;
  /** Title for the diff view */
  title: string;
  /** Tool call ID for tracking (optional) */
  toolCallId?: string;
  /** Whether to use inline mode (vs side-by-side) */
  inlineMode: boolean;
}

class DiffStore {
  /** Current diff state */
  state = $state<DiffState>({
    active: false,
    filePath: '',
    originalContent: '',
    modifiedContent: '',
    language: 'plaintext',
    title: '',
    inlineMode: true, // Default to inline mode like VS Code Copilot
  });

  /** Whether diff view is currently active */
  get isActive(): boolean {
    return this.state.active;
  }

  /** Get the current diff file path */
  get filePath(): string {
    return this.state.filePath;
  }

  /**
   * Open diff view for a file
   * Shows the difference between original and modified content
   */
  openDiff(options: {
    filePath: string;
    originalContent: string;
    modifiedContent: string;
    language?: string;
    title?: string;
    toolCallId?: string;
    inlineMode?: boolean;
  }): void {
    const fileName = options.filePath.split(/[/\\]/).pop() || 'file';
    
    this.state = {
      active: true,
      filePath: options.filePath,
      originalContent: options.originalContent,
      modifiedContent: options.modifiedContent,
      language: options.language || this.detectLanguage(options.filePath),
      title: options.title || `Diff: ${fileName}`,
      toolCallId: options.toolCallId,
      inlineMode: options.inlineMode ?? true,
    };
  }

  /**
   * Close diff view and return to normal editor
   */
  closeDiff(): void {
    this.state = {
      active: false,
      filePath: '',
      originalContent: '',
      modifiedContent: '',
      language: 'plaintext',
      title: '',
      toolCallId: undefined,
      inlineMode: true,
    };
  }

  /**
   * Toggle between inline and side-by-side mode
   */
  toggleInlineMode(): void {
    this.state.inlineMode = !this.state.inlineMode;
  }

  /**
   * Set inline mode explicitly
   */
  setInlineMode(inline: boolean): void {
    this.state.inlineMode = inline;
  }

  /**
   * Accept the changes (close diff, sync modified content to editor)
   */
  async acceptChanges(): Promise<void> {
    const { filePath, modifiedContent } = this.state;
    
    // Close the diff first
    this.closeDiff();
    
    // Sync the modified content to the editor if file is open
    if (filePath && modifiedContent) {
      try {
        const { editorStore } = await import('./editor.svelte');
        await editorStore.updateFileContent(filePath, modifiedContent);
      } catch (err) {
        console.error('[diffStore] Failed to sync accepted changes:', err);
      }
    }
  }

  /**
   * Reject the changes (revert to original content)
   */
  async rejectChanges(): Promise<void> {
    const { filePath, originalContent } = this.state;
    
    // Close the diff first
    this.closeDiff();
    
    // Revert to original content if file is open
    if (filePath && originalContent) {
      try {
        const { editorStore } = await import('./editor.svelte');
        const { writeFile } = await import('$lib/services/file-system');
        
        // Write original content back to disk
        await writeFile(filePath, originalContent);
        
        // Sync to editor
        await editorStore.updateFileContent(filePath, originalContent);
      } catch (err) {
        console.error('[diffStore] Failed to revert changes:', err);
      }
    }
  }

  /**
   * Simple language detection from file path
   */
  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      json: 'json',
      html: 'html',
      css: 'css',
      scss: 'scss',
      less: 'less',
      md: 'markdown',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      kt: 'kotlin',
      swift: 'swift',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      rb: 'ruby',
      php: 'php',
      sql: 'sql',
      yaml: 'yaml',
      yml: 'yaml',
      xml: 'xml',
      svelte: 'svelte',
      vue: 'vue',
      dart: 'dart',
      sh: 'shell',
      bash: 'shell',
      zsh: 'shell',
      ps1: 'powershell',
      toml: 'toml',
    };
    return languageMap[ext] || 'plaintext';
  }
}

export const diffStore = new DiffStore();
