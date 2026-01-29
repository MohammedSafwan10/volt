/**
 * Theme store using Svelte 5 runes
 * Manages theme selection with localStorage persistence and system preference detection
 */

import { darkThemeVars, voltDarkMonacoTheme } from '$lib/themes/dark';
import { lightThemeVars, voltLightMonacoTheme } from '$lib/themes/light';
import { midnightThemeVars, voltMidnightMonacoTheme } from '$lib/themes/midnight';

const STORAGE_KEY = 'volt.theme';

export type ThemeMode = 'dark' | 'light' | 'midnight' | 'system';
export type ResolvedTheme = 'dark' | 'light' | 'midnight';

class ThemeStore {
  /** User's theme preference (dark, light, midnight, or system) */
  mode = $state<ThemeMode>('system');

  /** The actual resolved theme based on mode and system preference */
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
   * Toggle between themes (cycling behavior)
   */
  toggle(): void {
    this.cycle();
  }

  /**
   * Cycle through themes: dark -> midnight -> light -> system -> dark
   */
  cycle(): void {
    const order: ThemeMode[] = ['dark', 'midnight', 'light', 'system'];
    const currentIndex = order.indexOf(this.mode);
    const nextIndex = (currentIndex + 1) % order.length;
    this.setMode(order[nextIndex]);
  }

  /**
   * Check if dark mode (anysphere) is active
   */
  get isDark(): boolean {
    return this.resolvedTheme === 'dark';
  }

  /**
   * Check if midnight mode (classic dark) is active
   */
  get isMidnight(): boolean {
    return this.resolvedTheme === 'midnight';
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
      case 'midnight': return 'Midnight';
      case 'light': return 'Light';
      case 'system': return `System (${this.resolvedTheme.charAt(0).toUpperCase() + this.resolvedTheme.slice(1)})`;
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
   * Defaults to 'dark' (Anysphere) as the primary dark mode
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

    let vars: Record<string, string>;
    switch (this.resolvedTheme) {
      case 'dark': vars = darkThemeVars; break;
      case 'midnight': vars = midnightThemeVars; break;
      case 'light': vars = lightThemeVars; break;
    }

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

      let themeName;
      switch (this.resolvedTheme) {
        case 'dark': themeName = 'volt-dark'; break;
        case 'midnight': themeName = 'volt-midnight'; break;
        case 'light': themeName = 'volt-light'; break;
      }

      // Define themes if not already defined
      try {
        monaco.editor.defineTheme('volt-dark', voltDarkMonacoTheme);
        monaco.editor.defineTheme('volt-midnight', voltMidnightMonacoTheme);
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
      if (stored && ['dark', 'midnight', 'light', 'system'].includes(stored)) {
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
  switch (themeStore.resolvedTheme) {
    case 'dark': return 'volt-dark';
    case 'midnight': return 'volt-midnight';
    case 'light': return 'volt-light';
  }
}
