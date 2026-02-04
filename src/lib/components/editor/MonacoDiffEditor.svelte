<script lang="ts">
  /**
   * MonacoDiffEditor - Monaco Diff Editor with inline/side-by-side modes
   * Shows red for deleted lines, green for added lines (VS Code style)
   */
  import { onMount } from 'svelte';
  import type * as Monaco from 'monaco-editor';
  import { loadMonaco } from '$lib/services/monaco-loader';
  import { themeStore, getMonacoThemeName } from '$lib/stores/theme.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { diffStore } from '$lib/stores/diff.svelte';
  import EditorPlaceholder from './EditorPlaceholder.svelte';

  interface Props {
    /** Original content (left side - before changes) */
    originalContent: string;
    /** Modified content (right side - after changes) */
    modifiedContent: string;
    /** Language for syntax highlighting */
    language?: string;
    /** Title to display */
    title?: string;
    /** Whether to render inline (vs side-by-side) */
    renderSideBySide?: boolean;
    /** Called when user closes the diff view */
    onClose?: () => void;
    /** Called when user accepts the changes */
    onAccept?: () => void;
    /** Called when user rejects the changes */
    onReject?: () => void;
  }

  let {
    originalContent,
    modifiedContent,
    language = 'plaintext',
    title = 'Diff View',
    renderSideBySide = false,
    onClose,
    onAccept,
    onReject,
  }: Props = $props();

  // State
  let containerRef: HTMLDivElement | null = $state(null);
  let loading = $state(true);
  let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = $state(null);
  let monaco: typeof Monaco | null = $state(null);
  let originalModel: Monaco.editor.ITextModel | null = $state(null);
  let modifiedModel: Monaco.editor.ITextModel | null = $state(null);
  let hasRevealedFirstChange = $state(false);

  // Computed stats
  let diffStats = $state({ added: 0, removed: 0, changed: 0 });

  // Calculate diff statistics
  function calculateDiffStats(): void {
    if (!diffEditor) return;
    
    const lineChanges = diffEditor.getLineChanges();
    if (!lineChanges) {
      diffStats = { added: 0, removed: 0, changed: 0 };
      return;
    }

    let added = 0;
    let removed = 0;
    let changed = 0;

    for (const change of lineChanges) {
      const origLines = change.originalEndLineNumber - change.originalStartLineNumber + 1;
      const modLines = change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
      
      if (change.originalStartLineNumber > change.originalEndLineNumber) {
        // Pure addition
        added += modLines;
      } else if (change.modifiedStartLineNumber > change.modifiedEndLineNumber) {
        // Pure deletion
        removed += origLines;
      } else {
        // Modification
        changed += Math.max(origLines, modLines);
      }
    }

    diffStats = { added, removed, changed };
  }

  // Navigate to next diff
  function goToNextDiff(): void {
    if (!diffEditor) return;
    diffEditor.goToDiff('next');
  }

  // Navigate to previous diff
  function goToPrevDiff(): void {
    if (!diffEditor) return;
    diffEditor.goToDiff('previous');
  }

  // Reveal the first change in the modified editor
  function revealFirstChange(): void {
    if (!diffEditor) return;
    const changes = diffEditor.getLineChanges();
    if (!changes || changes.length === 0) return;

    const first = changes[0];
    const targetLine =
      first.modifiedStartLineNumber > 0
        ? first.modifiedStartLineNumber
        : first.originalStartLineNumber > 0
          ? first.originalStartLineNumber
          : 1;

    const editor = diffEditor.getModifiedEditor();
    editor.revealLineInCenter(targetLine);
    editor.setPosition({ lineNumber: targetLine, column: 1 });
  }

  // Toggle between inline and side-by-side
  function toggleViewMode(): void {
    diffStore.toggleInlineMode();
  }

  // Handle accept
  async function handleAccept(): Promise<void> {
    if (onAccept) onAccept();
    await diffStore.acceptChanges();
  }

  // Handle reject
  async function handleReject(): Promise<void> {
    if (onReject) onReject();
    await diffStore.rejectChanges();
  }

  // Handle close
  function handleClose(): void {
    if (onClose) onClose();
    diffStore.closeDiff();
  }

  // Initialize diff editor
  onMount(() => {
    let disposed = false;

    async function initDiffEditor() {
      if (!containerRef || disposed) return;

      try {
        monaco = await loadMonaco();
        if (disposed || !containerRef) return;

        // Create models for original and modified content
        originalModel = monaco.editor.createModel(
          originalContent,
          language,
          monaco.Uri.parse(`inmemory://diff/original/${Date.now()}`)
        );

        modifiedModel = monaco.editor.createModel(
          modifiedContent,
          language,
          monaco.Uri.parse(`inmemory://diff/modified/${Date.now()}`)
        );

        // Create diff editor
        diffEditor = monaco.editor.createDiffEditor(containerRef, {
          theme: getMonacoThemeName(),
          automaticLayout: true,
          fontSize: settingsStore.editorFontSize,
          fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
          fontLigatures: true,
          readOnly: true, // Diff view is read-only
          renderSideBySide: !diffStore.state.inlineMode,
          renderSideBySideInlineBreakpoint: 0,
          useInlineViewWhenSpaceIsLimited: false,
          enableSplitViewResizing: true,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          padding: { top: 8, bottom: 8 },
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
          minimap: { enabled: false },
          // Enhanced diff options
          renderIndicators: true,
          renderMarginRevertIcon: false,
          ignoreTrimWhitespace: false,
          // Make diffs more visible
          diffWordWrap: 'off',
        });

        // Set models
        diffEditor.setModel({
          original: originalModel,
          modified: modifiedModel,
        });

        // Calculate stats after a short delay (wait for diff computation)
        setTimeout(calculateDiffStats, 100);

        // Listen for diff updates
        diffEditor.onDidUpdateDiff(() => {
          calculateDiffStats();
          if (!hasRevealedFirstChange) {
            revealFirstChange();
            hasRevealedFirstChange = true;
          }
        });

        loading = false;
      } catch (err) {
        console.error('Failed to load Monaco Diff Editor:', err);
        loading = false;
      }
    }

    initDiffEditor();

    // Cleanup
    return () => {
      disposed = true;
      if (diffEditor) {
        diffEditor.dispose();
        diffEditor = null;
      }
      if (originalModel) {
        originalModel.dispose();
        originalModel = null;
      }
      if (modifiedModel) {
        modifiedModel.dispose();
        modifiedModel = null;
      }
    };
  });

  // Update view mode when store changes
  $effect(() => {
    const inlineMode = diffStore.state.inlineMode;
    if (diffEditor) {
      diffEditor.updateOptions({
        renderSideBySide: !inlineMode,
        renderSideBySideInlineBreakpoint: 0,
        useInlineViewWhenSpaceIsLimited: false,
      });
      diffEditor.layout();
    }
  });

  // Update theme when it changes
  $effect(() => {
    const themeName = getMonacoThemeName();
    if (diffEditor && monaco) {
      monaco.editor.setTheme(themeName);
    }
  });
