/**
 * Browser Panel Store - Svelte 5 runes
 * Full-featured browser with zoom, find, bookmarks, history, responsive mode
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type BrowserMode = 'normal' | 'select';
export type BrowserStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SelectedElement {
  tagName: string;
  id: string;
  classes: string[];
  html: string;
  css: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  selector: string;
  xpath: string;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  created_at: number;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visited_at: number;
}

export interface ResponsivePreset {
  name: string;
  width: number;
  height: number;
  icon: string;
}

export interface PageContent {
  text: string;
  headings: { level: number; text: string }[];
  links: { text: string; href: string }[];
  images: { alt: string; src: string }[];
  meta: { title: string; description: string; url: string };
}

interface BrowserInfo {
  is_open: boolean;
  url: string;
  title: string;
  select_mode: boolean;
  zoom_level: number;
  can_go_back: boolean;
  can_go_forward: boolean;
}

// Common responsive presets
export const RESPONSIVE_PRESETS: ResponsivePreset[] = [
  { name: 'iPhone SE', width: 375, height: 667, icon: 'smartphone' },
  { name: 'iPhone 14', width: 390, height: 844, icon: 'smartphone' },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932, icon: 'smartphone' },
  { name: 'iPad Mini', width: 768, height: 1024, icon: 'tablet' },
  { name: 'iPad Pro', width: 1024, height: 1366, icon: 'tablet' },
  { name: 'Desktop', width: 1920, height: 1080, icon: 'monitor' },
];

class BrowserStore {
  // State
  url = $state('https://www.google.com');
  title = $state('New Tab');
  status = $state<BrowserStatus>('idle');
  mode = $state<BrowserMode>('normal');
  canGoBack = $state(false);
  canGoForward = $state(false);
  selectedElement = $state<SelectedElement | null>(null);
  error = $state<string | null>(null);
  isOpen = $state(false);
  isVisible = $state(false);
  
  // New features
  zoomLevel = $state(1.0);
  findQuery = $state('');
  findCount = $state(0);
  findIndex = $state(-1);
  bookmarks = $state<Bookmark[]>([]);
  history = $state<HistoryEntry[]>([]);
  responsiveMode = $state<{ width: number; height: number } | null>(null);
  extractedContent = $state<PageContent | null>(null);
  
  // Live Reload feature
  liveReloadEnabled = $state(true);
  private liveReloadUnlisten: UnlistenFn | null = null;
  private lastReloadTime = 0;
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Internal
  private historyStack: string[] = [];
  private historyIndex = -1;
  private unlisteners: UnlistenFn[] = [];
  private initialized = false;
  private boundsTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBounds: BrowserBounds | null = null;
  private pendingBounds: BrowserBounds | null = null;

  private static STORAGE_KEY = 'volt-browser-url';
  private static BOOKMARKS_KEY = 'volt-browser-bookmarks';
  private static LIVE_RELOAD_KEY = 'volt-browser-live-reload';

  constructor() {
    // Load from localStorage
    if (typeof localStorage !== 'undefined') {
      const savedUrl = localStorage.getItem(BrowserStore.STORAGE_KEY);
      if (savedUrl) this.url = savedUrl;
      
      const savedBookmarks = localStorage.getItem(BrowserStore.BOOKMARKS_KEY);
      if (savedBookmarks) {
        try {
          this.bookmarks = JSON.parse(savedBookmarks);
        } catch { /* ignore */ }
      }
      
      // Load live reload preference (default: enabled)
      const savedLiveReload = localStorage.getItem(BrowserStore.LIVE_RELOAD_KEY);
      if (savedLiveReload !== null) {
        this.liveReloadEnabled = savedLiveReload === 'true';
      }
    }
  }

  private saveUrl(url: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BrowserStore.STORAGE_KEY, url);
    }
  }

  private saveBookmarks(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BrowserStore.BOOKMARKS_KEY, JSON.stringify(this.bookmarks));
    }
  }

  async open(initialUrl?: string): Promise<void> {
    if (this.isOpen) return;

    const url = initialUrl || this.url || 'https://www.google.com';

    this.isOpen = true;
    this.isVisible = true;
    this.url = url;
    this.status = 'loading';
    this.error = null;
    this.historyStack = [url];
    this.historyIndex = 0;
    this.canGoBack = false;
    this.canGoForward = false;
    this.selectedElement = null;
    this.mode = 'normal';
    this.zoomLevel = 1.0;
    this.findQuery = '';
    this.findCount = 0;
    this.findIndex = -1;
    this.responsiveMode = null;
    this.extractedContent = null;

    try {
      if (!this.initialized) {
        await this.setupListeners();
        this.initialized = true;
      }
      
      // Start live reload if enabled
      if (this.liveReloadEnabled) {
        this.startLiveReload();
      }
    } catch (err) {
      console.error('[Browser] Failed to open:', err);
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;

    if (this.boundsTimer) {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = null;
    }
    
    // Stop live reload
    this.stopLiveReload();

    try {
      await invoke('browser_close');
    } catch (err) {
      console.error('[Browser] Close error:', err);
    }

    this.isOpen = false;
    this.isVisible = false;
    this.status = 'idle';
    this.mode = 'normal';
    this.selectedElement = null;
    this.error = null;
    this.historyStack = [];
    this.historyIndex = -1;
    this.lastBounds = null;
    this.pendingBounds = null;
    this.findQuery = '';
    this.findCount = 0;
    this.responsiveMode = null;
    this.extractedContent = null;
  }

  async setVisible(visible: boolean): Promise<void> {
    if (!this.isOpen) return;
    if (this.isVisible === visible) return;
    
    this.isVisible = visible;
    
    try {
      if (visible) {
        await invoke('browser_show');
        this.lastBounds = null;
      } else {
        await invoke('browser_hide');
      }
    } catch (err) {
      console.error('[Browser] Set visible error:', err);
    }
  }

  async navigate(url: string): Promise<void> {
    if (!this.isOpen) return;

    let finalUrl = url.trim();
    if (!finalUrl) return;

    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      if (finalUrl.includes(' ') || !finalUrl.includes('.')) {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
      } else {
        finalUrl = `https://${finalUrl}`;
      }
    }

    this.status = 'loading';
    this.url = finalUrl;
    this.error = null;

    this.historyIndex++;
    this.historyStack = this.historyStack.slice(0, this.historyIndex);
    this.historyStack.push(finalUrl);
    this.updateNavState();
    this.saveUrl(finalUrl);

    try {
      await invoke('browser_navigate', { url: finalUrl });
      this.status = 'ready';
    } catch (err) {
      console.error('[Browser] Navigate failed:', err);
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async goBack(): Promise<void> {
    if (!this.canGoBack || this.historyIndex <= 0) return;
    this.historyIndex--;
    this.url = this.historyStack[this.historyIndex];
    this.status = 'loading';
    this.updateNavState();
    try {
      await invoke('browser_back');
      this.status = 'ready';
    } catch (err) {
      console.error('[Browser] Back failed:', err);
    }
  }

  async goForward(): Promise<void> {
    if (!this.canGoForward || this.historyIndex >= this.historyStack.length - 1) return;
    this.historyIndex++;
    this.url = this.historyStack[this.historyIndex];
    this.status = 'loading';
    this.updateNavState();
    try {
      await invoke('browser_forward');
      this.status = 'ready';
    } catch (err) {
      console.error('[Browser] Forward failed:', err);
    }
  }

  async reload(): Promise<void> {
    if (!this.isOpen) return;
    this.status = 'loading';
    this.error = null;
    try {
      await invoke('browser_reload');
      this.status = 'ready';
    } catch (err) {
      console.error('[Browser] Reload failed:', err);
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async hardReload(): Promise<void> {
    if (!this.isOpen) return;
    this.status = 'loading';
    try {
      await invoke('browser_hard_reload');
      this.status = 'ready';
    } catch (err) {
      console.error('[Browser] Hard reload failed:', err);
    }
  }

  async stop(): Promise<void> {
    if (!this.isOpen) return;
    try {
      await invoke('browser_stop');
      this.status = 'ready';
    } catch (err) {
      console.error('[Browser] Stop failed:', err);
    }
  }

  // Zoom controls
  async zoomIn(): Promise<void> {
    if (!this.isOpen) return;
    try {
      const level = await invoke<number>('browser_zoom_in');
      this.zoomLevel = level;
    } catch (err) {
      console.error('[Browser] Zoom in failed:', err);
    }
  }

  async zoomOut(): Promise<void> {
    if (!this.isOpen) return;
    try {
      const level = await invoke<number>('browser_zoom_out');
      this.zoomLevel = level;
    } catch (err) {
      console.error('[Browser] Zoom out failed:', err);
    }
  }

  async zoomReset(): Promise<void> {
    if (!this.isOpen) return;
    try {
      const level = await invoke<number>('browser_zoom_reset');
      this.zoomLevel = level;
    } catch (err) {
      console.error('[Browser] Zoom reset failed:', err);
    }
  }

  async setZoom(level: number): Promise<void> {
    if (!this.isOpen) return;
    try {
      const newLevel = await invoke<number>('browser_set_zoom', { level });
      this.zoomLevel = newLevel;
    } catch (err) {
      console.error('[Browser] Set zoom failed:', err);
    }
  }

  // Find in page
  async find(query: string): Promise<void> {
    if (!this.isOpen) return;
    this.findQuery = query;
    try {
      await invoke('browser_find', { query, highlight: true });
    } catch (err) {
      console.error('[Browser] Find failed:', err);
    }
  }

  async findNext(): Promise<void> {
    if (!this.isOpen || !this.findQuery) return;
    try {
      await invoke('browser_find_next');
    } catch (err) {
      console.error('[Browser] Find next failed:', err);
    }
  }

  async findPrev(): Promise<void> {
    if (!this.isOpen || !this.findQuery) return;
    try {
      await invoke('browser_find_prev');
    } catch (err) {
      console.error('[Browser] Find prev failed:', err);
    }
  }

  async findClear(): Promise<void> {
    if (!this.isOpen) return;
    this.findQuery = '';
    this.findCount = 0;
    this.findIndex = -1;
    try {
      await invoke('browser_find_clear');
    } catch (err) {
      console.error('[Browser] Find clear failed:', err);
    }
  }

  // Bookmarks
  async addBookmark(): Promise<void> {
    if (!this.isOpen || !this.url) return;
    try {
      const bookmark = await invoke<Bookmark>('browser_add_bookmark', {
        url: this.url,
        title: this.title || this.url,
      });
      this.bookmarks = [...this.bookmarks, bookmark];
      this.saveBookmarks();
    } catch (err) {
      console.error('[Browser] Add bookmark failed:', err);
    }
  }

  async removeBookmark(id: string): Promise<void> {
    try {
      await invoke('browser_remove_bookmark', { id });
      this.bookmarks = this.bookmarks.filter(b => b.id !== id);
      this.saveBookmarks();
    } catch (err) {
      console.error('[Browser] Remove bookmark failed:', err);
    }
  }

  isBookmarked(url: string): boolean {
    return this.bookmarks.some(b => b.url === url);
  }

  // History
  async loadHistory(): Promise<void> {
    try {
      const history = await invoke<HistoryEntry[]>('browser_get_history', { limit: 100 });
      this.history = history;
    } catch (err) {
      console.error('[Browser] Load history failed:', err);
    }
  }

  async clearHistory(): Promise<void> {
    try {
      await invoke('browser_clear_history');
      this.history = [];
    } catch (err) {
      console.error('[Browser] Clear history failed:', err);
    }
  }

  // Responsive mode
  async setResponsiveMode(width?: number, height?: number): Promise<void> {
    if (!this.isOpen) return;
    try {
      await invoke('browser_set_responsive_mode', { width, height });
      this.responsiveMode = width && height ? { width, height } : null;
    } catch (err) {
      console.error('[Browser] Set responsive mode failed:', err);
    }
  }

  async clearResponsiveMode(): Promise<void> {
    await this.setResponsiveMode();
  }

  // DevTools
  async openDevTools(): Promise<void> {
    if (!this.isOpen) return;
    try {
      await invoke('browser_open_devtools');
    } catch (err) {
      console.error('[Browser] Open devtools failed:', err);
    }
  }

  // AI Integration
  async extractContent(): Promise<void> {
    if (!this.isOpen) return;
    try {
      await invoke('browser_extract_content');
    } catch (err) {
      console.error('[Browser] Extract content failed:', err);
    }
  }

  async generateCode(): Promise<void> {
    if (!this.isOpen) return;
    try {
      await invoke('browser_generate_code');
    } catch (err) {
      console.error('[Browser] Generate code failed:', err);
    }
  }

  // Element selection
  async toggleSelectMode(): Promise<void> {
    if (!this.isOpen) return;
    const newMode = this.mode === 'select' ? 'normal' : 'select';
    
    try {
      if (newMode === 'select') {
        // Try CDP-based element picker first (more reliable)
        try {
          await invoke('cdp_enable_element_picker');
          this.mode = 'select';
        } catch (cdpErr) {
          // Fallback to old JS injection method
          console.warn('[Browser] CDP element picker failed, using fallback:', cdpErr);
          await invoke('browser_set_select_mode', { enabled: true });
          this.mode = 'select';
        }
      } else {
        // Disable element picker
        try {
          await invoke('cdp_disable_element_picker');
        } catch { /* ignore */ }
        try {
          await invoke('browser_set_select_mode', { enabled: false });
        } catch { /* ignore */ }
        this.mode = 'normal';
        this.selectedElement = null;
      }
    } catch (err) {
      console.error('[Browser] Toggle select mode failed:', err);
    }
  }

  async executeJs(script: string): Promise<void> {
    if (!this.isOpen) return;
    try {
      await invoke('browser_execute_js', { script });
    } catch (err) {
      console.error('[Browser] Execute JS failed:', err);
    }
  }

  clearSelection(): void {
    this.selectedElement = null;
    // Clear the highlight in the browser
    this.clearSelectionHighlight();
  }

  /** Clear the selection highlight in the browser (without clearing selectedElement state) */
  private async clearSelectionHighlight(): Promise<void> {
    if (!this.isOpen) return;
    try {
      // Try CDP method first
      await invoke('cdp_disable_element_picker');
    } catch {
      // Fallback to JS injection
      try {
        await invoke('browser_execute_js', { 
          script: 'if(window.__voltClearSelectionHighlight) window.__voltClearSelectionHighlight();' 
        });
      } catch { /* ignore */ }
    }
  }

  // ==================== LIVE RELOAD ====================
  
  /**
   * Toggle live reload on/off
   */
  setLiveReload(enabled: boolean): void {
    this.liveReloadEnabled = enabled;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BrowserStore.LIVE_RELOAD_KEY, String(enabled));
    }
    
    if (enabled && this.isOpen) {
      this.startLiveReload();
    } else {
      this.stopLiveReload();
    }
  }

  /**
   * Start watching project files for changes
   * Triggers browser reload when files change
   */
  private async startLiveReload(): Promise<void> {
    if (this.liveReloadUnlisten) return; // Already watching
    
    try {
      // Listen for file change events from Tauri file watcher
      this.liveReloadUnlisten = await listen<{ changes: Array<{ kind: string; paths: string[] }> }>('file-watch://change', (event) => {
        if (!this.liveReloadEnabled || !this.isOpen || !this.isVisible) return;
        
        const { changes } = event.payload;
        
        // Check if any change is a web file we care about
        const webExtensions = ['.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.vue', '.svelte', '.json'];
        
        for (const change of changes) {
          // Only reload on modify or create events
          if (change.kind !== 'modify' && change.kind !== 'create') continue;
          
          for (const path of change.paths) {
            const isWebFile = webExtensions.some(ext => path.toLowerCase().endsWith(ext));
            if (isWebFile) {
              this.triggerLiveReload();
              return; // One reload is enough
            }
          }
        }
      });
    } catch (err) {
      console.error('[Browser] Failed to start live reload:', err);
    }
  }

  /**
   * Stop watching for file changes
   */
  private stopLiveReload(): void {
    if (this.liveReloadUnlisten) {
      this.liveReloadUnlisten();
      this.liveReloadUnlisten = null;
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
  }

  /**
   * Trigger a debounced reload
   * Prevents multiple rapid reloads and avoids conflict with native HMR
   */
  private triggerLiveReload(): void {
    // Clear any pending reload
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }
    
    // Debounce: wait 300ms before reloading
    this.reloadDebounceTimer = setTimeout(async () => {
      // Check if we recently reloaded (native HMR might have handled it)
      const now = Date.now();
      if (now - this.lastReloadTime < 1000) {
        return; // Skip - likely native HMR already handled it
      }
      
      this.lastReloadTime = now;
      await this.reload();
    }, 300);
  }

  // ==================== END LIVE RELOAD ====================

  private updateNavState(): void {
    this.canGoBack = this.historyIndex > 0;
    this.canGoForward = this.historyIndex < this.historyStack.length - 1;
  }

  /**
   * Inject devtools capture scripts into the browser
   * Called after navigation to capture console, errors, network
   */
  private async injectDevToolsScripts(): Promise<void> {
    if (!this.isOpen) return;
    
    // Wait a bit for page to start loading
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      // Import dynamically to avoid circular deps
      const { getDevToolsScript } = await import('$lib/services/browser/devtools-inject');
      const script = getDevToolsScript();
      await this.executeJs(script);
    } catch (err) {
      console.error('[Browser] Failed to inject devtools:', err);
    }
  }

  async setBounds(bounds: BrowserBounds): Promise<void> {
    if (!this.isOpen) return;

    if (this.lastBounds) {
      const dx = Math.abs(bounds.x - this.lastBounds.x);
      const dy = Math.abs(bounds.y - this.lastBounds.y);
      const dw = Math.abs(bounds.width - this.lastBounds.width);
      const dh = Math.abs(bounds.height - this.lastBounds.height);
      if (dx < 1 && dy < 1 && dw < 1 && dh < 1) return;
    }

    this.pendingBounds = { ...bounds };

    if (this.boundsTimer) {
      clearTimeout(this.boundsTimer);
    }

    this.boundsTimer = setTimeout(async () => {
      if (!this.pendingBounds || !this.isOpen) return;
      
      const b = this.pendingBounds;
      this.lastBounds = { ...b };
      
      if (b.width < 50 || b.height < 50) return;

      try {
        const state = await invoke<BrowserInfo>('browser_get_state');
        
        if (!state.is_open) {
          await invoke('browser_create', { url: this.url, bounds: b });
          this.status = 'ready';
        } else {
          await invoke('browser_set_bounds', { bounds: b });
        }
      } catch (err) {
        console.error('[Browser] Set bounds failed:', err);
        this.status = 'error';
        this.error = err instanceof Error ? err.message : String(err);
      }
    }, 30);
  }

  async hide(): Promise<void> {
    try {
      await invoke('browser_hide');
    } catch { /* ignore */ }
  }

  async show(): Promise<void> {
    try {
      await invoke('browser_show');
    } catch { /* ignore */ }
  }

  private async setupListeners(): Promise<void> {
    const unlistenSelect = await listen<SelectedElement>('browser://element-selected', (event) => {
      this.selectedElement = event.payload;
    });
    this.unlisteners.push(unlistenSelect);

    const unlistenNav = await listen<string>('browser://navigated', async (event) => {
      this.url = event.payload;
      this.status = 'ready';
      
      // Check if CDP is connected, if not try to connect or fallback to JS injection
      try {
        const { cdp } = await import('$lib/services/browser/cdp');
        const status = await cdp.getStatus();
        if (!status.connected) {
          // Try CDP first - pass the browser URL so it attaches to the right page
          const { connectCdpToBrowser } = await import('$lib/services/browser');
          const cdpConnected = await connectCdpToBrowser(this.url);
          if (!cdpConnected) {
            this.injectDevToolsScripts();
          }
        }
        // CDP is connected, events will flow through CDP
      } catch {
        // Fallback to JS injection
        this.injectDevToolsScripts();
      }
    });
    this.unlisteners.push(unlistenNav);

    const unlistenCreated = await listen<string>('browser://created', async (event) => {
      this.status = 'ready';
      
      // Try to connect CDP for professional browser automation
      try {
        const { connectCdpToBrowser } = await import('$lib/services/browser');
        // Pass the browser URL so CDP attaches to the browser webview, not Volt's main window
        const cdpConnected = await connectCdpToBrowser(this.url);
        if (cdpConnected) {
          // CDP connected - element selection will use CDP
        } else {
          // Fallback to JS injection
          this.injectDevToolsScripts();
        }
      } catch (err) {
        console.warn('[Browser] CDP connection failed, using JS injection:', err);
        this.injectDevToolsScripts();
      }
    });
    this.unlisteners.push(unlistenCreated);

    const unlistenClosed = await listen('browser://closed', () => {
      this.isOpen = false;
      this.status = 'idle';
    });
    this.unlisteners.push(unlistenClosed);

    const unlistenSelectMode = await listen<boolean>('browser://select-mode', (event) => {
      this.mode = event.payload ? 'select' : 'normal';
    });
    this.unlisteners.push(unlistenSelectMode);

    const unlistenZoom = await listen<number>('browser://zoom-changed', (event) => {
      this.zoomLevel = event.payload;
    });
    this.unlisteners.push(unlistenZoom);

    const unlistenFindResult = await listen<number>('browser://find-result', (event) => {
      this.findCount = event.payload;
    });
    this.unlisteners.push(unlistenFindResult);

    const unlistenContent = await listen<PageContent>('browser://content-extracted', (event) => {
      this.extractedContent = event.payload;
    });
    this.unlisteners.push(unlistenContent);

    const unlistenResponsive = await listen<[number | null, number | null]>('browser://responsive-mode-changed', (event) => {
      const [w, h] = event.payload;
      this.responsiveMode = w && h ? { width: w, height: h } : null;
    });
    this.unlisteners.push(unlistenResponsive);
  }

  async cleanup(): Promise<void> {
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];
    
    if (this.boundsTimer) {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = null;
    }
    
    await this.close();
    this.initialized = false;
  }
}

export const browserStore = new BrowserStore();
