<script lang="ts">
  /**
   * MonacoEditor - Lazy-loaded Monaco Editor wrapper
   * Loads Monaco only when first file opens
   *
   * Integrates with TypeScript LSP sidecar for full-project intelligence
   */
  import { onMount } from "svelte";
  import type * as Monaco from "monaco-editor";
  import { loadMonaco, detectLanguage } from "$lib/services/monaco-loader";
  import {
    getOrCreateModel,
    setActiveEditor,
  } from "$lib/services/monaco-models";
  import { notifyFileOpened } from "$lib/services/lsp/client";
  import {
    isTsJsFile,
    notifyDocumentOpened,
    notifyDocumentChanged,
  } from "$lib/services/lsp/typescript-sidecar";
  import {
    isTailwindFile,
    notifyTailwindDocumentOpened,
    notifyTailwindDocumentChanged,
  } from "$lib/services/lsp/tailwind-sidecar";
  import {
    isEslintFile,
    notifyEslintDocumentOpened,
    notifyEslintDocumentChanged,
  } from "$lib/services/lsp/eslint-sidecar";
  import {
    isSvelteFile,
    notifySvelteDocumentOpened,
    notifySvelteDocumentChanged,
  } from "$lib/services/lsp/svelte-sidecar";
  import { themeStore, getMonacoThemeName } from "$lib/stores/theme.svelte";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { problemsStore, type Problem } from "$lib/stores/problems.svelte";
  import EditorPlaceholder from "./EditorPlaceholder.svelte";

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
    filepath = "",
    value = "",
    language,
    readonly = false,
    onchange,
    onready,
  }: Props = $props();

  // State
  let containerRef: HTMLDivElement | null = $state(null);
  let loading = $state(true);
  let editor: Monaco.editor.IStandaloneCodeEditor | null = $state(null);
  let monaco: typeof Monaco | null = $state(null);

  let changeTimer: ReturnType<typeof setTimeout> | null = $state(null);
  let changeDisposable: Monaco.IDisposable | null = $state(null);
  let cursorDisposable: Monaco.IDisposable | null = $state(null);
  let selectionDisposable: Monaco.IDisposable | null = $state(null);

  // Derived language from filepath or explicit prop
  const detectedLanguage = $derived(language || detectLanguage(filepath));
  const filename = $derived(filepath.split(/[/\\]/).pop() || "");

  type NavigateToPositionDetail = {
    file: string;
    line: number;
    column: number;
  };

  let pendingNavigation = $state<NavigateToPositionDetail | null>(null);

  function normalizePath(path: string): string {
    return path.replace(/\\/g, "/");
  }

  function applyPendingNavigation(): void {
    if (!editor || !monaco || !filepath || !pendingNavigation) return;
    if (normalizePath(pendingNavigation.file) !== normalizePath(filepath))
      return;

    const model = editor.getModel();
    if (!model) return;

    const maxLine = model.getLineCount();
    const line = Math.max(1, Math.min(pendingNavigation.line, maxLine));
    const maxColumn = model.getLineMaxColumn(line);
    const column = Math.max(1, Math.min(pendingNavigation.column, maxColumn));

    editor.setPosition({ lineNumber: line, column });
    editor.revealPositionInCenter({ lineNumber: line, column });
    editor.focus();

    pendingNavigation = null;
  }

  // Handle navigation events from Problems panel (and other UI like Search)
  function handleNavigateToPosition(
    event: CustomEvent<NavigateToPositionDetail>,
  ): void {
    pendingNavigation = {
      ...event.detail,
      file: normalizePath(event.detail.file),
    };
    applyPendingNavigation();
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
          value: "",
          language: "plaintext",
          theme: getMonacoThemeName(),
          readOnly: readonly,
          automaticLayout: true,
          fontSize: settingsStore.editorFontSize,
          fontFamily:
            "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
          fontLigatures: true,
          lineNumbers: settingsStore.editorLineNumbersEnabled ? "on" : "off",
          minimap: { enabled: settingsStore.editorMinimapEnabled },
          scrollBeyondLastLine: false,
          renderWhitespace: "selection",
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          bracketPairColorization: { enabled: true },
          padding: { top: 8, bottom: 8 },
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
          // Enable LSP features
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          parameterHints: { enabled: true },
          wordBasedSuggestions: "currentDocument",
        });

        // Set active editor for go-to-line functionality
        setActiveEditor(editor);

        // Update cursor position in store
        const updateCursorInfo = () => {
          if (!editor) return;
          const position = editor.getPosition();
          const selection = editor.getSelection();
          const model = editor.getModel();

          if (position) {
            let selected = 0;
            if (selection && model && !selection.isEmpty()) {
              selected = model.getValueInRange(selection).length;
            }
            editorStore.setCursorPosition(
              position.lineNumber,
              position.column,
              selected,
            );
          }

          // Update indentation info from model options
          if (model) {
            const options = model.getOptions();
            editorStore.setEditorOptions(options.tabSize, options.insertSpaces);
          }
        };

        // Listen for cursor position changes
        cursorDisposable = editor.onDidChangeCursorPosition(updateCursorInfo);
        selectionDisposable =
          editor.onDidChangeCursorSelection(updateCursorInfo);

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

            // Notify Svelte LSP sidecar about the change
            if (filepath && isSvelteFile(filepath)) {
              notifySvelteDocumentChanged(filepath, newValue);
            }
          }, 75);
        });

        loading = false;

        // Notify parent that editor is ready
        if (onready && editor) {
          onready(editor);
        }
      } catch (err) {
        console.error("Failed to load Monaco Editor:", err);
        loading = false;
      }
    }

    initEditor();

    // Listen for navigation events from Problems panel
    window.addEventListener(
      "volt:navigate-to-position",
      handleNavigateToPosition as EventListener,
    );

    // Cleanup on unmount
    return () => {
      disposed = true;
      window.removeEventListener(
        "volt:navigate-to-position",
        handleNavigateToPosition as EventListener,
      );
      if (changeTimer) {
        clearTimeout(changeTimer);
        changeTimer = null;
      }
      if (changeDisposable) {
        changeDisposable.dispose();
        changeDisposable = null;
      }
      if (cursorDisposable) {
        cursorDisposable.dispose();
        cursorDisposable = null;
      }
      if (selectionDisposable) {
        selectionDisposable.dispose();
        selectionDisposable = null;
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
        language: lang,
      });

      if (!editor) return;
      editor.setModel(model);

      // Apply persisted indentation options to the model.
      try {
        model.updateOptions({
          tabSize: settingsStore.editorTabSize,
          insertSpaces: settingsStore.editorInsertSpaces,
        });
      } catch {
        // ignore
      }

      // If a navigation request came in before the model swap completed, apply it now.
      applyPendingNavigation();

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

      // Notify Svelte LSP sidecar about the file being opened
      if (isSvelteFile(path)) {
        await notifySvelteDocumentOpened(path, value);
      }
    })();
  });

  // Update readonly state
  $effect(() => {
    if (editor) {
      editor.updateOptions({ readOnly: readonly });
    }
  });

  // Update theme when theme store changes
  $effect(() => {
    const themeName = getMonacoThemeName();
    if (editor && monaco) {
      monaco.editor.setTheme(themeName);
    }
  });

  // Update editor options when settings change
  $effect(() => {
    const fontSize = settingsStore.editorFontSize;
    const lineNumbersEnabled = settingsStore.editorLineNumbersEnabled;
    const minimapEnabled = settingsStore.editorMinimapEnabled;
    const tabSize = settingsStore.editorTabSize;
    const insertSpaces = settingsStore.editorInsertSpaces;

    if (!editor) return;

    try {
      editor.updateOptions({
        fontSize,
        lineNumbers: lineNumbersEnabled ? "on" : "off",
        minimap: { enabled: minimapEnabled },
      });
    } catch {
      // ignore
    }

    try {
      const model = editor.getModel();
      model?.updateOptions({ tabSize, insertSpaces });
    } catch {
      // ignore
    }
  });
  // Sync problems from store to Monaco markers (squiggles)
  $effect(() => {
    if (!editor || !monaco || !filepath) return;

    // Ensure we use the same path normalization as the problemsStore (forward slashes + lowercase drive letter)
    let normalizedPath = filepath.replace(/\\/g, "/");
    if (normalizedPath.match(/^[a-zA-Z]:/)) {
      normalizedPath =
        normalizedPath[0].toLowerCase() + normalizedPath.slice(1);
    }

    // React to change in problems for this file
    const problems = problemsStore.problemsByFile[normalizedPath] || [];
    const model = editor.getModel();
    if (!model) return;

    // Convert our Problem type to Monaco IMarkerData
    const markers: Monaco.editor.IMarkerData[] = problems.map((p: Problem) => ({
      message: p.message,
      severity:
        p.severity === "error"
          ? monaco!.MarkerSeverity.Error
          : p.severity === "warning"
            ? monaco!.MarkerSeverity.Warning
            : p.severity === "hint"
              ? monaco!.MarkerSeverity.Hint
              : monaco!.MarkerSeverity.Info,
      startLineNumber: p.line,
      startColumn: p.column,
      endLineNumber: p.endLine || p.line,
      endColumn: p.endColumn || p.column + 1,
      source: p.source,
      code: p.code,
    }));

    // Set markers on the model
    // We use a specific owner name to avoid conflicts with Monaco's built-in markers
    monaco.editor.setModelMarkers(model, "volt-problems", markers);
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
