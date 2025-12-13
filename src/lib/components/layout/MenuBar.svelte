<script lang="ts">
  import { uiStore } from '$lib/stores/ui.svelte';
	import { bottomPanelStore } from '$lib/stores/bottom-panel.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
  import { openFileDialog, openFolderDialog } from '$lib/services/file-system';
  import { getCurrentWindow } from '@tauri-apps/api/window';

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
  }

  interface Menu {
    id: string;
    label: string;
    items: MenuItem[];
  }

  async function handleOpenFile() {
    uiStore.closeMenus();
    const path = await openFileDialog();
    if (path) {
      showToast({ message: `Opening file: ${path}`, type: 'info' });
    }
  }

  async function handleOpenFolder() {
    uiStore.closeMenus();
    const path = await openFolderDialog();
    if (path) {
      const success = await projectStore.openProject(path);
      if (success) {
        // Ensure explorer panel is visible
        uiStore.setActiveSidebarPanel('explorer');
      }
    }
  }

  function handleCloseFolder() {
    uiStore.closeMenus();
    projectStore.closeProject();
  }

  async function handleExit() {
    uiStore.closeMenus();
    const appWindow = getCurrentWindow();
    await appWindow.close();
  }

  function handleToggleAutoSave() {
    settingsStore.toggleAutoSave();
    showToast({
      message: `Auto-save ${settingsStore.autoSaveEnabled ? 'enabled' : 'disabled'}`,
      type: 'info'
    });
  }

  function comingSoon(feature: string) {
    return () => {
      uiStore.closeMenus();
      showToast({ message: `${feature} - Coming soon`, type: 'info' });
    };
  }

  function handleToggleTerminal() {
    uiStore.closeMenus();
		// VS Code-like:
		// - If Terminal is already active, toggle the panel closed
		// - Otherwise, open the panel and focus the Terminal tab
		if (uiStore.bottomPanelOpen && bottomPanelStore.activeTab === 'terminal') {
			uiStore.toggleBottomPanel();
			return;
		}

		uiStore.openBottomPanelTab('terminal');
  }

	function handleNewTerminal() {
		uiStore.closeMenus();
		uiStore.openBottomPanelTab('terminal');
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
      id: 'file',
      label: 'File',
      items: [
        { label: 'New File', shortcut: 'Ctrl+N', action: comingSoon('New File') },
        { separator: true, label: '' },
        { label: 'Open File...', shortcut: 'Ctrl+O', action: handleOpenFile },
        { label: 'Open Folder...', shortcut: 'Ctrl+K Ctrl+O', action: handleOpenFolder },
        { separator: true, label: '' },
        { label: 'Save', shortcut: 'Ctrl+S', action: comingSoon('Save') },
        { separator: true, label: '' },
        { label: 'Auto Save', action: handleToggleAutoSave, checked: settingsStore.autoSaveEnabled },
        { separator: true, label: '' },
        { label: 'Close Editor', shortcut: 'Ctrl+W', action: comingSoon('Close Editor') },
        { label: 'Close Folder', action: handleCloseFolder },
        { separator: true, label: '' },
        { label: 'Exit', shortcut: 'Alt+F4', action: handleExit }
      ]
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: comingSoon('Undo') },
        { label: 'Redo', shortcut: 'Ctrl+Shift+Z', action: comingSoon('Redo') },
        { separator: true, label: '' },
        { label: 'Cut', shortcut: 'Ctrl+X', action: comingSoon('Cut') },
        { label: 'Copy', shortcut: 'Ctrl+C', action: comingSoon('Copy') },
        { label: 'Paste', shortcut: 'Ctrl+V', action: comingSoon('Paste') },
        { separator: true, label: '' },
        { label: 'Find', shortcut: 'Ctrl+F', action: comingSoon('Find') }
      ]
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { label: 'Command Palette', shortcut: 'Ctrl+Shift+P', action: () => { uiStore.closeMenus(); onOpenCommandPalette?.(); } },
        { separator: true, label: '' },
        { label: 'Explorer', shortcut: 'Ctrl+Shift+E', action: () => { uiStore.closeMenus(); uiStore.setActiveSidebarPanel('explorer'); } },
        { separator: true, label: '' },
        { label: 'Problems', shortcut: 'Ctrl+Shift+M', action: () => { uiStore.closeMenus(); uiStore.openBottomPanelTab('problems'); } },
        { label: 'Output', shortcut: 'Ctrl+Shift+U', action: () => { uiStore.closeMenus(); uiStore.openBottomPanelTab('output'); } },
        { label: 'Terminal', shortcut: 'Ctrl+`', action: handleToggleTerminal },
        { separator: true, label: '' },
        { label: 'Zoom In', shortcut: 'Ctrl++', action: handleZoomIn },
        { label: 'Zoom Out', shortcut: 'Ctrl+-', action: handleZoomOut },
        { label: 'Reset Zoom', shortcut: 'Ctrl+0', action: handleResetZoom },
        { separator: true, label: '' },
        { label: 'Theme', action: comingSoon('Theme') }
      ]
    },
    {
      id: 'terminal',
      label: 'Terminal',
      items: [
				{ label: 'New Terminal', shortcut: 'Ctrl+`', action: handleNewTerminal }
      ]
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        { label: 'About', action: handleAbout }
      ]
    }
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

<svelte:window onclick={(e) => {
  const target = e.target as HTMLElement;
  if (!target.closest('.menu-bar')) {
    uiStore.closeMenus();
  }
}} />

<div class="menu-bar no-select" role="menubar" aria-label="Application menu">
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
            {:else}
              <button
                class="menu-item"
                onclick={item.action}
                role="menuitem"
              >
                <span class="menu-item-label">
                  {#if item.checked !== undefined}
                    <span class="menu-check">{item.checked ? '✓' : ''}</span>
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

  .menu-container {
    position: relative;
    -webkit-app-region: no-drag;
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
    background: var(--color-bg-sidebar);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 6px 0;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
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
</style>
