/**
 * UI state store using Svelte 5 runes
 * Manages layout state: sidebar, panels, menus
 */

import { bottomPanelStore, type BottomPanelTab } from './bottom-panel.svelte';

export type SidebarPanel =
  | 'explorer'
  | 'search'
  | 'git'
  | 'extensions'
  | 'settings'
  | 'mcp'
  | 'prompts'
  | null;

const ZOOM_MIN_PERCENT = 50;
const ZOOM_MAX_PERCENT = 200;
const ZOOM_STEP_PERCENT = 10;
const ZOOM_STORAGE_KEY = 'volt.zoomPercent';
const SIDEBAR_OPEN_KEY = 'volt.sidebarOpen';
const SIDEBAR_PANEL_KEY = 'volt.sidebarPanel';
const BOTTOM_PANEL_OPEN_KEY = 'volt.bottomPanelOpen';
const SIDEBAR_MIN_WIDTH = 150;
const SIDEBAR_MAX_WIDTH = 900;

class UIStore {
  // Sidebar state
  sidebarOpen = $state(true);
  activeSidebarPanel = $state<SidebarPanel>('explorer');
  sidebarWidth = $state(250);

  // Bottom panel (terminal) state
  bottomPanelOpen = $state(false);
  bottomPanelHeight = $state(200);

  // Menu state
  activeMenu = $state<string | null>(null);

  // Modal state
  aboutModalOpen = $state(false);

  // Zoom
  zoomPercent = $state(100);

  constructor() {
    this.loadPersistedZoom();
    this.loadPersistedUI();
  }

  /**
   * Toggle sidebar visibility
   */
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    this.persistUI();
  }

  /**
   * Set active sidebar panel
   * If same panel clicked, close sidebar
   */
  setActiveSidebarPanel(panel: SidebarPanel): void {
    if (this.activeSidebarPanel === panel && this.sidebarOpen) {
      this.sidebarOpen = false;
    } else {
      this.activeSidebarPanel = panel;
      this.sidebarOpen = true;
    }
    this.persistUI();
  }

  /**
   * Toggle bottom panel (terminal)
   */
  toggleBottomPanel(): void {
    this.bottomPanelOpen = !this.bottomPanelOpen;
    this.persistUI();
  }

  /**
   * Open bottom panel with a specific tab
   */
  openBottomPanelTab(tab: BottomPanelTab): void {
    bottomPanelStore.setActiveTab(tab);
    this.bottomPanelOpen = true;
    this.persistUI();
  }

  /**
   * Open a menu
   */
  openMenu(menuId: string): void {
    this.activeMenu = menuId;
  }

  /**
   * Close all menus
   */
  closeMenus(): void {
    this.activeMenu = null;
  }

  /**
   * Toggle a specific menu
   */
  toggleMenu(menuId: string): void {
    if (this.activeMenu === menuId) {
      this.activeMenu = null;
    } else {
      this.activeMenu = menuId;
    }
  }

  /**
   * Open about modal
   */
  openAboutModal(): void {
    this.aboutModalOpen = true;
    this.closeMenus();
  }

  /**
   * Close about modal
   */
  closeAboutModal(): void {
    this.aboutModalOpen = false;
  }

  /**
   * Set sidebar width (for resizing)
   */
  setSidebarWidth(width: number): void {
    this.sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
  }

  /**
   * Set bottom panel height (for resizing)
   */
  setBottomPanelHeight(height: number): void {
    this.bottomPanelHeight = Math.max(160, Math.min(500, height));
  }

  /**
   * Set UI zoom in percent (e.g., 100 = 100%)
   */
  setZoomPercent(percent: number): void {
    if (!Number.isFinite(percent)) return;
    const rounded = Math.round(percent);
    const next = Math.max(ZOOM_MIN_PERCENT, Math.min(ZOOM_MAX_PERCENT, rounded));
    this.zoomPercent = next;
    this.persistZoom();
  }

  zoomIn(): void {
    this.setZoomPercent(this.zoomPercent + ZOOM_STEP_PERCENT);
  }

  zoomOut(): void {
    this.setZoomPercent(this.zoomPercent - ZOOM_STEP_PERCENT);
  }

  resetZoom(): void {
    this.setZoomPercent(100);
  }

  private loadPersistedZoom(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
      if (!raw) return;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        const rounded = Math.round(parsed);
        this.zoomPercent = Math.max(ZOOM_MIN_PERCENT, Math.min(ZOOM_MAX_PERCENT, rounded));
      }
    } catch {
      // ignore
    }
  }

  private persistZoom(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(this.zoomPercent));
    } catch {
      // ignore
    }
  }

  private loadPersistedUI(): void {
    if (typeof window === 'undefined') return;
    try {
      const sidebarOpen = localStorage.getItem(SIDEBAR_OPEN_KEY);
      if (sidebarOpen !== null) this.sidebarOpen = sidebarOpen === 'true';

      const sidebarPanel = localStorage.getItem(SIDEBAR_PANEL_KEY);
      if (sidebarPanel) this.activeSidebarPanel = sidebarPanel as SidebarPanel;

      const bottomPanelOpen = localStorage.getItem(BOTTOM_PANEL_OPEN_KEY);
      if (bottomPanelOpen !== null) this.bottomPanelOpen = bottomPanelOpen === 'true';
    } catch {
      // ignore
    }
  }

  private persistUI(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, String(this.sidebarOpen));
      if (this.activeSidebarPanel) {
        localStorage.setItem(SIDEBAR_PANEL_KEY, this.activeSidebarPanel);
      }
      localStorage.setItem(BOTTOM_PANEL_OPEN_KEY, String(this.bottomPanelOpen));
    } catch {
      // ignore
    }
  }
}

// Singleton instance
export const uiStore = new UIStore();
