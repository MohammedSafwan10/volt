<script lang="ts">
  import { onMount } from 'svelte';
  import MenuBar from './MenuBar.svelte';
  import StatusBar from './StatusBar.svelte';
  import ResizablePanel from './ResizablePanel.svelte';
  import AboutModal from './AboutModal.svelte';
  import { ActivityBar, SidePanel } from '$lib/components/sidebar';
  import SettingsPanel from '$lib/components/sidebar/SettingsPanel.svelte';
  import { WelcomeScreen } from '$lib/components/welcome';
  import { MonacoEditor, Breadcrumb, EmptyState, GoToLineDialog } from '$lib/components/editor';
  import { TabBar } from '$lib/components/tabs';
  import { CommandPalette, SymbolPicker } from '$lib/components/command-palette';
  import { BottomPanel } from '$lib/components/panel';
  import { AssistantPanel } from '$lib/components/assistant';
  import { loadMonaco } from '$lib/services/monaco-loader';
  import { loadXterm } from '$lib/services/terminal-loader';
  import { uiStore } from '$lib/stores/ui.svelte';
	import { bottomPanelStore } from '$lib/stores/bottom-panel.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';
  import { VOLT_SETTINGS_PATH, isVoltVirtualPath } from '$lib/stores/editor.svelte';
  import { terminalStore } from '$lib/stores/terminal.svelte';
  import { logOutput } from '$lib/stores/output.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { assistantStore } from '$lib/stores/assistant.svelte';
  import { openFolderDialog, writeFile } from '$lib/services/file-system';
  import { 
    initAutoSave, 
    destroyAutoSave, 
    scheduleAutoSave, 
    triggerImmediateAutoSave 
  } from '$lib/services/auto-save';
  import { disposeLspRegistry } from '$lib/services/lsp/sidecar';
  import { formatBeforeSave, formatCurrentDocument, isPrettierFile } from '$lib/services/prettier';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  // Command palette reference
  let commandPalette: ReturnType<typeof CommandPalette> | undefined = $state();

  // Go to Line dialog state
  let goToLineOpen = $state(false);
  let goToLineMax = $state(1);

  // Symbol picker state
  let symbolPickerOpen = $state(false);
  let symbolPickerMode = $state<'file' | 'workspace'>('file');

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
      uiStore.setActiveSidebarPanel('explorer');
    }
  }

  function openGoToLine(): void {
    if (!editorStore.activeFile) return;
    // Get line count from Monaco model
    import('$lib/services/monaco-models').then(({ getModelLineCount }) => {
      const lineCount = getModelLineCount(editorStore.activeFile!.path);
      goToLineMax = lineCount || 1;
      goToLineOpen = true;
    }).catch(() => {
      goToLineMax = 1000;
      goToLineOpen = true;
    });
  }

  async function handleGoToLine(line: number): Promise<void> {
    if (!editorStore.activeFile) return;
    const { revealLine } = await import('$lib/services/monaco-models');
    revealLine(editorStore.activeFile.path, line);
  }

  // Handle symbol picker open event from command palette
  function handleOpenSymbolPicker(e: CustomEvent<{ mode: 'file' | 'workspace' }>): void {
    symbolPickerMode = e.detail.mode;
    symbolPickerOpen = true;
  }


  // Handle go to line open event from command palette
  function handleOpenGoToLine(): void {
    openGoToLine();
  }

  // VS Code-like: warm Monaco and xterm at app startup so first use feels instant.
  // Also initialize auto-save listeners.
  onMount(() => {
    logOutput('Volt', 'Volt IDE started');
    logOutput('Volt', 'Warming up Monaco editor...');
    void loadMonaco();
    logOutput('Volt', 'Warming up terminal...');
    void loadXterm();
    initAutoSave();
    logOutput('Volt', 'Auto-save initialized');

    // Handle window beforeunload to clean up LSP servers
    const handleBeforeUnload = () => {
      // Synchronously trigger cleanup - browser may not wait for async
      void disposeLspRegistry();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    // Listen for symbol picker open events from command palette
    window.addEventListener('volt:open-symbol-picker', handleOpenSymbolPicker as EventListener);
    window.addEventListener('volt:open-go-to-line', handleOpenGoToLine as EventListener);
    
    return () => {
      destroyAutoSave();
      // Kill all terminals on unmount
      void terminalStore.killAll();
      // Stop all LSP servers on unmount
      void disposeLspRegistry();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('volt:open-symbol-picker', handleOpenSymbolPicker as EventListener);
      window.removeEventListener('volt:open-go-to-line', handleOpenGoToLine as EventListener);
    };
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
    try {
      const { getModelValue, setModelValue } = await import('$lib/services/monaco-models');
      const modelValue = getModelValue(activeFile.path);
      if (typeof modelValue === 'string') {
        contentToSave = modelValue;
        editorStore.updateContent(activeFile.path, modelValue);
      }

      if (settingsStore.formatOnSaveEnabled && isPrettierFile(activeFile.path)) {
        const formatted = await formatBeforeSave(contentToSave, activeFile.path);
        if (formatted !== contentToSave) {
          contentToSave = formatted;
          setModelValue(activeFile.path, formatted);
          editorStore.updateContent(activeFile.path, formatted);
        }
      }
    } catch {
      // ignore
    }

    const success = await writeFile(activeFile.path, contentToSave);
    if (success) {
      editorStore.markSaved(activeFile.path);
    }
  }

  async function applyNativeZoom(zoomPercent: number) {
    if (typeof window === 'undefined') return;

    const scaleFactor = Math.max(0.5, Math.min(2.0, zoomPercent / 100));
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const webview = getCurrentWebview();
      await webview.setZoom(scaleFactor);
    } catch (err) {
      // Silently fail if not in Tauri context or zoom not supported
      console.warn('Failed to apply webview zoom:', err);
    }
  }


  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function handleKeydown(e: KeyboardEvent) {
    // Ctrl+Shift+P / Ctrl+K chords should work even in editable targets
    const isMod = e.ctrlKey || e.metaKey;

    // Ctrl+Shift+P to open command palette (VS Code)
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      uiStore.closeMenus();
      commandPalette?.openCommandMode();
      return;
    }

    // Ctrl+P to open quick file search (VS Code)
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      uiStore.closeMenus();
      commandPalette?.openFileMode();
      return;
    }

    // VS Code-style key chord: Ctrl+K (then ...)
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      startChord();
      return;
    }

    // Chord continuation: Ctrl+K Ctrl+O -> Open Folder
    if (chordActive) {
      // Any next key (including non-mod) ends the chord.
      if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
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
      e.key === 'Escape' ||
      (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') ||
      (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') ||
      (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') ||
      (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') ||
      (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') ||
      (isMod && !e.shiftKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) ||
      (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') ||
      (isMod && !e.shiftKey && !e.altKey && e.key === '.');

    if (editable && !allowInEditable) return;

    if (e.key === 'Escape') {
      uiStore.closeMenus();
      if (assistantStore.isStreaming) {
        assistantStore.stopStreaming();
      }
      return;
    }

    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.toggleSidebar();
    }

    // Ctrl+S to save
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      uiStore.closeMenus();
      void handleSave();
    }

    // Ctrl+G to go to line
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      uiStore.closeMenus();
      openGoToLine();
    }

    // Ctrl+Shift+I to format document
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      uiStore.closeMenus();
      void formatCurrentDocument();
    }

    // Ctrl+Shift+F to open search panel
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.setActiveSidebarPanel('search');
    }

    // Ctrl+Shift+O to open Go to Symbol in File
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      uiStore.closeMenus();
      void import('$lib/services/monaco-models')
        .then(({ runEditorAction }) => runEditorAction('editor.action.quickOutline'))
        .catch(() => {
          // ignore
        });
    }

    // Ctrl+T to open Go to Symbol in Workspace
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      uiStore.closeMenus();
      symbolPickerMode = 'workspace';
      symbolPickerOpen = true;
    }

    if (isMod && !e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '=' || e.key === '+')) {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.zoomIn();
    }

    if (isMod && !e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_')) {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.zoomOut();
    }

    if (isMod && !e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0' || e.key === '0')) {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.resetZoom();
    }

    // Ctrl+Tab to cycle to next tab
    if (isMod && !e.altKey && e.key === 'Tab') {
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
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      uiStore.closeMenus();
      if (editorStore.activeFilePath) {
        editorStore.closeFile(editorStore.activeFilePath);
      }
    }

    // Ctrl+` to toggle terminal (check both key and code for cross-platform support)
    if (isMod && !e.shiftKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) {
      e.preventDefault();
      uiStore.closeMenus();
      if (uiStore.bottomPanelOpen && bottomPanelStore.activeTab === 'terminal') {
        uiStore.toggleBottomPanel();
      } else {
        uiStore.openBottomPanelTab('terminal');
      }
    }

    // Ctrl+J to toggle bottom panel (VS Code alternative)
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      uiStore.closeMenus();
      uiStore.toggleBottomPanel();
    }

    // Ctrl+L to toggle Assistant panel
    if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      uiStore.closeMenus();
      assistantStore.togglePanel();
    }

    // Ctrl+. to cycle Assistant modes
    if (isMod && !e.shiftKey && !e.altKey && e.key === '.') {
      e.preventDefault();
      uiStore.closeMenus();
      assistantStore.cycleMode();
    }
  }

  $effect(() => {
    void applyNativeZoom(uiStore.zoomPercent);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="main-layout">
  <MenuBar onOpenCommandPalette={() => commandPalette?.openCommandMode()} />

  <div class="content-area">
    <!-- Activity Bar (always visible) -->
    <ActivityBar />

    <!-- Side Panel (toggleable) -->
    <SidePanel onFileSelect={handleFileSelect} />

    <div class="main-content">
      <!-- Editor region (with bottom panel) + Assistant Panel side by side -->
      <div class="editor-with-right-panel">
        <!-- Editor region: tabs, breadcrumb, editor, bottom panel -->
        <div class="editor-region">
          <!-- Tab Bar (above editor only) -->
          <TabBar />

          <!-- Breadcrumb navigation -->
          {#if editorStore.activeFile && !isVoltVirtualPath(editorStore.activeFile.path)}
            <Breadcrumb filepath={editorStore.activeFile.path} />
          {/if}

          <!-- Editor area -->
          <div class="editor-area">
            {#if children}
              {@render children()}
            {:else if editorStore.activeFile}
              {#if editorStore.activeFile.path === VOLT_SETTINGS_PATH}
                <div class="settings-editor" role="region" aria-label="Settings">
                  <SettingsPanel />
                </div>
              {:else}
                <MonacoEditor
                  filepath={editorStore.activeFile.path}
                  value={editorStore.activeFile.content}
                  language={editorStore.activeFile.language}
                  readonly={editorStore.activeFile.readonly ?? false}
                  onchange={handleEditorChange}
                />
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
  }
</style>
