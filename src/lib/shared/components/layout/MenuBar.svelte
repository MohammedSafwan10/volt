<script lang="ts">
  import { uiStore } from "$shared/stores/ui.svelte";
  import { bottomPanelStore } from "$shared/stores/bottom-panel.svelte";
  import { showToast } from "$shared/stores/toast.svelte";
  import { projectStore } from "$shared/stores/project.svelte";
  import { settingsStore } from "$shared/stores/settings.svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { triggerImmediateAutoSave } from "$features/editor/services/auto-save";
  import { terminalStore } from "$features/terminal/stores/terminal.svelte";
  import { themeStore } from "$shared/stores/theme.svelte";
  import { assistantStore } from "$features/assistant/stores/assistant.svelte";
  import { openFileDialog, openFolderDialog } from "$core/services/file-system";
  import { formatCurrentDocument } from "$core/services/prettier";
  import { exit } from "@tauri-apps/plugin-process";
  import { UIIcon } from "$shared/components/ui";

  interface Props {
    onOpenCommandPalette?: () => void;
  }

  let { onOpenCommandPalette }: Props = $props();

  interface MenuItem {
    label: string;
    shortcut?: string;
    action?: () => void;
    separator?: boolean;
    checked?: boolean;
    submenu?: MenuItem[];
  }

  interface Menu {
    id: string;
    label: string;
    items: MenuItem[];
  }

  function handleSetThemeDarkModern() {
    uiStore.closeMenus();
    themeStore.setMode("dark-modern");
    showToast({ message: "Theme set to Dark Modern", type: "info" });
  }

  function handleSetThemeDark() {
    uiStore.closeMenus();
    themeStore.setMode("dark");
    showToast({ message: "Theme set to Dark", type: "info" });
  }

  function handleSetThemeMidnight() {
    uiStore.closeMenus();
    themeStore.setMode("midnight");
    showToast({ message: "Theme set to Midnight", type: "info" });
  }

  function handleSetThemeLight() {
    uiStore.closeMenus();
    themeStore.setMode("light");
    showToast({ message: "Theme set to Light", type: "info" });
  }

  function handleSetThemeSolarizedDark() {
    uiStore.closeMenus();
    themeStore.setMode("solarized-dark");
    showToast({ message: "Theme set to Solarized Dark", type: "info" });
  }

  function handleSetThemeSystem() {
    uiStore.closeMenus();
    showToast({
      message: `System theme sync removed. Defaulting to Dark Modern.`,
      type: "info",
    });
  }

  async function handleOpenFile() {
    uiStore.closeMenus();
    const path = await openFileDialog();
    if (path) {
      await editorStore.openFile(path);
    }
  }

  async function handleOpenFolder() {
    uiStore.closeMenus();
    const path = await openFolderDialog();
    if (path) {
      const success = await projectStore.openProject(path);
      if (success) {
        // Ensure explorer panel is visible
        uiStore.setActiveSidebarPanel("explorer");
      }
    }
  }

  async function handleCloseFolder() {
    uiStore.closeMenus();
    try {
      await projectStore.closeProject();
    } catch (error) {
      console.error('[MenuBar] Failed to close folder:', error);
    }
    if (uiStore.activeSidebarPanel !== "explorer" || !uiStore.sidebarOpen) {
      uiStore.setActiveSidebarPanel("explorer");
    }
  }

  async function handleExit() {
    uiStore.closeMenus();
    await exit(0);
  }

  async function handleCloseEditor() {
    uiStore.closeMenus();
    if (editorStore.activeFilePath) {
      await triggerImmediateAutoSave(editorStore.activeFilePath);
      editorStore.closeFile(editorStore.activeFilePath);
    }
  }

  function handleToggleAutoSave() {
    settingsStore.toggleAutoSave();
    showToast({
      message: `Auto-save ${settingsStore.autoSaveEnabled ? "enabled" : "disabled"}`,
      type: "info",
    });
  }

  function handleFormatDocument() {
    uiStore.closeMenus();
    void formatCurrentDocument();
  }

  function handleOpenSearch() {
    uiStore.closeMenus();
    uiStore.setActiveSidebarPanel("search");
  }

  function handleOpenSettings() {
    uiStore.closeMenus();
    editorStore.openSettingsTab();
  }

  function handleToggleFormatOnSave() {
    settingsStore.toggleFormatOnSave();
    showToast({
      message: `Format on save ${settingsStore.formatOnSaveEnabled ? "enabled" : "disabled"}`,
      type: "info",
    });
  }

  function comingSoon(feature: string) {
    return () => {
      uiStore.closeMenus();
      showToast({ message: `${feature} - Coming soon`, type: "info" });
    };
  }

  function handleToggleTerminal() {
    uiStore.closeMenus();
    // VS Code-like:
    // - If Terminal is already active, toggle the panel closed
    // - Otherwise, open the panel and focus the Terminal tab
    if (uiStore.bottomPanelOpen && bottomPanelStore.activeTab === "terminal") {
      uiStore.toggleBottomPanel();
      return;
    }

    uiStore.openBottomPanelTab("terminal");
  }

  function handleNewTerminal() {
    uiStore.closeMenus();
    uiStore.openBottomPanelTab("terminal");
    void terminalStore.createTerminal();
  }

  function handleAbout() {
    uiStore.openAboutModal();
  }

  function handleZoomIn() {
    uiStore.closeMenus();
    uiStore.zoomIn();
  }

  function handleZoomOut() {
    uiStore.closeMenus();
    uiStore.zoomOut();
  }

  function handleResetZoom() {
    uiStore.closeMenus();
    uiStore.resetZoom();
  }

  const menus: Menu[] = $derived.by(() => [
    {
      id: "file",
      label: "File",
      items: [
        {
          label: "New File",
          shortcut: "Ctrl+N",
          action: comingSoon("New File"),
        },
        { separator: true, label: "" },
        { label: "Open File...", shortcut: "Ctrl+O", action: handleOpenFile },
        {
          label: "Open Folder...",
          shortcut: "Ctrl+K Ctrl+O",
          action: handleOpenFolder,
        },
        { separator: true, label: "" },
        { label: "Save", shortcut: "Ctrl+S", action: comingSoon("Save") },
        { separator: true, label: "" },
        {
          label: "Auto Save",
          action: handleToggleAutoSave,
          checked: settingsStore.autoSaveEnabled,
        },
        { separator: true, label: "" },
        {
          label: "Close Editor",
          shortcut: "Ctrl+W",
          action: handleCloseEditor,
        },
        { label: "Close Folder", action: handleCloseFolder },
        { separator: true, label: "" },
        { label: "Exit", shortcut: "Alt+F4", action: handleExit },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        { label: "Undo", shortcut: "Ctrl+Z", action: comingSoon("Undo") },
        { label: "Redo", shortcut: "Ctrl+Shift+Z", action: comingSoon("Redo") },
        { separator: true, label: "" },
        { label: "Cut", shortcut: "Ctrl+X", action: comingSoon("Cut") },
        { label: "Copy", shortcut: "Ctrl+C", action: comingSoon("Copy") },
        { label: "Paste", shortcut: "Ctrl+V", action: comingSoon("Paste") },
        { separator: true, label: "" },
        { label: "Find", shortcut: "Ctrl+F", action: handleOpenSearch },
        { separator: true, label: "" },
        {
          label: "Format Document",
          shortcut: "Ctrl+Shift+I",
          action: handleFormatDocument,
        },
        {
          label: "Format on Save",
          action: handleToggleFormatOnSave,
          checked: settingsStore.formatOnSaveEnabled,
        },
      ],
    },
    {
      id: "view",
      label: "View",
      items: [
        {
          label: "Command Palette",
          shortcut: "Ctrl+Shift+P",
          action: () => {
            uiStore.closeMenus();
            onOpenCommandPalette?.();
          },
        },
        { separator: true, label: "" },
        {
          label: "Explorer",
          shortcut: "Ctrl+Shift+E",
          action: () => {
            uiStore.closeMenus();
            uiStore.setActiveSidebarPanel("explorer");
          },
        },
        {
          label: "Search",
          shortcut: "Ctrl+Shift+F",
          action: () => {
            uiStore.closeMenus();
            uiStore.setActiveSidebarPanel("search");
          },
        },
        { label: "Settings", shortcut: "Ctrl+,", action: handleOpenSettings },
        { separator: true, label: "" },
        {
          label: "Problems",
          shortcut: "Ctrl+Shift+M",
          action: () => {
            uiStore.closeMenus();
            uiStore.openBottomPanelTab("problems");
          },
        },
        {
          label: "Output",
          shortcut: "Ctrl+Shift+U",
          action: () => {
            uiStore.closeMenus();
            uiStore.openBottomPanelTab("output");
          },
        },
        { label: "Terminal", shortcut: "Ctrl+`", action: handleToggleTerminal },
        {
          label: "Assistant",
          shortcut: "Ctrl+L",
          action: () => {
            uiStore.closeMenus();
            assistantStore.togglePanel();
          },
        },
        { separator: true, label: "" },
        { label: "Zoom In", shortcut: "Ctrl++", action: handleZoomIn },
        { label: "Zoom Out", shortcut: "Ctrl+-", action: handleZoomOut },
        { label: "Reset Zoom", shortcut: "Ctrl+0", action: handleResetZoom },
        { separator: true, label: "" },
        {
          label: "Theme",
          submenu: [
            {
              label: "Dark Modern",
              action: handleSetThemeDarkModern,
              checked: themeStore.mode === "dark-modern",
            },
            {
              label: "Dark",
              action: handleSetThemeDark,
              checked: themeStore.mode === "dark",
            },
            {
              label: "Midnight",
              action: handleSetThemeMidnight,
              checked: themeStore.mode === "midnight",
            },
            {
              label: "Light",
              action: handleSetThemeLight,
              checked: themeStore.mode === "light",
            },
            {
              label: "Solarized Dark",
              action: handleSetThemeSolarizedDark,
              checked: themeStore.mode === "solarized-dark",
            },
          ],
        },
      ],
    },
    {
      id: "terminal",
      label: "Terminal",
      items: [
        {
          label: "New Terminal",
          shortcut: "Ctrl+`",
          action: handleNewTerminal,
        },
      ],
    },
    {
      id: "help",
      label: "Help",
      items: [{ label: "About", action: handleAbout }],
    },
  ]);

  function handleMenuClick(menuId: string) {
    uiStore.toggleMenu(menuId);
  }

  function handleMenuHover(menuId: string) {
    if (uiStore.activeMenu !== null) {
      uiStore.openMenu(menuId);
    }
  }
