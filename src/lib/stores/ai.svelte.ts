/**
 * AI Provider Settings Store
 * Manages AI provider configuration with secure key storage via OS credential manager
 *
 * SECURITY: API keys are stored via Rust commands using the OS credential manager.
 * Non-secret preferences (provider, model selections) are stored in localStorage
 */

import { invoke } from '@tauri-apps/api/core';

// Supported AI providers
export type AIProvider = 'gemini';

// AI operation modes
export type AIMode = 'ask' | 'plan' | 'agent';

// Provider capability flags
export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsJsonSchema: boolean;
  maxContextHint: number;
}

// Provider configuration
export interface ProviderConfig {
  id: AIProvider;
  name: string;
  capabilities: ProviderCapabilities;
  models: string[];
  defaultModel: string;
}

// Available providers with their capabilities
export const PROVIDERS: Record<AIProvider, ProviderConfig> = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsJsonSchema: true,
      maxContextHint: 1000000 // 1M tokens for Gemini 2.5
    },
    models: ['gemini-2.5-flash'],
    defaultModel: 'gemini-2.5-flash'
  }
};

// Validation result
export interface ValidationResult {
  success: boolean;
  error?: string;
}

// Non-secret preferences stored in localStorage
interface AIPreferences {
  selectedProvider: AIProvider;
  modelPerMode: Record<AIMode, string>;
}

const PREFS_STORAGE_KEY = 'volt.ai.preferences';

// Default preferences
const DEFAULT_PREFS: AIPreferences = {
  selectedProvider: 'gemini',
  modelPerMode: {
    ask: 'gemini-2.5-flash',
    plan: 'gemini-2.5-flash',
    agent: 'gemini-2.5-flash'
  }
};

class AISettingsStore {
  // Current provider
  selectedProvider = $state<AIProvider>('gemini');
  
  // Model selection per mode
  modelPerMode = $state<Record<AIMode, string>>({
    ask: 'gemini-2.5-flash',
    plan: 'gemini-2.5-flash',
    agent: 'gemini-2.5-flash'
  });
  
  // API key status (not the key itself!)
  hasApiKey = $state<Record<AIProvider, boolean>>({
    gemini: false
  });
  
  // Validation state
  isValidating = $state(false);
  validationError = $state<string | null>(null);

  private initialized = false;

  constructor() {
    this.loadPreferences();
  }

  /**
   * Initialize the secure store (must be called after Tauri is ready)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Check which providers have keys stored
      for (const provider of Object.keys(PROVIDERS) as AIProvider[]) {
        const hasKey = await invoke<boolean>('ai_has_api_key', { provider });
        this.hasApiKey = { ...this.hasApiKey, [provider]: hasKey };
      }
      
      this.initialized = true;
    } catch (err) {
      // Log without exposing sensitive data
      const msg = err instanceof Error ? err.message : 'Unknown error';
      // Redact any potential key data from error messages
      const safeMsg = msg.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
      console.error('Failed to initialize AI secure storage:', safeMsg);
    }
  }

  /**
   * Get the current provider config
   */
  get currentProvider(): ProviderConfig {
    return PROVIDERS[this.selectedProvider];
  }

  /**
   * Check if agent mode is available for current provider/model
   */
  get agentModeAvailable(): boolean {
    const provider = PROVIDERS[this.selectedProvider];
    return provider.capabilities.supportsTools;
  }

  /**
   * Set the selected provider
   */
  setProvider(provider: AIProvider): void {
    if (!PROVIDERS[provider]) return;
    this.selectedProvider = provider;
    this.savePreferences();
  }

  /**
   * Set the model for a specific mode
   */
  setModelForMode(mode: AIMode, model: string): void {
    const provider = PROVIDERS[this.selectedProvider];
    if (!provider.models.includes(model)) return;
    
    this.modelPerMode = { ...this.modelPerMode, [mode]: model };
    this.savePreferences();
  }

  /**
   * Save API key securely
   * NEVER logs the key value
   */
  async saveApiKey(provider: AIProvider, key: string): Promise<void> {
    await invoke('ai_set_api_key', { provider, apiKey: key });
    
    // Update status
    this.hasApiKey = { ...this.hasApiKey, [provider]: !!key };
  }

  /**
   * Get API key for a provider
   * NEVER logs the returned value
   */
  async getApiKey(provider: AIProvider): Promise<string | null> {
    return await invoke<string | null>('ai_get_api_key', { provider });
  }

  /**
   * Remove API key for a provider
   */
  async removeApiKey(provider: AIProvider): Promise<void> {
    await invoke('ai_remove_api_key', { provider });
    
    this.hasApiKey = { ...this.hasApiKey, [provider]: false };
  }

  /**
   * Validate API key by making a minimal test request
   */
  async validateApiKey(provider: AIProvider): Promise<ValidationResult> {
    this.isValidating = true;
    this.validationError = null;
    
    try {
      const key = await this.getApiKey(provider);
      if (!key) {
        this.validationError = 'No API key configured';
        return { success: false, error: 'No API key configured' };
      }
      
      // Import the provider service dynamically to avoid circular deps
      const { validateGeminiKey } = await import('$lib/services/ai/gemini');
      
      const result = await validateGeminiKey(key);
      
      if (!result.success) {
        this.validationError = result.error ?? 'Validation failed';
      }
      
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      // Redact potential sensitive data
      const safeMsg = msg.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
      this.validationError = safeMsg;
      return { success: false, error: safeMsg };
    } finally {
      this.isValidating = false;
    }
  }

  /**
   * Load preferences from localStorage
   */
  private loadPreferences(): void {
    if (typeof window === 'undefined') return;
    
    try {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      if (!raw) return;
      
      const prefs = JSON.parse(raw) as Partial<AIPreferences>;
      
      if (prefs.selectedProvider && PROVIDERS[prefs.selectedProvider]) {
        this.selectedProvider = prefs.selectedProvider;
      }
      
      if (prefs.modelPerMode) {
        // Migrate legacy 'spec' -> 'plan' if present in stored prefs.
        const stored = prefs.modelPerMode as unknown as Record<string, string>;

        const askModel = stored.ask;
        const planModel = stored.plan ?? stored.spec;
        const agentModel = stored.agent;

        if (askModel) this.modelPerMode = { ...this.modelPerMode, ask: askModel };
        if (planModel) this.modelPerMode = { ...this.modelPerMode, plan: planModel };
        if (agentModel) this.modelPerMode = { ...this.modelPerMode, agent: agentModel };
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Save preferences to localStorage
   */
  private savePreferences(): void {
    if (typeof window === 'undefined') return;
    
    try {
      const prefs: AIPreferences = {
        selectedProvider: this.selectedProvider,
        modelPerMode: this.modelPerMode
      };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage errors
    }
  }
}

// Singleton instance
export const aiSettingsStore = new AISettingsStore();