</script>

<div class="diff-editor-wrapper">
  <!-- Toolbar -->
  <div class="diff-toolbar">
    <div class="diff-toolbar-left">
      <span class="diff-title">{title}</span>
      <div class="diff-stats">
        {#if diffStats.added > 0}
          <span class="stat-added">+{diffStats.added}</span>
        {/if}
        {#if diffStats.removed > 0}
          <span class="stat-removed">-{diffStats.removed}</span>
        {/if}
        {#if diffStats.changed > 0}
          <span class="stat-changed">~{diffStats.changed}</span>
        {/if}
      </div>
    </div>
    
    <div class="diff-toolbar-center">
      <button 
        class="diff-nav-btn" 
        onclick={goToPrevDiff}
        title="Previous Change (↑)"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 4l4 4H4l4-4zm0 4v6H7V8h1z"/>
        </svg>
      </button>
      <button 
        class="diff-nav-btn" 
        onclick={goToNextDiff}
        title="Next Change (↓)"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 12l-4-4h8l-4 4zm0-4V2h1v6H8z"/>
        </svg>
      </button>
      <div class="toolbar-separator"></div>
      <button 
        class="diff-mode-btn"
        class:active={!diffStore.state.inlineMode}
        onclick={toggleViewMode}
        title={diffStore.state.inlineMode ? 'Switch to Side-by-Side' : 'Switch to Inline'}
      >
        {#if diffStore.state.inlineMode}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 1H2a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V2a1 1 0 00-1-1zM8 14H2V2h6v12zm6 0H9V2h5v12z"/>
          </svg>
          <span>Side by Side</span>
        {:else}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 1H2a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V2a1 1 0 00-1-1zm0 13H2V2h12v12z"/>
          </svg>
          <span>Inline</span>
        {/if}
      </button>
    </div>

    <div class="diff-toolbar-right">
      <button class="diff-action-btn reject" onclick={handleReject} title="Reject Changes">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/>
        </svg>
        <span>Discard</span>
      </button>
      <button class="diff-action-btn accept" onclick={handleAccept} title="Accept Changes">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
        </svg>
        <span>Accept</span>
      </button>
      <button class="diff-close-btn" onclick={handleClose} title="Close Diff View">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/>
        </svg>
      </button>
    </div>
  </div>

  <!-- Diff Editor Container -->
  <div class="diff-container">
    {#if loading}
      <EditorPlaceholder filename="Loading diff..." />
    {/if}
    <div 
      class="diff-editor-container" 
      class:hidden={loading}
      bind:this={containerRef}
    ></div>
  </div>
</div>

<style>
  .diff-editor-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--editor-background, #1e1e1e);
  }

  .diff-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--titlebar-background, #323233);
    border-bottom: 1px solid var(--border-color, #3c3c3c);
    gap: 12px;
    flex-shrink: 0;
  }

  .diff-toolbar-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
  }

  .diff-toolbar-center {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .diff-toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    justify-content: flex-end;
  }

  .diff-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--foreground, #cccccc);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diff-stats {
    display: flex;
    gap: 8px;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  .stat-added {
    color: #4ec9b0;
  }

  .stat-removed {
    color: #f14c4c;
  }

  .stat-changed {
    color: #dcdcaa;
  }

  .diff-nav-btn,
  .diff-mode-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--foreground, #cccccc);
    cursor: pointer;
    font-size: 11px;
    transition: background 0.15s;
  }

  .diff-nav-btn:hover,
  .diff-mode-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .diff-mode-btn.active {
    background: rgba(255, 255, 255, 0.08);
  }

  .toolbar-separator {
    width: 1px;
    height: 16px;
    background: var(--border-color, #3c3c3c);
    margin: 0 4px;
  }

  .diff-action-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .diff-action-btn.accept {
    background: #28a745;
    color: white;
  }

  .diff-action-btn.accept:hover {
    background: #2ea043;
  }

  .diff-action-btn.reject {
    background: transparent;
    color: #f14c4c;
    border: 1px solid #f14c4c;
  }

  .diff-action-btn.reject:hover {
    background: rgba(241, 76, 76, 0.1);
  }

  .diff-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--foreground, #cccccc);
    cursor: pointer;
    opacity: 0.7;
    transition: all 0.15s;
  }

  .diff-close-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    opacity: 1;
  }

  .diff-container {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .diff-editor-container {
    width: 100%;
    height: 100%;
  }

  .diff-editor-container.hidden {
    visibility: hidden;
    position: absolute;
  }
</style>
