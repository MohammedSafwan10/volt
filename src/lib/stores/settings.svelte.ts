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
}

const DEFAULT_SETTINGS: Settings = {
  autoSaveEnabled: false,
  autoSaveDelay: 1000
};

class SettingsStore {
  /** Auto-save enabled state */
  autoSaveEnabled = $state(DEFAULT_SETTINGS.autoSaveEnabled);
  
  /** Auto-save delay in milliseconds */
  autoSaveDelay = $state(DEFAULT_SETTINGS.autoSaveDelay);

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
        autoSaveDelay: this.autoSaveDelay
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage errors
    }
  }
}

// Singleton instance
export const settingsStore = new SettingsStore();
