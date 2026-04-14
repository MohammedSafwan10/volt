<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import MenuBar from "./MenuBar.svelte";
  import StatusBar from "./StatusBar.svelte";
  import ResizablePanel from "./ResizablePanel.svelte";
  import AboutModal from "./AboutModal.svelte";
  import { ActivityBar, SidePanel } from "$shared/components/sidebar";
  import SettingsPanel from "$shared/components/sidebar/SettingsPanel.svelte";
  import { WelcomeScreen } from "$shared/components/welcome";
  import Breadcrumb from "$features/editor/components/editor/Breadcrumb.svelte";
  import EmptyState from "$features/editor/components/editor/EmptyState.svelte";
  import FilePreview from "$features/editor/components/editor/FilePreview.svelte";
  import GoToLineDialog from "$features/editor/components/editor/GoToLineDialog.svelte";
  import { TabBar } from "$features/editor/components/tabs";
  import {
    CommandPalette,
    SymbolPicker,
  } from "$features/editor/components/command-palette";
  import { BottomPanel } from "$shared/components/panel";
  import { AssistantPanel } from "$features/assistant/components";
  import SpecHeaderBar from "$features/specs/components/SpecHeaderBar.svelte";
  import { specStore } from "$features/specs/stores/specs.svelte";
  import { loadXterm } from "$features/terminal/services/terminal-loader";
  import {
    getModelLineCount,
    getModelValue,
    revealLine,
    runEditorAction,
    setModelValue,
  } from "$core/services/monaco-models";
  import { uiStore } from "$shared/stores/ui.svelte";
  import { bottomPanelStore } from "$shared/stores/bottom-panel.svelte";
  import { projectStore } from "$shared/stores/project.svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import {
    VOLT_SETTINGS_PATH,
    isVoltVirtualPath,
  } from "$features/editor/stores/editor.svelte";
  import { terminalStore } from "$features/terminal/stores/terminal.svelte";
  import { logOutput } from "$features/terminal/stores/output.svelte";
  import { settingsStore } from "$shared/stores/settings.svelte";
  import { assistantStore } from "$features/assistant/stores/assistant.svelte";
  import { diffStore } from "$features/editor/stores/diff.svelte";
  import { openFolderDialog, writeFile } from "$core/services/file-system";
  import {
    initAutoSave,
    destroyAutoSave,
    scheduleAutoSave,
    triggerImmediateAutoSave,
  } from "$features/editor/services/auto-save";
  import { disposeLspRegistry } from "$core/lsp/sidecar";
  import {
    formatBeforeSave,
    formatCurrentDocument,
    isPrettierFile,
  } from "$core/services/prettier";
  import { runtimeTelemetry } from "$core/services/runtime-telemetry";
  import { mcpStore } from "$features/mcp/stores/mcp.svelte";
  import { stateSnapshotService } from "$core/services/state-snapshot";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  // Command palette reference
  let commandPalette: ReturnType<typeof CommandPalette> | undefined = $state();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MonacoEditorComponent = $state<Component<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MonacoDiffEditorComponent = $state<Component<any> | null>(null);
  let monacoFeatureLoading = $state(false);
  let xtermWarmStarted = $state(false);
  let mcpInitStarted = $state(false);

  function emitShellDebug(message: string): void {
    console.info("[VoltStartup]", message);
    void invoke("debug_log_frontend", {
      topic: "frontend",
      message,
    }).catch(() => {});
  }

  function getFileExt(path: string): string {
    const name = path.split(/[/\\]/).pop() ?? path;
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
  }

  function shouldUseRichPreview(path: string): boolean {
    if (specStore.isEditableSpecMarkdown(path)) {
      return false;
    }
    const ext = getFileExt(path);
    return (
      ext === "md" ||
      ext === "mdx" ||
      ext === "pdf" ||
      ext === "png" ||
      ext === "jpg" ||
      ext === "jpeg" ||
      ext === "gif" ||
      ext === "webp" ||
      ext === "bmp" ||
      ext === "ico" ||
      ext === "avif" ||
      ext === "tif" ||
      ext === "tiff" ||
      ext === "mp3" ||
      ext === "wav" ||
      ext === "ogg" ||
      ext === "oga" ||
      ext === "flac" ||
      ext === "aac" ||
      ext === "m4a" ||
      ext === "mp4" ||
      ext === "mpeg" ||
      ext === "mpg" ||
      ext === "webm" ||
      ext === "mov" ||
      ext === "avi" ||
      ext === "m4v" ||
      ext === "ogv"
    );
  }

  // Go to Line dialog state
  let goToLineOpen = $state(false);
  let goToLineMax = $state(1);

  // Symbol picker state
  let symbolPickerOpen = $state(false);
  let symbolPickerMode = $state<"file" | "workspace">("file");

  // Key-chord state (VS Code style, e.g. Ctrl+K Ctrl+O)
  let chordActive = $state(false);
  let chordTimer: ReturnType<typeof setTimeout> | null = $state(null);

  function startChord(): void {
    chordActive = true;
    if (chordTimer) clearTimeout(chordTimer);
    chordTimer = setTimeout(() => {
      chordActive = false;
      chordTimer = null;
    }, 1500);
  }

  function clearChord(): void {
    chordActive = false;
    if (chordTimer) {
      clearTimeout(chordTimer);
      chordTimer = null;
    }
  }

  async function handleOpenFolder(): Promise<void> {
    uiStore.closeMenus();
    const path = await openFolderDialog();
    if (!path) return;
    const success = await projectStore.openProject(path);
    if (success) {
      uiStore.setActiveSidebarPanel("explorer");
    }
  }

  function openGoToLine(): void {
    if (!editorStore.activeFile) return;
    const lineCount = getModelLineCount(editorStore.activeFile.path);
    goToLineMax = lineCount || 1;
    goToLineOpen = true;
  }

  async function ensureMonacoFeatureLoaded(): Promise<void> {
    if (MonacoEditorComponent && MonacoDiffEditorComponent) return;
    if (monacoFeatureLoading) return;

    monacoFeatureLoading = true;
    try {
      const [editorModule, diffModule] = await Promise.all([
        import("$features/editor/components/editor/MonacoEditor.svelte"),
        import("$features/editor/components/editor/MonacoDiffEditor.svelte"),
      ]);
      MonacoEditorComponent = editorModule.default;
      MonacoDiffEditorComponent = diffModule.default;
    } catch (error) {
      console.error("[MainLayout] Failed to load Monaco feature bundle:", error);
    } finally {
      monacoFeatureLoading = false;
    }
  }

  async function handleGoToLine(line: number): Promise<void> {
    if (!editorStore.activeFile) return;
    revealLine(editorStore.activeFile.path, line);
  }

  // Handle symbol picker open event from command palette
  function handleOpenSymbolPicker(
    e: CustomEvent<{ mode: "file" | "workspace" }>,
  ): void {
    symbolPickerMode = e.detail.mode;
    symbolPickerOpen = true;
  }

  // Handle go to line open event from command palette
  function handleOpenGoToLine(): void {
    openGoToLine();
  }

  function ensureXtermWarm(): void {
    if (xtermWarmStarted) return;
    xtermWarmStarted = true;
    logOutput("Volt", "Warming terminal on first use...");
    void loadXterm();
  }

  function ensureMcpInitialized(): void {
    if (mcpInitStarted) return;
    mcpInitStarted = true;
    logOutput("Volt", "Initializing MCP on demand...");
    void mcpStore.initialize(projectStore.rootPath ?? undefined);
  }

  // Initialize lightweight app services immediately.
  onMount(() => {
    emitShellDebug("MainLayout onMount start");
    logOutput("Volt", "Volt IDE started");
    const telemetryDebug =
      typeof localStorage !== "undefined" &&
      localStorage.getItem("volt.runtimeTelemetry.log") === "1";
    runtimeTelemetry.start(30_000, telemetryDebug);
    initAutoSave();
    logOutput("Volt", "Auto-save initialized");

    // Initialize ProjectStore (restores last project)
    // We do this here instead of in the store constructor to avoid HMR loops
    void projectStore
      .init()
      .then(() => {
        emitShellDebug("projectStore.init resolved");
      })
      .catch((error) => {
        const message =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        emitShellDebug(`projectStore.init failed: ${message}`);
        if (error instanceof Error && error.stack) {
          emitShellDebug(`projectStore.init.stack ${error.stack}`);
        }
      });

    // Handle window beforeunload to clean up services
    const handleBeforeUnload = () => {
      void disposeLspRegistry();
      void mcpStore.cleanup();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    // Listen for symbol picker open events from command palette
    window.addEventListener(
      "volt:open-symbol-picker",
      handleOpenSymbolPicker as (event: Event) => void,
    );
    window.addEventListener(
      "volt:open-go-to-line",
      handleOpenGoToLine as (event: Event) => void,
    );

    return () => {
      runtimeTelemetry.stop();
      destroyAutoSave();
      // Do not kill terminals on component unmount/reload.
      // Backend handles terminal cleanup on actual window close.
      // Do not stop all LSP servers on ordinary component unmount/reload.
      // `beforeunload` handles true window shutdown, and eager teardown here can
      // kill live sidecars during HMR/layout churn.
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener(
        "volt:open-symbol-picker",
        handleOpenSymbolPicker as (event: Event) => void,
      );
      window.removeEventListener(
        "volt:open-go-to-line",
        handleOpenGoToLine as (event: Event) => void,
      );
    };
  });

  $effect(() => {
    if (uiStore.bottomPanelOpen && bottomPanelStore.activeTab === "terminal") {
      ensureXtermWarm();
    }
  });

  $effect(() => {
    if (uiStore.sidebarOpen && uiStore.activeSidebarPanel === "mcp") {
      ensureMcpInitialized();
    }
  });

  // Handle file selection from file tree
  async function handleFileSelect(path: string): Promise<void> {
    // Ensure edits are persisted before switching active file via the explorer.
    triggerImmediateAutoSave();
    await editorStore.openFile(path);
  }

  // Handle editor content changes
  function handleEditorChange(content: string): void {
    if (editorStore.activeFilePath) {
      editorStore.updateContent(editorStore.activeFilePath, content);
      specStore.handleActiveFileDraftChanged(editorStore.activeFilePath, content);
      // Schedule auto-save after typing stops
      scheduleAutoSave();
    }
  }

  // Handle file save
  async function handleSave(): Promise<void> {
    const activeFile = editorStore.activeFile;
    if (!activeFile) return;

    // Virtual/read-only docs (like Settings) are not saved to disk.
    if (activeFile.readonly || isVoltVirtualPath(activeFile.path)) return;

    // Prefer saving the live Monaco model value to avoid any lag from debounced store updates.
    let contentToSave = activeFile.content;
    const modelValue = getModelValue(activeFile.path);
    if (typeof modelValue === "string") {
      contentToSave = modelValue;
      editorStore.updateContent(activeFile.path, modelValue);
    }

    if (
      settingsStore.formatOnSaveEnabled &&
      isPrettierFile(activeFile.path)
    ) {
      const formatted = await formatBeforeSave(
        contentToSave,
        activeFile.path,
      );
      if (formatted !== contentToSave) {
        contentToSave = formatted;
        setModelValue(activeFile.path, formatted);
        editorStore.updateContent(activeFile.path, formatted);
      }
    }

    const success = await writeFile(activeFile.path, contentToSave, {
      expectedVersion: editorStore.getDocumentVersion(activeFile.path) ?? undefined,
    });
    if (success) {
      editorStore.markSaved(activeFile.path);
      await specStore.handleActiveFileSaved(activeFile.path, contentToSave);
    }
  }

  async function applyNativeZoom(zoomPercent: number) {
    if (typeof window === "undefined") return;

    const scaleFactor = Math.max(0.5, Math.min(2.0, zoomPercent / 100));
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const webview = getCurrentWebview();
      await webview.setZoom(scaleFactor);
    } catch (err) {
      // Silently fail if not in Tauri context or zoom not supported
      console.warn("Failed to apply webview zoom:", err);
    }
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      target.isContentEditable ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT"
    );
  }

  function openCommandPalette(mode: "command" | "file"): void {
    if (mode === "command") {
      commandPalette?.openCommandMode();
    } else {
      commandPalette?.openFileMode();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    // Ctrl+Shift+P / Ctrl+K chords should work even in editable targets
    const isMod = e.ctrlKey || e.metaKey;

    // Ctrl+Shift+R to reload window with state preservation
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      stateSnapshotService.reloadWindow();
      return;
    }

    // Ctrl+Shift+P to open command palette (VS Code)
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      uiStore.closeMenus();
      openCommandPalette("command");
      return;
    }

    // Ctrl+P to open quick file search (VS Code)
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      uiStore.closeMenus();
      openCommandPalette("file");
      return;
    }

    // VS Code-style key chord: Ctrl+K (then ...)
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      startChord();
      return;
    }

    // Chord continuation: Ctrl+K Ctrl+O -> Open Folder
    if (chordActive) {
      // Any next key (including non-mod) ends the chord.
      if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        clearChord();
        void handleOpenFolder();
        return;
      }

      clearChord();
      // fall through to normal handling
    }

    const editable = isEditableTarget(e.target);
    const allowInEditable =
      e.key === "Escape" ||
      (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") ||
      (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "g") ||
      (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") ||
      (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") ||
      (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") ||
      (isMod &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "`" || e.code === "Backquote")) ||
      (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") ||
      (isMod && !e.shiftKey && !e.altKey && e.key === ".");

    if (editable && !allowInEditable) return;

    if (e.key === "Escape") {
      uiStore.closeMenus();
      if (assistantStore.isStreaming) {
        assistantStore.stopStreaming();
      }
      // Close diff view if active
      if (diffStore.isActive) {
        diffStore.closeDiff();
        return;
      }
      return;
    }

    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.toggleSidebar();
    }

    // Ctrl+S to save
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      uiStore.closeMenus();
      void handleSave();
    }

    // Ctrl+G to go to line
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "g") {
      e.preventDefault();
      uiStore.closeMenus();
      openGoToLine();
    }

    // Ctrl+Shift+I to format document
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      uiStore.closeMenus();
      void formatCurrentDocument();
    }

    // Ctrl+Shift+F to open search panel
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.setActiveSidebarPanel("search");
    }

    // Ctrl+Shift+O to open Go to Symbol in File
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      uiStore.closeMenus();
      runEditorAction("editor.action.quickOutline");
    }

    // Ctrl+T to open Go to Symbol in Workspace
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      uiStore.closeMenus();
      symbolPickerMode = "workspace";
      symbolPickerOpen = true;
    }

    if (
      isMod &&
      !e.altKey &&
      (e.code === "Equal" ||
        e.code === "NumpadAdd" ||
        e.key === "=" ||
        e.key === "+")
    ) {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.zoomIn();
    }

    if (
      isMod &&
      !e.altKey &&
      (e.code === "Minus" ||
        e.code === "NumpadSubtract" ||
        e.key === "-" ||
        e.key === "_")
    ) {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.zoomOut();
    }

    if (
      isMod &&
      !e.altKey &&
      (e.code === "Digit0" || e.code === "Numpad0" || e.key === "0")
    ) {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.resetZoom();
    }

    // Ctrl+Tab to cycle to next tab
    if (isMod && !e.altKey && e.key === "Tab") {
      e.preventDefault();
      uiStore.closeMenus();
      // Trigger auto-save before switching tabs
      triggerImmediateAutoSave();
      if (e.shiftKey) {
        editorStore.previousTab();
      } else {
        editorStore.nextTab();
      }
    }

    // Ctrl+W to close current tab
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      uiStore.closeMenus();
      if (editorStore.activeFilePath) {
        const path = editorStore.activeFilePath;
        void triggerImmediateAutoSave(path).then(() => {
          editorStore.closeFile(path);
        });
      }
    }

    // Ctrl+` to toggle terminal (check both key and code for cross-platform support)
    if (
      isMod &&
      !e.shiftKey &&
      !e.altKey &&
      (e.key === "`" || e.code === "Backquote")
    ) {
      e.preventDefault();
      uiStore.closeMenus();
      if (
        uiStore.bottomPanelOpen &&
        bottomPanelStore.activeTab === "terminal"
      ) {
        uiStore.toggleBottomPanel();
      } else {
        uiStore.openBottomPanelTab("terminal");
      }
    }

    // Ctrl+J to toggle bottom panel (VS Code alternative)
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.toggleBottomPanel();
    }

    // Ctrl+L to toggle Assistant panel
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      uiStore.closeMenus();
      assistantStore.togglePanel();
    }

    // Ctrl+. to cycle Assistant modes
    if (isMod && !e.shiftKey && !e.altKey && e.key === ".") {
      e.preventDefault();
      uiStore.closeMenus();
      assistantStore.cycleMode();
    }
  }

  $effect(() => {
    void applyNativeZoom(uiStore.zoomPercent);
  });

  $effect(() => {
    specStore.setActiveFile(editorStore.activeFilePath);
  });

  $effect(() => {
    void assistantStore.isStreaming;
    void assistantStore.agentLoopState;
    void assistantStore.currentConversation?.id;
    specStore.scheduleAssistantRuntimeSync();
  });

  $effect(() => {
    if (diffStore.isActive || !!editorStore.activeFile) {
      void ensureMonacoFeatureLoaded();
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="main-layout">
  <MenuBar onOpenCommandPalette={() => openCommandPalette("command")} />

  <div class="content-area">
    <!-- Activity Bar (always visible) -->
    <ActivityBar />

    <SidePanel onFileSelect={handleFileSelect} />

    <div class="main-content">
      <!-- Editor region (with bottom panel) + Assistant Panel side by side -->
      <div class="editor-with-right-panel">
        <!-- Editor region: tabs, breadcrumb, editor, bottom panel -->
        <div class="editor-region">
          <TabBar />

          {#if editorStore.activeFile && !isVoltVirtualPath(editorStore.activeFile.path)}
            <Breadcrumb filepath={editorStore.activeFile.path} />
          {/if}

          {#if editorStore.activeFile && specStore.isSpecPath(editorStore.activeFile.path)}
            <SpecHeaderBar filepath={editorStore.activeFile.path} />
          {/if}

          <!-- Editor area -->
          <div class="editor-area">
            {#if children}
              {@render children()}
            {:else if diffStore.isActive}
              <!-- Diff Editor Mode -->
              {#if MonacoDiffEditorComponent}
                {#key diffStore.state.sessionId}
                  <MonacoDiffEditorComponent
                    originalContent={diffStore.state.originalContent}
                    modifiedContent={diffStore.state.modifiedContent}
                    language={diffStore.state.language}
                    title={diffStore.state.title}
                  />
                {/key}
              {:else}
                <EmptyState hasProject={true} />
              {/if}
            {:else if editorStore.activeFile}
              {#if editorStore.activeFile.path === VOLT_SETTINGS_PATH}
                <div
                  class="settings-editor"
                  role="region"
                  aria-label="Settings"
                >
                  <SettingsPanel />
                </div>
              {:else if shouldUseRichPreview(editorStore.activeFile.path)}
                <FilePreview
                  filepath={editorStore.activeFile.path}
                  content={editorStore.activeFile.content}
                />
              {:else}
                {#if MonacoEditorComponent}
                  <MonacoEditorComponent
                    filepath={editorStore.activeFile.path}
                    value={editorStore.activeFile.content}
                    language={editorStore.activeFile.language}
                    readonly={editorStore.activeFile.readonly ?? false}
                    onchange={handleEditorChange}
                  />
                {:else}
                  <EmptyState hasProject={true} />
                {/if}
              {/if}
            {:else if !projectStore.rootPath}
              <WelcomeScreen />
            {:else}
              <EmptyState hasProject={true} />
            {/if}
          </div>

          <!-- Bottom panel (Problems / Output / Terminal) - inside editor region -->
          {#if uiStore.bottomPanelOpen}
            <ResizablePanel
              direction="vertical"
              size={uiStore.bottomPanelHeight}
              minSize={100}
              maxSize={500}
              onResize={(height) => uiStore.setBottomPanelHeight(height)}
            />

            <div
              class="bottom-panel-container"
              style="height: {uiStore.bottomPanelHeight}px"
            >
              <BottomPanel />
            </div>
          {/if}
        </div>

        <!-- Assistant Panel (Right side - separate from editor region) -->
        {#if assistantStore.panelOpen}
          <ResizablePanel
            direction="horizontal"
            side="right"
            size={assistantStore.panelWidth}
            minSize={280}
            maxSize={800}
            onResize={(width) => assistantStore.setPanelWidth(width)}
          />

          <div
            class="assistant-panel-container"
            style="width: {assistantStore.panelWidth}px"
          >
            <AssistantPanel />
          </div>
        {/if}
      </div>
    </div>
  </div>

  <StatusBar />
  <AboutModal />
  <CommandPalette bind:this={commandPalette} />
  <GoToLineDialog
    open={goToLineOpen}
    maxLine={goToLineMax}
    onGo={handleGoToLine}
    onClose={() => (goToLineOpen = false)}
  />
  <SymbolPicker
    open={symbolPickerOpen}
    mode={symbolPickerMode}
    onClose={() => (symbolPickerOpen = false)}
  />
</div>

<style>
  .main-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: var(--color-bg);
  }

  .content-area {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .settings-editor {
    height: 100%;
    width: 100%;
    overflow: auto;
    background: var(--color-bg-panel);
  }

  .main-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
  }

  .editor-with-right-panel {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .editor-region {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .editor-area {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: var(--color-bg);
  }

  .assistant-panel-container {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow: hidden;
  }

  .bottom-panel-container {
    display: flex;
    flex-direction: column;
    background: var(--color-bg-panel);
    border-top: 1px solid var(--color-border);
    flex-shrink: 0;
  }
</style>
