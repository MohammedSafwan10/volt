/**
 * Theme store using Svelte 5 runes
 * Manages theme selection with localStorage persistence and system preference detection
 */

import { darkThemeVars, voltDarkMonacoTheme } from '$lib/themes/dark';
import { lightThemeVars, voltLightMonacoTheme } from '$lib/themes/light';

const STORAGE_KEY = 'volt.theme';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

class ThemeStore {
  /** User's theme preference (dark, light, or system) */
  mode = $state<ThemeMode>('system');
  
  /** The actual resolved theme (dark or light) based on mode and system preference */
  resolvedTheme = $state<ResolvedTheme>('dark');
  
  /** Media query for system preference detection */
  private mediaQuery: MediaQueryList | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.loadFromStorage();
      this.setupSystemPreferenceListener();
      this.updateResolvedTheme();
      this.applyTheme();
    }
  }

  /**
   * Set theme mode
   */
  setMode(mode: ThemeMode): void {
    this.mode = mode;
    this.updateResolvedTheme();
    this.applyTheme();
    this.saveToStorage();
  }

  /**
   * Toggle between dark and light themes
   * If currently on system, switches to the opposite of current resolved theme
   */
  toggle(): void {
    if (this.mode === 'system') {
      // Switch to explicit opposite of current resolved theme
      this.setMode(this.resolvedTheme === 'dark' ? 'light' : 'dark');
    } else {
      this.setMode(this.mode === 'dark' ? 'light' : 'dark');
    }
  }

  /**
   * Cycle through themes: dark -> light -> system -> dark
   */
  cycle(): void {
    const order: ThemeMode[] = ['dark', 'light', 'system'];
    const currentIndex = order.indexOf(this.mode);
    const nextIndex = (currentIndex + 1) % order.length;
    this.setMode(order[nextIndex]);
  }

  /**
   * Check if dark mode is active
   */
  get isDark(): boolean {
    return this.resolvedTheme === 'dark';
  }

  /**
   * Check if light mode is active
   */
  get isLight(): boolean {
    return this.resolvedTheme === 'light';
  }

  /**
   * Check if using system preference
   */
  get isSystem(): boolean {
    return this.mode === 'system';
  }

  /**
   * Get display name for current theme mode
   */
  get displayName(): string {
    switch (this.mode) {
      case 'dark': return 'Dark';
      case 'light': return 'Light';
      case 'system': return `System (${this.resolvedTheme === 'dark' ? 'Dark' : 'Light'})`;
    }
  }

  /**
   * Update resolved theme based on mode and system preference
   */
  private updateResolvedTheme(): void {
    if (this.mode === 'system') {
      this.resolvedTheme = this.getSystemPreference();
    } else {
      this.resolvedTheme = this.mode;
    }
  }

  /**
   * Get system color scheme preference
   */
  private getSystemPreference(): ResolvedTheme {
    if (typeof window === 'undefined') return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /**
   * Setup listener for system preference changes
   */
  private setupSystemPreferenceListener(): void {
    if (typeof window === 'undefined') return;
    
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = () => {
      if (this.mode === 'system') {
        this.updateResolvedTheme();
        this.applyTheme();
      }
    };
    
    // Use addEventListener for modern browsers
    this.mediaQuery.addEventListener('change', handleChange);
  }

  /**
   * Apply theme CSS variables to document
   */
  private applyTheme(): void {
    if (typeof document === 'undefined') return;
    
    const vars = this.resolvedTheme === 'dark' ? darkThemeVars : lightThemeVars;
    const root = document.documentElement;
    
    // Apply all CSS variables
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
    
    // Set data attribute for potential CSS selectors
    root.setAttribute('data-theme', this.resolvedTheme);
    
    // Update Monaco theme if loaded
    this.updateMonacoTheme();
  }

  /**
   * Update Monaco editor theme
   */
  private updateMonacoTheme(): void {
    // Dynamically import to avoid loading Monaco unnecessarily
    void import('$lib/services/monaco-loader').then(({ getMonaco }) => {
      const monaco = getMonaco();
      if (!monaco) return;
      
      const themeName = this.resolvedTheme === 'dark' ? 'volt-dark' : 'volt-light';
      
      // Define themes if not already defined
      try {
        monaco.editor.defineTheme('volt-dark', voltDarkMonacoTheme);
        monaco.editor.defineTheme('volt-light', voltLightMonacoTheme);
      } catch {
        // Themes may already be defined
      }
      
      // Set the active theme
      monaco.editor.setTheme(themeName);
    }).catch(() => {
      // Monaco not loaded yet, theme will be applied when it loads
    });
  }

  /**
   * Load theme preference from localStorage
   */
  private loadFromStorage(): void {
    if (typeof window === 'undefined') return;
    
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && ['dark', 'light', 'system'].includes(stored)) {
        this.mode = stored as ThemeMode;
      }
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Save theme preference to localStorage
   */
  private saveToStorage(): void {
    if (typeof window === 'undefined') return;
    
    try {
      localStorage.setItem(STORAGE_KEY, this.mode);
    } catch {
      // Ignore storage errors
    }
  }
}

// Singleton instance
export const themeStore = new ThemeStore();

/**
 * Get the current Monaco theme name based on resolved theme
 */
export function getMonacoThemeName(): string {
  return themeStore.resolvedTheme === 'dark' ? 'volt-dark' : 'volt-light';
}
