<script lang="ts">
  /**
   * MonacoEditor - Lazy-loaded Monaco Editor wrapper
   * Loads Monaco only when first file opens
   * 
   * Integrates with TypeScript LSP sidecar for full-project intelligence
   */
  import { onMount } from 'svelte';
  import type * as Monaco from 'monaco-editor';
  import { loadMonaco, detectLanguage } from '$lib/services/monaco-loader';
  import { getOrCreateModel } from '$lib/services/monaco-models';
  import { notifyFileOpened } from '$lib/services/lsp/client';
  import {
    isTsJsFile,
    notifyDocumentOpened,
    notifyDocumentChanged
  } from '$lib/services/lsp/typescript-sidecar';
  import {
    isTailwindFile,
    notifyTailwindDocumentOpened,
    notifyTailwindDocumentChanged
  } from '$lib/services/lsp/tailwind-sidecar';
  import {
    isEslintFile,
    notifyEslintDocumentOpened,
    notifyEslintDocumentChanged
  } from '$lib/services/lsp/eslint-sidecar';
  import EditorPlaceholder from './EditorPlaceholder.svelte';

  interface Props {
    /** File path for language detection */
    filepath?: string;
    /** Initial content */
    value?: string;
    /** Language override (auto-detected from filepath if not provided) */
    language?: string;
    /** Read-only mode */
    readonly?: boolean;
    /** Called when content changes */
    onchange?: (value: string) => void;
    /** Called when editor is ready */
    onready?: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
  }

  let {
    filepath = '',
    value = '',
    language,
    readonly = false,
    onchange,
    onready
  }: Props = $props();

  // State
  let containerRef: HTMLDivElement | null = $state(null);
  let loading = $state(true);
  let editor: Monaco.editor.IStandaloneCodeEditor | null = $state(null);
  let monaco: typeof Monaco | null = $state(null);

  let changeTimer: ReturnType<typeof setTimeout> | null = $state(null);
  let changeDisposable: Monaco.IDisposable | null = $state(null);

  // Derived language from filepath or explicit prop
  const detectedLanguage = $derived(language || detectLanguage(filepath));
  const filename = $derived(filepath.split(/[/\\]/).pop() || '');

  // Handle navigation events from Problems panel
  function handleNavigateToPosition(event: CustomEvent<{ file: string; line: number; column: number }>): void {
    if (!editor || !filepath) return;
    
    const { file, line, column } = event.detail;
    if (file !== filepath) return;
    
    editor.setPosition({ lineNumber: line, column });
    editor.revealPositionInCenter({ lineNumber: line, column });
    editor.focus();
  }

  // Initialize editor once
  onMount(() => {
    let disposed = false;

    async function initEditor() {
      if (!containerRef || disposed) return;

      try {
        // Load Monaco lazily
        monaco = await loadMonaco();
        
        if (disposed || !containerRef) return;

        // Create editor instance (model is set separately so we can swap models without recreating the editor)
        editor = monaco.editor.create(containerRef, {
          value: '',
          language: 'plaintext',
          theme: 'volt-dark',
          readOnly: readonly,
          automaticLayout: true,
          fontSize: 14,
          fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
          fontLigatures: true,
          lineNumbers: 'on',
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          bracketPairColorization: { enabled: true },
          padding: { top: 8, bottom: 8 },
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10
          },
          // Enable LSP features
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          parameterHints: { enabled: true },
          wordBasedSuggestions: 'currentDocument'
        });

        // Listen for content changes (debounced to avoid reactivity overhead on every keystroke)
        changeDisposable = editor.onDidChangeModelContent(() => {
          if (!editor) return;
          if (changeTimer) clearTimeout(changeTimer);
          changeTimer = setTimeout(() => {
            if (!editor) return;
            const newValue = editor.getValue();
            
            // Notify parent component
            if (onchange) onchange(newValue);
            
            // Notify TypeScript LSP sidecar about the change
            if (filepath && isTsJsFile(filepath)) {
              notifyDocumentChanged(filepath, newValue);
            }
            
            // Notify Tailwind LSP sidecar about the change
            if (filepath && isTailwindFile(filepath)) {
              notifyTailwindDocumentChanged(filepath, newValue);
            }
            
            // Notify ESLint LSP sidecar about the change
            if (filepath && isEslintFile(filepath)) {
              notifyEslintDocumentChanged(filepath, newValue);
            }
          }, 75);
        });

        loading = false;

        // Notify parent that editor is ready
        if (onready && editor) {
          onready(editor);
        }
      } catch (err) {
        console.error('Failed to load Monaco Editor:', err);
        loading = false;
      }
    }

    initEditor();

    // Listen for navigation events from Problems panel
    window.addEventListener('volt:navigate-to-position', handleNavigateToPosition as EventListener);

    // Cleanup on unmount
    return () => {
      disposed = true;
      window.removeEventListener('volt:navigate-to-position', handleNavigateToPosition as EventListener);
      if (changeTimer) {
        clearTimeout(changeTimer);
        changeTimer = null;
      }
      if (changeDisposable) {
        changeDisposable.dispose();
        changeDisposable = null;
      }
      if (editor) {
        editor.dispose();
        editor = null;
      }
    };
  });

  // Swap model when filepath changes. This keeps the editor instance alive (VS Code-style).
  $effect(() => {
    if (!editor || !monaco) return;
    if (!filepath) return;

    const path = filepath;
    const lang = detectedLanguage;

    // Notify Monaco LSP client about the file being opened
    notifyFileOpened(lang);

    void (async () => {
      const model = await getOrCreateModel({
        path,
        content: value,
        language: lang
      });

      if (!editor) return;
      editor.setModel(model);

      // Notify TypeScript LSP sidecar about the file being opened
      if (isTsJsFile(path)) {
        await notifyDocumentOpened(path, value);
      }
      
      // Notify Tailwind LSP sidecar about the file being opened
      if (isTailwindFile(path)) {
        await notifyTailwindDocumentOpened(path, value);
      }
      
      // Notify ESLint LSP sidecar about the file being opened
      if (isEslintFile(path)) {
        await notifyEslintDocumentOpened(path, value);
      }
    })();
  });

  // Update readonly state
  $effect(() => {
    if (editor) {
      editor.updateOptions({ readOnly: readonly });
    }
  });
</script>

<div class="monaco-wrapper">
  {#if loading}
    <EditorPlaceholder {filename} />
  {/if}
  <div
    class="monaco-container"
    class:hidden={loading}
    bind:this={containerRef}
  ></div>
</div>

<style>
  .monaco-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
  }

  .monaco-container {
    width: 100%;
    height: 100%;
  }

  .monaco-container.hidden {
    visibility: hidden;
    position: absolute;
  }
</style>