</script>

<svelte:window
  onclick={(e) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".menu-bar")) {
      uiStore.closeMenus();
    }
  }}
/>

<div class="menu-bar no-select" role="menubar" aria-label="Application menu">
  <div class="menu-left">
    {#each menus as menu (menu.id)}
      <div class="menu-container">
        <button
          class="menu-trigger"
          class:active={uiStore.activeMenu === menu.id}
          onclick={() => handleMenuClick(menu.id)}
          onmouseenter={() => handleMenuHover(menu.id)}
          aria-haspopup="menu"
          aria-expanded={uiStore.activeMenu === menu.id}
        >
          {menu.label}
        </button>

        {#if uiStore.activeMenu === menu.id}
          <div class="menu-dropdown" role="menu" aria-label={menu.label}>
            {#each menu.items as item, index (index)}
              {#if item.separator}
                <div class="menu-separator"></div>
              {:else if item.submenu}
                <div class="menu-item-with-submenu">
                  <span class="menu-item-label">{item.label}</span>
                  <span class="submenu-arrow">▶</span>
                  <div class="submenu">
                    {#each item.submenu as subitem, subindex (subindex)}
                      <button
                        class="menu-item"
                        onclick={subitem.action}
                        role="menuitem"
                      >
                        <span class="menu-item-label">
                          {#if subitem.checked !== undefined}
                            <span class="menu-check"
                              >{subitem.checked ? "✓" : ""}</span
                            >
                          {/if}
                          {subitem.label}
                        </span>
                      </button>
                    {/each}
                  </div>
                </div>
              {:else}
                <button class="menu-item" onclick={item.action} role="menuitem">
                  <span class="menu-item-label">
                    {#if item.checked !== undefined}
                      <span class="menu-check">{item.checked ? "✓" : ""}</span>
                    {/if}
                    {item.label}
                  </span>
                  {#if item.shortcut}
                    <span class="menu-shortcut">{item.shortcut}</span>
                  {/if}
                </button>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="menu-spacer"></div>

  <div class="menu-right">
    <button
      class="assistant-btn"
      class:active={assistantStore.panelOpen}
      onclick={() => assistantStore.togglePanel()}
      title="Assistant (Ctrl+L)"
      aria-label="Toggle Assistant panel"
      aria-pressed={assistantStore.panelOpen}
      type="button"
    >
      <UIIcon name="sparkle" size={16} />
    </button>
  </div>
</div>

<style>
  .menu-bar {
    display: flex;
    align-items: center;
    height: 30px;
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
    padding: 0 8px;
    -webkit-app-region: drag;
    gap: 2px;
  }

  .menu-left {
    display: flex;
    align-items: center;
    gap: 2px;
    -webkit-app-region: no-drag;
  }

  .menu-spacer {
    flex: 1;
  }

  .menu-right {
    display: flex;
    align-items: center;
    gap: 4px;
    -webkit-app-region: no-drag;
  }

  .assistant-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 22px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .assistant-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .assistant-btn.active {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .assistant-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .menu-container {
    position: relative;
  }

  .menu-trigger {
    padding: 4px 8px;
    font-size: 13px;
    color: var(--color-text);
    border-radius: 4px;
    transition: background-color 0.1s ease;
  }

  .menu-trigger:hover,
  .menu-trigger.active {
    background: var(--color-hover);
  }

  .menu-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 2px;
    min-width: 240px;
    background: var(--color-bg-elevated, var(--color-bg-sidebar));
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 6px 0;
    box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
    z-index: 1000;
  }

  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 6px 12px;
    font-size: 13px;
    color: var(--color-text);
    text-align: left;
    transition: background-color 0.1s ease;
    border-radius: 4px;
    margin: 0 4px;
  }

  .menu-item:hover {
    background: var(--color-hover);
  }

  .menu-item:focus-visible {
    background: var(--color-hover);
    outline: 2px solid var(--color-accent);
    outline-offset: 0;
  }

  .menu-item-label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .menu-check {
    width: 16px;
    text-align: center;
  }

  .menu-shortcut {
    color: var(--color-text-secondary);
    font-size: 12px;
    margin-left: 24px;
  }

  .menu-separator {
    height: 1px;
    background: var(--color-border);
    margin: 4px 8px;
  }

  .menu-item-with-submenu {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: calc(100% - 8px);
    padding: 6px 12px;
    font-size: 13px;
    color: var(--color-text);
    text-align: left;
    transition: background-color 0.1s ease;
    border-radius: 4px;
    margin: 0 4px;
    position: relative;
    cursor: default;
  }

  .menu-item-with-submenu:hover {
    background: var(--color-hover);
  }

  .submenu-arrow {
    font-size: 10px;
    color: var(--color-text-secondary);
  }

  .submenu {
    position: absolute;
    left: 100%;
    top: 0;
    min-width: 160px;
    background: var(--color-bg-elevated, var(--color-bg-sidebar));
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 6px 0;
    box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
    z-index: 1001;
    display: none;
  }

  .menu-item-with-submenu:hover .submenu {
    display: block;
  }
</style>
