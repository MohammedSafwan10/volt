/**
 * Theme store using Svelte 5 runes
 * Manages theme selection with localStorage persistence and system preference detection
 */

import { darkThemeVars, voltDarkMonacoTheme } from '$lib/themes/dark';
import { lightThemeVars, voltLightMonacoTheme } from '$lib/themes/light';
import { midnightThemeVars, voltMidnightMonacoTheme } from '$lib/themes/midnight';
import { darkModernThemeVars, voltDarkModernMonacoTheme } from '$lib/themes/dark-modern';

const STORAGE_KEY = 'volt.theme';

export type ThemeMode = 'dark' | 'light' | 'midnight' | 'dark-modern';
export type ResolvedTheme = 'dark' | 'light' | 'midnight' | 'dark-modern';

class ThemeStore {
  /** User's theme preference (dark, light, midnight, or dark-modern) */
  mode = $state<ThemeMode>('dark-modern');

  /** The actual resolved theme based on mode */
  resolvedTheme = $state<ResolvedTheme>('dark-modern');

  constructor() {
    if (typeof window !== 'undefined') {
      this.loadFromStorage();
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
   * Cycle through themes: dark-modern -> dark -> midnight -> light -> dark-modern
   */
  cycle(): void {
    const order: ThemeMode[] = ['dark-modern', 'dark', 'midnight', 'light'];
    const currentIndex = order.indexOf(this.mode);
    const nextIndex = (currentIndex + 1) % order.length;
    this.setMode(order[nextIndex]);
  }

  /**
   * Check if dark modern mode is active
   */
  get isDarkModern(): boolean {
    return this.resolvedTheme === 'dark-modern';
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
   * Get display name for current theme mode
   */
  get displayName(): string {
    switch (this.mode) {
      case 'dark-modern': return 'Dark Modern';
      case 'dark': return 'Dark';
      case 'midnight': return 'Midnight';
      case 'light': return 'Light';
    }
  }

  /**
   * Update resolved theme based on mode
   */
  private updateResolvedTheme(): void {
    this.resolvedTheme = this.mode;
  }

  /**
   * Apply theme CSS variables to document
   */
  private applyTheme(): void {
    if (typeof document === 'undefined') return;

    let vars: Record<string, string>;
    switch (this.resolvedTheme) {
      case 'dark-modern': vars = darkModernThemeVars; break;
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
        case 'dark-modern': themeName = 'volt-dark-modern'; break;
        case 'dark': themeName = 'volt-dark'; break;
        case 'midnight': themeName = 'volt-midnight'; break;
        case 'light': themeName = 'volt-light'; break;
      }

      // Define themes if not already defined
      try {
        monaco.editor.defineTheme('volt-dark-modern', voltDarkModernMonacoTheme);
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
      if (stored && ['dark', 'midnight', 'light', 'dark-modern'].includes(stored)) {
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
    case 'dark-modern': return 'volt-dark-modern';
    case 'dark': return 'volt-dark';
    case 'midnight': return 'volt-midnight';
    case 'light': return 'volt-light';
  }
}
