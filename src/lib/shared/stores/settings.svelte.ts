/**
 * Settings store using Svelte 5 runes
 * Manages user preferences with localStorage persistence
 */

const STORAGE_KEY = 'volt.settings';

interface Settings {
  /** Auto-save enabled state */
  autoSaveEnabled: boolean;
  /** Auto-save delay in milliseconds */
  autoSaveDelay: number;
  /** Format on save enabled state */
  formatOnSaveEnabled: boolean;

  /** Editor font size (Monaco) */
  editorFontSize: number;
  /** Show line numbers */
  editorLineNumbersEnabled: boolean;
  /** Show minimap */
  editorMinimapEnabled: boolean;
  /** Default tab size */
  editorTabSize: number;
  /** Use spaces for indentation */
  editorInsertSpaces: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  autoSaveEnabled: false,
  autoSaveDelay: 1000,
  formatOnSaveEnabled: false,
  editorFontSize: 14,
  editorLineNumbersEnabled: true,
  editorMinimapEnabled: true,
  editorTabSize: 2,
  editorInsertSpaces: true
};

class SettingsStore {
  /** Auto-save enabled state */
  autoSaveEnabled = $state(DEFAULT_SETTINGS.autoSaveEnabled);
  
  /** Auto-save delay in milliseconds */
  autoSaveDelay = $state(DEFAULT_SETTINGS.autoSaveDelay);
  
  /** Format on save enabled state */
  formatOnSaveEnabled = $state(DEFAULT_SETTINGS.formatOnSaveEnabled);

  /** Editor font size (Monaco) */
  editorFontSize = $state(DEFAULT_SETTINGS.editorFontSize);

  /** Show line numbers */
  editorLineNumbersEnabled = $state(DEFAULT_SETTINGS.editorLineNumbersEnabled);

  /** Show minimap */
  editorMinimapEnabled = $state(DEFAULT_SETTINGS.editorMinimapEnabled);

  /** Default tab size */
  editorTabSize = $state(DEFAULT_SETTINGS.editorTabSize);

  /** Use spaces for indentation */
  editorInsertSpaces = $state(DEFAULT_SETTINGS.editorInsertSpaces);

  constructor() {
    this.loadFromStorage();
  }

  /**
   * Toggle auto-save on/off
   */
  toggleAutoSave(): void {
    this.autoSaveEnabled = !this.autoSaveEnabled;
    this.saveToStorage();
  }

  /**
   * Set auto-save enabled state
   */
  setAutoSaveEnabled(enabled: boolean): void {
    this.autoSaveEnabled = enabled;
    this.saveToStorage();
  }

  /**
   * Set auto-save delay
   */
  setAutoSaveDelay(delay: number): void {
    this.autoSaveDelay = Math.max(500, Math.min(5000, delay));
    this.saveToStorage();
  }

  /**
   * Toggle format on save on/off
   */
  toggleFormatOnSave(): void {
    this.formatOnSaveEnabled = !this.formatOnSaveEnabled;
    this.saveToStorage();
  }

  /**
   * Set format on save enabled state
   */
  setFormatOnSaveEnabled(enabled: boolean): void {
    this.formatOnSaveEnabled = enabled;
    this.saveToStorage();
  }

  setEditorFontSize(size: number): void {
    if (!Number.isFinite(size)) return;
    this.editorFontSize = Math.max(10, Math.min(24, Math.round(size)));
    this.saveToStorage();
  }

  setEditorLineNumbersEnabled(enabled: boolean): void {
    this.editorLineNumbersEnabled = enabled;
    this.saveToStorage();
  }

  setEditorMinimapEnabled(enabled: boolean): void {
    this.editorMinimapEnabled = enabled;
    this.saveToStorage();
  }

  setEditorTabSize(size: number): void {
    if (!Number.isFinite(size)) return;
    this.editorTabSize = Math.max(1, Math.min(8, Math.round(size)));
    this.saveToStorage();
  }

  setEditorInsertSpaces(enabled: boolean): void {
    this.editorInsertSpaces = enabled;
    this.saveToStorage();
  }

  /** Reset all settings back to defaults */
  resetToDefaults(): void {
    this.autoSaveEnabled = DEFAULT_SETTINGS.autoSaveEnabled;
    this.autoSaveDelay = DEFAULT_SETTINGS.autoSaveDelay;
    this.formatOnSaveEnabled = DEFAULT_SETTINGS.formatOnSaveEnabled;
    this.editorFontSize = DEFAULT_SETTINGS.editorFontSize;
    this.editorLineNumbersEnabled = DEFAULT_SETTINGS.editorLineNumbersEnabled;
    this.editorMinimapEnabled = DEFAULT_SETTINGS.editorMinimapEnabled;
    this.editorTabSize = DEFAULT_SETTINGS.editorTabSize;
    this.editorInsertSpaces = DEFAULT_SETTINGS.editorInsertSpaces;
    this.saveToStorage();
  }

  /**
   * Load settings from localStorage
   */
  private loadFromStorage(): void {
    if (typeof window === 'undefined') return;
    
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      
      const parsed = JSON.parse(raw) as Partial<Settings>;
      
      if (typeof parsed.autoSaveEnabled === 'boolean') {
        this.autoSaveEnabled = parsed.autoSaveEnabled;
      }
      if (typeof parsed.autoSaveDelay === 'number') {
        this.autoSaveDelay = parsed.autoSaveDelay;
      }
      if (typeof parsed.formatOnSaveEnabled === 'boolean') {
        this.formatOnSaveEnabled = parsed.formatOnSaveEnabled;
      }

      if (typeof parsed.editorFontSize === 'number' && Number.isFinite(parsed.editorFontSize)) {
        this.editorFontSize = Math.max(10, Math.min(24, Math.round(parsed.editorFontSize)));
      }
      if (typeof parsed.editorLineNumbersEnabled === 'boolean') {
        this.editorLineNumbersEnabled = parsed.editorLineNumbersEnabled;
      }
      if (typeof parsed.editorMinimapEnabled === 'boolean') {
        this.editorMinimapEnabled = parsed.editorMinimapEnabled;
      }
      if (typeof parsed.editorTabSize === 'number' && Number.isFinite(parsed.editorTabSize)) {
        this.editorTabSize = Math.max(1, Math.min(8, Math.round(parsed.editorTabSize)));
      }
      if (typeof parsed.editorInsertSpaces === 'boolean') {
        this.editorInsertSpaces = parsed.editorInsertSpaces;
      }
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  /**
   * Save settings to localStorage
   */
  private saveToStorage(): void {
    if (typeof window === 'undefined') return;
    
    try {
      const settings: Settings = {
        autoSaveEnabled: this.autoSaveEnabled,
        autoSaveDelay: this.autoSaveDelay,
        formatOnSaveEnabled: this.formatOnSaveEnabled,
        editorFontSize: this.editorFontSize,
        editorLineNumbersEnabled: this.editorLineNumbersEnabled,
        editorMinimapEnabled: this.editorMinimapEnabled,
        editorTabSize: this.editorTabSize,
        editorInsertSpaces: this.editorInsertSpaces
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage errors
    }
  }
}

// Singleton instance
export const settingsStore = new SettingsStore();
