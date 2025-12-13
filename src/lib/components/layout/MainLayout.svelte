<script lang="ts">
  import { onMount } from 'svelte';
  import MenuBar from './MenuBar.svelte';
  import StatusBar from './StatusBar.svelte';
  import ResizablePanel from './ResizablePanel.svelte';
  import AboutModal from './AboutModal.svelte';
  import { ActivityBar, SidePanel } from '$lib/components/sidebar';
  import { WelcomeScreen } from '$lib/components/welcome';
  import { MonacoEditor } from '$lib/components/editor';
  import { TabBar } from '$lib/components/tabs';
  import { CommandPalette } from '$lib/components/command-palette';
  import { BottomPanel } from '$lib/components/panel';
  import { loadMonaco } from '$lib/services/monaco-loader';
  import { loadXterm } from '$lib/services/terminal-loader';
  import { uiStore } from '$lib/stores/ui.svelte';
	import { bottomPanelStore } from '$lib/stores/bottom-panel.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';
  import { terminalStore } from '$lib/stores/terminal.svelte';
  import { logOutput } from '$lib/stores/output.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
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
    
    return () => {
      destroyAutoSave();
      // Kill all terminals on unmount
      void terminalStore.killAll();
      // Stop all LSP servers on unmount
      void disposeLspRegistry();
      window.removeEventListener('beforeunload', handleBeforeUnload);
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
      commandPalette?.open();
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

    if (isEditableTarget(e.target)) return;

    if (e.key === 'Escape') {
      uiStore.closeMenus();
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

    // Ctrl+Shift+I to format document
    if (isMod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      uiStore.closeMenus();
      void formatCurrentDocument();
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

    // Ctrl+` to toggle terminal
    if (isMod && !e.shiftKey && !e.altKey && e.key === '`') {
      e.preventDefault();
      uiStore.closeMenus();
			if (uiStore.bottomPanelOpen && bottomPanelStore.activeTab === 'terminal') {
				uiStore.toggleBottomPanel();
			} else {
				uiStore.openBottomPanelTab('terminal');
			}
    }
  }

  $effect(() => {
    void applyNativeZoom(uiStore.zoomPercent);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="main-layout">
  <MenuBar onOpenCommandPalette={() => commandPalette?.open()} />

  <div class="content-area">
    <!-- Activity Bar (always visible) -->
    <ActivityBar />

    <!-- Side Panel (toggleable) -->
    <SidePanel onFileSelect={handleFileSelect} />

    <div class="main-content">
      <!-- Tab Bar (above editor only) -->
      <TabBar />

      <!-- Editor area -->
      <div class="editor-area">
        {#if children}
          {@render children()}
        {:else if !projectStore.rootPath}
          <WelcomeScreen />
        {:else if editorStore.activeFile}
          <MonacoEditor
            filepath={editorStore.activeFile.path}
            value={editorStore.activeFile.content}
            language={editorStore.activeFile.language}
            onchange={handleEditorChange}
          />
        {:else}
          <div class="no-file-placeholder">
            <p>Select a file from the explorer to edit</p>
          </div>
        {/if}
      </div>

      <!-- Bottom panel (Problems / Output / Terminal) -->
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
  </div>

  <StatusBar />
  <AboutModal />
  <CommandPalette bind:this={commandPalette} />
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

  .main-content {
    display: flex;
    flex-direction: column;
    flex: 1;
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

  .no-file-placeholder {
    text-align: center;
    color: var(--color-text-secondary);
    padding: 24px;
  }

  .no-file-placeholder p {
    font-size: 14px;
    margin: 0;
    font-style: italic;
  }

  .bottom-panel-container {
    display: flex;
    flex-direction: column;
    background: var(--color-bg-panel);
    border-top: 1px solid var(--color-border);
  }
</style>
