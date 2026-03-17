<script lang="ts">
  /**
   * MonacoEditor - Lazy-loaded Monaco Editor wrapper
   * Loads Monaco only when first file opens
   *
   * Integrates with TypeScript LSP sidecar for full-project intelligence
   */
  import { onMount } from "svelte";
  import type * as Monaco from "monaco-editor";
  import { loadMonaco, detectLanguage } from "$core/services/monaco-loader";
  import {
    getOrCreateModel,
    setActiveEditor,
  } from "$core/services/monaco-models";
  import { notifyFileOpened } from "$core/lsp/client";
  import {
    isTsJsFile,
    notifyDocumentOpened,
    notifyDocumentChanged,
  } from "$core/lsp/typescript-sidecar";
  import {
    isTailwindFile,
    notifyTailwindDocumentOpened,
    notifyTailwindDocumentChanged,
  } from "$core/lsp/tailwind-sidecar";
  import {
    isEslintFile,
    notifyEslintDocumentOpened,
    notifyEslintDocumentChanged,
  } from "$core/lsp/eslint-sidecar";
  import {
    isSvelteFile,
    notifySvelteDocumentOpened,
    notifySvelteDocumentChanged,
  } from "$core/lsp/svelte-sidecar";
  import {
    isHtmlFile,
    notifyHtmlDocumentOpened,
    notifyHtmlDocumentChanged,
  } from "$core/lsp/html-sidecar";
  import {
    isCssFile,
    notifyCssDocumentOpened,
    notifyCssDocumentChanged,
  } from "$core/lsp/css-sidecar";
  import {
    isJsonFile,
    notifyJsonDocumentOpened,
    notifyJsonDocumentChanged,
  } from "$core/lsp/json-sidecar";
  import {
    isDartLspFile,
    notifyDocumentOpened as notifyDartDocumentOpened,
    notifyDocumentChanged as notifyDartDocumentChanged,
  } from "$core/lsp/dart-sidecar";
  import {
    isYamlFile,
    notifyDocumentOpened as notifyYamlDocumentOpened,
    notifyDocumentChanged as notifyYamlDocumentChanged,
  } from "$core/lsp/yaml-sidecar";
  import {
    isXmlFile,
    notifyDocumentOpened as notifyXmlDocumentOpened,
    notifyDocumentChanged as notifyXmlDocumentChanged,
  } from "$core/lsp/xml-sidecar";
  import { themeStore, getMonacoThemeName } from "$shared/stores/theme.svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { settingsStore } from "$shared/stores/settings.svelte";
  import { problemsStore, type Problem } from "$shared/stores/problems.svelte";
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
  let markersDisposable: Monaco.IDisposable | null = $state(null);
  let cursorDisposable: Monaco.IDisposable | null = $state(null);
  let selectionDisposable: Monaco.IDisposable | null = $state(null);
  let modelSwapRunId = 0;

  const MONACO_NATIVE_SOURCE = "monaco-native";

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

  function normalizeProblemsPath(path: string): string {
    let normalized = path.replace(/\\/g, "/");
    if (normalized.match(/^[a-zA-Z]:/)) {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
  }

  function isTransientSidecarOpenError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null
          ? JSON.stringify(error)
          : String(error ?? "");
    return (
      /transport not connected/i.test(message) ||
      /server exited/i.test(message) ||
      /servernotfound/i.test(message) ||
      /spawn failed/i.test(message) ||
      /canceled/i.test(message)
    );
  }

  async function safelyNotifySidecar(
    label: string,
    notify: () => Promise<void>,
  ): Promise<void> {
    try {
      await notify();
    } catch (error) {
      if (isTransientSidecarOpenError(error)) return;
      console.warn(`[MonacoEditor] ${label} sidecar open notification failed`, error);
    }
  }

  function applyProblemsMarkersForCurrentModel(
    model: Monaco.editor.ITextModel,
    targetFilePath: string,
  ): void {
    if (!monaco) return;
    const monacoInstance = monaco;

    const normalizedPath = normalizeProblemsPath(targetFilePath);
    const problems = problemsStore.getProblemsForFile(normalizedPath);

    const markers: Monaco.editor.IMarkerData[] = problems.map((p: Problem) => ({
      message: p.message,
      severity:
        p.severity === "error"
          ? monacoInstance.MarkerSeverity.Error
          : p.severity === "warning"
            ? monacoInstance.MarkerSeverity.Warning
            : p.severity === "hint"
              ? monacoInstance.MarkerSeverity.Hint
              : monacoInstance.MarkerSeverity.Info,
      startLineNumber: p.line,
      startColumn: p.column,
      endLineNumber: p.endLine || p.line,
      endColumn: p.endColumn || p.column + 1,
      source: p.source,
      code: p.code,
    }));

    monacoInstance.editor.setModelMarkers(model, "volt-problems", markers);
  }

  function nativeMarkerFingerprint(marker: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    message: string;
    severity: Monaco.MarkerSeverity;
    code?: unknown;
  }): string {
    const code =
      typeof marker.code === "string"
        ? marker.code
        : marker.code && typeof marker.code === "object" && "value" in marker.code
          ? String(marker.code.value)
          : "";

    return [
      marker.startLineNumber,
      marker.startColumn,
      marker.endLineNumber,
      marker.endColumn,
      marker.message.trim(),
      marker.severity,
      code,
    ].join("|");
  }

  function problemFingerprint(problem: Problem): string {
    return [
      problem.line,
      problem.column,
      problem.endLine,
      problem.endColumn,
      problem.message.trim(),
      problem.severity,
      problem.code ?? "",
    ].join("|");
  }

  function mapNativeMarkerSeverity(
    severity: Monaco.MarkerSeverity,
  ): Problem["severity"] {
    if (!monaco) return "info";
    switch (severity) {
      case monaco.MarkerSeverity.Error:
        return "error";
      case monaco.MarkerSeverity.Warning:
        return "warning";
      case monaco.MarkerSeverity.Hint:
        return "hint";
      default:
        return "info";
    }
  }

  function syncNativeDiagnosticsForCurrentModel(): void {
    if (!editor || !monaco || !filepath) return;
    const model = editor.getModel();
    if (!model) return;

    const nativeMarkers = monaco.editor
      .getModelMarkers({ resource: model.uri })
      .filter((marker) => marker.owner !== "volt-problems");

    const normalizedPath = normalizeProblemsPath(filepath);
    const fileName = normalizedPath.split(/[/\\]/).pop() || normalizedPath;
    const providerFingerprints = new Set(
      problemsStore
        .getDedupedProblemsForFile(normalizedPath)
        .filter((problem) => problem.source !== MONACO_NATIVE_SOURCE)
        .map((problem) => problemFingerprint(problem)),
    );

    const nativeProblems: Problem[] = nativeMarkers
      .filter((marker) => !providerFingerprints.has(nativeMarkerFingerprint(marker)))
      .map((marker, index) => ({
        id: `${MONACO_NATIVE_SOURCE}:${normalizedPath}:${marker.startLineNumber}:${marker.startColumn}:${index}`,
        file: normalizedPath,
        fileName,
        line: marker.startLineNumber,
        column: marker.startColumn,
        endLine: marker.endLineNumber,
        endColumn: marker.endColumn,
        message: marker.message,
        severity: mapNativeMarkerSeverity(marker.severity),
        source: marker.source || marker.owner || MONACO_NATIVE_SOURCE,
        code:
          typeof marker.code === "string"
            ? marker.code
            : marker.code && typeof marker.code === "object" && "value" in marker.code
              ? String(marker.code.value)
              : undefined,
      }));

    problemsStore.setProblemsForFile(
      normalizedPath,
      nativeProblems,
      MONACO_NATIVE_SOURCE,
    );
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
          renderValidationDecorations: "on",
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

            if (filepath && isHtmlFile(filepath)) {
              notifyHtmlDocumentChanged(filepath, newValue);
            }

            if (filepath && isCssFile(filepath)) {
              notifyCssDocumentChanged(filepath, newValue);
            }

            if (filepath && isJsonFile(filepath)) {
              notifyJsonDocumentChanged(filepath, newValue);
            }

            if (filepath && isDartLspFile(filepath)) {
              notifyDartDocumentChanged(filepath, newValue);
            }

            if (filepath && isYamlFile(filepath)) {
              notifyYamlDocumentChanged(filepath, newValue);
            }

            if (filepath && isXmlFile(filepath)) {
              notifyXmlDocumentChanged(filepath, newValue);
            }
          }, 75);
        });

        markersDisposable = monaco.editor.onDidChangeMarkers((uris) => {
          if (!editor) return;
          const model = editor.getModel();
          if (!model) return;
          const currentUri = model.uri.toString();
          const affectsCurrentModel = uris.some(
            (uri) => uri.toString() === currentUri,
          );
          if (affectsCurrentModel) {
            syncNativeDiagnosticsForCurrentModel();
          }
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
      if (markersDisposable) {
        markersDisposable.dispose();
        markersDisposable = null;
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
    const runId = modelSwapRunId + 1;
    modelSwapRunId = runId;

    // Notify Monaco LSP client about the file being opened
    notifyFileOpened(lang);

    void (async () => {
      const model = await getOrCreateModel({
        path,
        content: value,
        language: lang,
      });

      if (!editor || runId !== modelSwapRunId) return;
      editor.setModel(model);

      applyProblemsMarkersForCurrentModel(model, path);
      syncNativeDiagnosticsForCurrentModel();

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
        await safelyNotifySidecar("typescript", () => notifyDocumentOpened(path, value));
      }

      // Notify Tailwind LSP sidecar about the file being opened
      if (isTailwindFile(path)) {
        await safelyNotifySidecar("tailwind", () => notifyTailwindDocumentOpened(path, value));
      }

      // Notify ESLint LSP sidecar about the file being opened
      if (isEslintFile(path)) {
        await safelyNotifySidecar("eslint", () => notifyEslintDocumentOpened(path, value));
      }

      // Notify Svelte LSP sidecar about the file being opened
      if (isSvelteFile(path)) {
        await safelyNotifySidecar("svelte", () => notifySvelteDocumentOpened(path, value));
      }

      // Notify HTML LSP sidecar about the file being opened
      if (isHtmlFile(path)) {
        await safelyNotifySidecar("html", () => notifyHtmlDocumentOpened(path, value));
      }

      // Notify CSS LSP sidecar about the file being opened
      if (isCssFile(path)) {
        await safelyNotifySidecar("css", () => notifyCssDocumentOpened(path, value));
      }

      // Notify JSON LSP sidecar about the file being opened
      if (isJsonFile(path)) {
        await safelyNotifySidecar("json", () => notifyJsonDocumentOpened(path, value));
      }

      // Notify Dart LSP sidecar about the file being opened
      if (isDartLspFile(path)) {
        await safelyNotifySidecar("dart", () => notifyDartDocumentOpened(path, value));
      }

      // Notify YAML LSP sidecar about the file being opened
      if (isYamlFile(path)) {
        await safelyNotifySidecar("yaml", () => notifyYamlDocumentOpened(path, value));
      }

      // Notify XML LSP sidecar about the file being opened
      if (isXmlFile(path)) {
        await safelyNotifySidecar("xml", () => notifyXmlDocumentOpened(path, value));
      }
    })().catch((error) => {
      if (isTransientSidecarOpenError(error)) return;
      console.warn("[MonacoEditor] Model swap failed", error);
    });
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
    const model = editor.getModel();
    if (!model) return;

    applyProblemsMarkersForCurrentModel(model, filepath);
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
