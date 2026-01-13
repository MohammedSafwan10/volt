/**
 * Browser Panel Store - Svelte 5 runes
 * Controls embedded browser via Rust commands (truly embedded using add_child)
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

interface BrowserInfo {
  is_open: boolean;
  url: string;
  select_mode: boolean;
}

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
  isVisible = $state(false); // Track if webview should be visible

  // Internal
  private history: string[] = [];
  private historyIndex = -1;
  private unlisteners: UnlistenFn[] = [];
  private initialized = false;
  private boundsTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBounds: BrowserBounds | null = null;
  private pendingBounds: BrowserBounds | null = null;

  private static STORAGE_KEY = 'volt-browser-url';

  constructor() {
    // Load last URL from localStorage
    if (typeof localStorage !== 'undefined') {
      const savedUrl = localStorage.getItem(BrowserStore.STORAGE_KEY);
      if (savedUrl) {
        this.url = savedUrl;
      }
    }
  }

  // Save URL to localStorage
  private saveUrl(url: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BrowserStore.STORAGE_KEY, url);
    }
  }

  /**
   * Open the browser panel with embedded webview
   */
  async open(initialUrl?: string): Promise<void> {
    if (this.isOpen) return;

    const url = initialUrl || 'https://www.google.com';

    this.isOpen = true;
    this.isVisible = true;
    this.url = url;
    this.status = 'loading';
    this.error = null;
    this.history = [url];
    this.historyIndex = 0;
    this.canGoBack = false;
    this.canGoForward = false;
    this.selectedElement = null;
    this.mode = 'normal';

    try {
      // Setup event listeners first
      if (!this.initialized) {
        await this.setupListeners();
        this.initialized = true;
      }

      console.log('[Browser] Ready - waiting for bounds to create webview');
    } catch (err) {
      console.error('[Browser] Failed to open:', err);
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Close the browser panel
   */
  async close(): Promise<void> {
    if (!this.isOpen) return;

    // Clear timers
    if (this.boundsTimer) {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = null;
    }

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
    this.history = [];
    this.historyIndex = -1;
    this.lastBounds = null;
    this.pendingBounds = null;
  }

  /**
   * Set browser visibility (hide/show webview without closing)
   */
  async setVisible(visible: boolean): Promise<void> {
    if (!this.isOpen) return;
    if (this.isVisible === visible) return;
    
    this.isVisible = visible;
    
    try {
      if (visible) {
        await invoke('browser_show');
        // Force bounds update when showing (reset cache)
        this.lastBounds = null;
      } else {
        await invoke('browser_hide');
      }
    } catch (err) {
      console.error('[Browser] Set visible error:', err);
    }
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string): Promise<void> {
    if (!this.isOpen) return;

    let finalUrl = url.trim();
    if (!finalUrl) return;

    // Add protocol if missing
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

    // Update history
    this.historyIndex++;
    this.history = this.history.slice(0, this.historyIndex);
    this.history.push(finalUrl);
    this.updateNavState();

    // Save URL to localStorage for persistence
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

  /**
   * Go back in history
   */
  async goBack(): Promise<void> {
    if (!this.canGoBack || this.historyIndex <= 0) return;

    this.historyIndex--;
    this.url = this.history[this.historyIndex];
    this.status = 'loading';
    this.updateNavState();

    try {
      await invoke('browser_back');
      this.status = 'ready';
    } catch (err) {
      console.error('[Browser] Back failed:', err);
    }
  }

  /**
   * Go forward in history
   */
  async goForward(): Promise<void> {
    if (!this.canGoForward || this.historyIndex >= this.history.length - 1) return;

    this.historyIndex++;
    this.url = this.history[this.historyIndex];
    this.status = 'loading';
    this.updateNavState();

    try {
      await invoke('browser_forward');
      this.status = 'ready';
    } catch (err) {
      console.error('[Browser] Forward failed:', err);
    }
  }

  /**
   * Reload current page
   */
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

  /**
   * Toggle element selection mode
   */
  async toggleSelectMode(): Promise<void> {
    if (!this.isOpen) return;

    const newMode = this.mode === 'select' ? 'normal' : 'select';

    try {
      await invoke('browser_set_select_mode', { enabled: newMode === 'select' });
      this.mode = newMode;
      if (newMode === 'normal') {
        this.selectedElement = null;
      }
    } catch (err) {
      console.error('[Browser] Toggle select mode failed:', err);
    }
  }

  /**
   * Execute JavaScript in the browser
   */
  async executeJs(script: string): Promise<void> {
    if (!this.isOpen) return;

    try {
      await invoke('browser_execute_js', { script });
    } catch (err) {
      console.error('[Browser] Execute JS failed:', err);
    }
  }

  /**
   * Update webview bounds (creates webview if needed)
   */
  async setBounds(bounds: BrowserBounds): Promise<void> {
    if (!this.isOpen) return;

    // Skip if bounds haven't changed at all
    if (this.lastBounds) {
      const dx = Math.abs(bounds.x - this.lastBounds.x);
      const dy = Math.abs(bounds.y - this.lastBounds.y);
      const dw = Math.abs(bounds.width - this.lastBounds.width);
      const dh = Math.abs(bounds.height - this.lastBounds.height);
      if (dx < 1 && dy < 1 && dw < 1 && dh < 1) return;
    }

    this.pendingBounds = { ...bounds };

    // Debounce updates (shorter delay for responsiveness)
    if (this.boundsTimer) {
      clearTimeout(this.boundsTimer);
    }

    this.boundsTimer = setTimeout(async () => {
      if (!this.pendingBounds || !this.isOpen) return;
      
      const b = this.pendingBounds;
      this.lastBounds = { ...b };
      
      // Need minimum size
      if (b.width < 50 || b.height < 50) return;

      try {
        // Check if browser exists
        const state = await invoke<BrowserInfo>('browser_get_state');
        
        if (!state.is_open) {
          // Create the browser
          console.log('[Browser] Creating embedded webview at:', b);
          await invoke('browser_create', { url: this.url, bounds: b });
          this.status = 'ready';
        } else {
          // Update bounds
          await invoke('browser_set_bounds', { bounds: b });
        }
      } catch (err) {
        console.error('[Browser] Set bounds failed:', err);
        this.status = 'error';
        this.error = err instanceof Error ? err.message : String(err);
      }
    }, 30);
  }

  /**
   * Hide the browser webview
   */
  async hide(): Promise<void> {
    try {
      await invoke('browser_hide');
    } catch (err) {
      // Ignore if not open
    }
  }

  /**
   * Show the browser webview
   */
  async show(): Promise<void> {
    try {
      await invoke('browser_show');
    } catch (err) {
      // Ignore if not open
    }
  }

  /**
   * Clear selected element
   */
  clearSelection(): void {
    this.selectedElement = null;
  }

  /**
   * Update navigation state
   */
  private updateNavState(): void {
    this.canGoBack = this.historyIndex > 0;
    this.canGoForward = this.historyIndex < this.history.length - 1;
  }

  /**
   * Setup event listeners
   */
  private async setupListeners(): Promise<void> {
    // Element selection events from Rust
    const unlistenSelect = await listen<SelectedElement>('browser://element-selected', (event) => {
      console.log('[Browser] Element selected:', event.payload);
      this.selectedElement = event.payload;
    });
    this.unlisteners.push(unlistenSelect);

    // Navigation events
    const unlistenNav = await listen<string>('browser://navigated', (event) => {
      console.log('[Browser] Navigated to:', event.payload);
      this.url = event.payload;
      this.status = 'ready';
    });
    this.unlisteners.push(unlistenNav);

    // Created event
    const unlistenCreated = await listen<string>('browser://created', (event) => {
      console.log('[Browser] Created with URL:', event.payload);
      this.status = 'ready';
    });
    this.unlisteners.push(unlistenCreated);

    // Closed event
    const unlistenClosed = await listen('browser://closed', () => {
      console.log('[Browser] Closed');
      this.isOpen = false;
      this.status = 'idle';
    });
    this.unlisteners.push(unlistenClosed);

    // Select mode event
    const unlistenSelectMode = await listen<boolean>('browser://select-mode', (event) => {
      this.mode = event.payload ? 'select' : 'normal';
    });
    this.unlisteners.push(unlistenSelectMode);
  }

  /**
   * Cleanup
   */
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
