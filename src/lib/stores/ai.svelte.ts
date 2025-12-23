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
      maxContextHint: 1000000
    },
    models: [
      'gemini-2.5-flash|thinking',
      'gemini-2.5-flash'
    ],
    defaultModel: 'gemini-2.5-flash|thinking'
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

class AISettingsStore {
  selectedProvider = $state<AIProvider>('gemini');
  
  modelPerMode = $state<Record<AIMode, string>>({
    ask: 'gemini-2.5-flash|thinking',
    plan: 'gemini-2.5-flash|thinking',
    agent: 'gemini-2.5-flash|thinking'
  });
  
  hasApiKey = $state<Record<AIProvider, boolean>>({
    gemini: false
  });
  
  isValidating = $state(false);
  validationError = $state<string | null>(null);

  private initialized = false;

  constructor() {
    this.loadPreferences();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      for (const provider of Object.keys(PROVIDERS) as AIProvider[]) {
        const hasKey = await invoke<boolean>('ai_has_api_key', { provider });
        this.hasApiKey = { ...this.hasApiKey, [provider]: hasKey };
      }
      this.initialized = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      const safeMsg = msg.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
      console.error('Failed to initialize AI secure storage:', safeMsg);
    }
  }

  get currentProvider(): ProviderConfig {
    return PROVIDERS[this.selectedProvider];
  }

  get agentModeAvailable(): boolean {
    const provider = PROVIDERS[this.selectedProvider];
    return provider.capabilities.supportsTools;
  }

  setProvider(provider: AIProvider): void {
    if (!PROVIDERS[provider]) return;
    this.selectedProvider = provider;
    this.savePreferences();
  }

  setModelForMode(mode: AIMode, model: string): void {
    const provider = PROVIDERS[this.selectedProvider];
    if (!provider.models.includes(model)) return;
    this.modelPerMode = { ...this.modelPerMode, [mode]: model };
    this.savePreferences();
  }

  async saveApiKey(provider: AIProvider, key: string): Promise<void> {
    await invoke('ai_set_api_key', { provider, apiKey: key });
    this.hasApiKey = { ...this.hasApiKey, [provider]: !!key };
  }

  async getApiKey(provider: AIProvider): Promise<string | null> {
    return await invoke<string | null>('ai_get_api_key', { provider });
  }

  async removeApiKey(provider: AIProvider): Promise<void> {
    await invoke('ai_remove_api_key', { provider });
    this.hasApiKey = { ...this.hasApiKey, [provider]: false };
  }

  async validateApiKey(provider: AIProvider): Promise<ValidationResult> {
    this.isValidating = true;
    this.validationError = null;
    
    try {
      const key = await this.getApiKey(provider);
      if (!key) {
        this.validationError = 'No API key configured';
        return { success: false, error: 'No API key configured' };
      }
      
      const { validateGeminiKey } = await import('$lib/services/ai/gemini');
      const result = await validateGeminiKey(key);
      
      if (!result.success) {
        this.validationError = result.error ?? 'Validation failed';
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      const safeMsg = msg.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
      this.validationError = safeMsg;
      return { success: false, error: safeMsg };
    } finally {
      this.isValidating = false;
    }
  }

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
        const stored = prefs.modelPerMode as unknown as Record<string, string>;
        const askModel = stored.ask;
        const planModel = stored.plan ?? stored.spec;
        const agentModel = stored.agent;

        const normalizeModel = (model: string | undefined): string | undefined => {
          if (!model) return undefined;
          if (model.includes('gemini-3')) return 'gemini-2.5-flash|thinking';
          if (model === 'gemini-2.5-flash') return 'gemini-2.5-flash|thinking';
          return model;
        };

        const ask = normalizeModel(askModel);
        const plan = normalizeModel(planModel);
        const agent = normalizeModel(agentModel);

        if (ask) this.modelPerMode = { ...this.modelPerMode, ask };
        if (plan) this.modelPerMode = { ...this.modelPerMode, plan };
        if (agent) this.modelPerMode = { ...this.modelPerMode, agent };
      }
    } catch {
      // Ignore parse errors
    }
  }

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

export const aiSettingsStore = new AISettingsStore();
