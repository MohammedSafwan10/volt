/**
 * AI Provider Settings Store
 * Manages AI provider configuration with secure key storage via OS credential manager
 *
 * SECURITY: API keys are stored via Rust commands using the OS credential manager.
 * Non-secret preferences (provider, model selections) are stored in localStorage
 */

import { invoke } from '@tauri-apps/api/core';
import { validateGeminiKey } from '$lib/services/ai/gemini';
import { validateOpenRouterKey } from '$lib/services/ai/openrouter';
import { validateAnthropicKey } from '$lib/services/ai/anthropic';

// Supported AI providers
export type AIProvider = 'gemini' | 'openrouter' | 'anthropic' | 'openai';

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
      'gemini-3-pro-preview|thinking',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview|thinking',
      'gemini-3-flash-preview',
      'gemini-2.5-flash|thinking',
      'gemini-2.5-flash'
    ],
    defaultModel: 'gemini-3-pro-preview|thinking'
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsJsonSchema: true,
      maxContextHint: 256000
    },
    models: [
      // Best free models with function calling support
      'qwen/qwen3-coder:free',             // Qwen3 Coder - great for code
      'z-ai/glm-4.5-air:free',             // GLM 4.5 Air - fast & capable
      'mistralai/devstral-2512:free',      // Devstral - coding focused
      'stepfun/step-3.5-flash:free'        // StepFun 3.5 Flash - 256K context
    ],
    defaultModel: 'qwen/qwen3-coder:free'
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsJsonSchema: true,
      maxContextHint: 1000000
    },
    models: [
      'claude-opus-4-6|thinking',
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929|thinking',
      'claude-sonnet-4-5-20250929',
      'claude-3-5-sonnet-latest',
      'claude-3-5-opus-latest'
    ],
    defaultModel: 'claude-sonnet-4-5-20250929'
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsJsonSchema: true,
      maxContextHint: 1000000
    },
    models: [
      'gpt-5.2 pro|thinking',
      'gpt-5.2 pro',
      'gpt-5.2|thinking',
      'gpt-5.2',
      'gpt-5.1|thinking',
      'gpt-5.1-chat-latest',
      'gpt-5.3-codex',
      'gpt-5-mini',
      'gpt-5-nano'
    ],
    defaultModel: 'gpt-5.2'
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
  selectedModels: Record<AIProvider, Record<AIMode, string>>;
}

const PREFS_STORAGE_KEY = 'volt.ai.preferences';

class AISettingsStore {
  selectedProvider = $state<AIProvider>('gemini');

  // Selection per provider to keep choices remembered
  private selectedModels = $state<Record<AIProvider, Record<AIMode, string>>>({
    gemini: {
      ask: 'gemini-3-pro-preview|thinking',
      plan: 'gemini-3-pro-preview|thinking',
      agent: 'gemini-3-pro-preview|thinking'
    },
    openrouter: {
      ask: 'qwen/qwen3-coder:free',
      plan: 'qwen/qwen3-coder:free',
      agent: 'qwen/qwen3-coder:free'
    },
    anthropic: {
      ask: 'claude-sonnet-4-5-20250929',
      plan: 'claude-sonnet-4-5-20250929',
      agent: 'claude-sonnet-4-5-20250929'
    },
    openai: {
      ask: 'gpt-5.2',
      plan: 'gpt-5.2',
      agent: 'gpt-5.2'
    }
  });

  // modelPerMode is now a getter reflecting the current provider's selection
  get modelPerMode(): Record<AIMode, string> {
    return this.selectedModels[this.selectedProvider];
  }

  hasApiKey = $state<Record<AIProvider, boolean>>({
    gemini: false,
    openrouter: false,
    anthropic: false,
    openai: false
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

    // Update the specific selection for this provider
    this.selectedModels[this.selectedProvider] = {
      ...this.selectedModels[this.selectedProvider],
      [mode]: model
    };

    this.savePreferences();
  }

  async saveApiKey(provider: AIProvider, key: string): Promise<void> {
    const trimmedKey = key.trim();
    await invoke('ai_set_api_key', { provider, apiKey: trimmedKey });
    this.hasApiKey = { ...this.hasApiKey, [provider]: !!trimmedKey };
  }

  async getApiKey(provider: AIProvider): Promise<string | null> {
    const key = await invoke<string | null>('ai_get_api_key', { provider });
    return key?.trim() ?? null;
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

      let result: ValidationResult;

      if (provider === 'gemini') {
        result = await validateGeminiKey(key);
      } else if (provider === 'openrouter') {
        result = await validateOpenRouterKey(key);
      } else if (provider === 'anthropic') {
        result = await validateAnthropicKey(key);
      } else {
        result = { success: false, error: 'Unknown provider' };
      }

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

      const prefs = JSON.parse(raw);
      if (!prefs) return;

      if (prefs.selectedProvider && PROVIDERS[prefs.selectedProvider as AIProvider]) {
        this.selectedProvider = prefs.selectedProvider as AIProvider;
      }

      // Handle old format (modelPerMode) and new format (selectedModels)
      if (prefs.selectedModels) {
        // New format: restore selection for each provider
        const sm = prefs.selectedModels as Record<AIProvider, Record<AIMode, string>>;
        for (const provider of Object.keys(PROVIDERS) as AIProvider[]) {
          if (sm[provider]) {
            this.selectedModels[provider] = {
              ...this.selectedModels[provider],
              ...sm[provider]
            };
          }
        }
      } else if (prefs.modelPerMode) {
        // Backward compatibility: the legacy modelPerMode likely belonged to the then-selected provider
        const mpm = prefs.modelPerMode as Record<string, string>;
        const currentM = this.selectedModels[this.selectedProvider];

        this.selectedModels[this.selectedProvider] = {
          ask: mpm.ask || currentM.ask,
          plan: mpm.plan || currentM.plan,
          agent: mpm.agent || currentM.agent
        };
      }
    } catch (err) {
      console.warn('Failed to load AI preferences:', err);
    }
  }

  private savePreferences(): void {
    if (typeof window === 'undefined') return;

    try {
      const prefs: AIPreferences = {
        selectedProvider: this.selectedProvider,
        selectedModels: $state.snapshot(this.selectedModels)
      };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage errors
    }
  }
}

export const aiSettingsStore = new AISettingsStore();
