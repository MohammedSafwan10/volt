/**
 * AI Provider Settings Store
 * Manages AI provider configuration with secure key storage via OS credential manager
 *
 * SECURITY: API keys are stored via Rust commands using the OS credential manager.
 * Non-secret preferences (provider, model selections) are stored in localStorage
 */

import { invoke } from '@tauri-apps/api/core';
import { getModelConfig, upsertModelConfig } from '$core/ai/models';

// Supported AI providers
export type AIProvider = 'gemini' | 'openrouter' | 'anthropic' | 'openai' | 'mistral';
export type OpenAIReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

// AI operation modes
export type AIMode = 'ask' | 'plan' | 'spec' | 'agent';

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

function isSupportedModel(provider: AIProvider, model: string): boolean {
  return PROVIDERS[provider].models.includes(model);
}

function sanitizeModeModel(provider: AIProvider, mode: AIMode, model: string | undefined): string {
  if (model && isSupportedModel(provider, model)) {
    return model;
  }
  return PROVIDERS[provider].defaultModel;
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
      'gemini-3.1-pro-preview|thinking',
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview|thinking',
      'gemini-3-flash-preview',
      'gemini-2.5-flash|thinking',
      'gemini-2.5-flash'
    ],
    defaultModel: 'gemini-3.1-pro-preview|thinking'
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
      'qwen/qwen3.6-plus-preview:free',    // Qwen 3.6 Plus Preview - 1M context
      'z-ai/glm-4.5-air:free',             // GLM 4.5 Air - fast & capable
      'stepfun/step-3.5-flash:free',       // StepFun 3.5 Flash - 256K context
      'nvidia/nemotron-3-super-120b-a12b:free' // Nemotron 3 Super - strong agentic/reasoning model
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
      'gpt-5.4|thinking',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.3-codex|thinking'
    ],
    defaultModel: 'gpt-5.4'
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsJsonSchema: true,
      maxContextHint: 128000
    },
    models: [
      'devstral-latest',
      'codestral-latest',
      'devstral-medium-latest'
    ],
    defaultModel: 'devstral-latest'
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
  openAIReasoningEffort?: Record<AIMode, OpenAIReasoningEffort>;
}

const PREFS_STORAGE_KEY = 'volt.ai.preferences';

class AISettingsStore {
  selectedProvider = $state<AIProvider>('gemini');

  // Selection per provider to keep choices remembered
  private selectedModels = $state<Record<AIProvider, Record<AIMode, string>>>({
    gemini: {
      ask: 'gemini-3.1-pro-preview|thinking',
      plan: 'gemini-3.1-pro-preview|thinking',
      spec: 'gemini-3.1-pro-preview|thinking',
      agent: 'gemini-3.1-pro-preview|thinking'
    },
    openrouter: {
      ask: 'qwen/qwen3-coder:free',
      plan: 'qwen/qwen3-coder:free',
      spec: 'qwen/qwen3-coder:free',
      agent: 'qwen/qwen3-coder:free'
    },
    anthropic: {
      ask: 'claude-sonnet-4-5-20250929',
      plan: 'claude-sonnet-4-5-20250929',
      spec: 'claude-sonnet-4-5-20250929',
      agent: 'claude-sonnet-4-5-20250929'
    },
    openai: {
      ask: 'gpt-5.4',
      plan: 'gpt-5.4',
      spec: 'gpt-5.4',
      agent: 'gpt-5.3-codex'
    },
    mistral: {
      ask: 'codestral-latest',
      plan: 'devstral-latest',
      spec: 'devstral-latest',
      agent: 'devstral-latest'
    }
  });
  private openAIReasoningEffort = $state<Record<AIMode, OpenAIReasoningEffort>>({
    ask: 'medium',
    plan: 'high',
    spec: 'high',
    agent: 'high'
  });

  // modelPerMode is now a getter reflecting the current provider's selection
  get modelPerMode(): Record<AIMode, string> {
    return this.selectedModels[this.selectedProvider];
  }

  get reasoningEffortPerMode(): Record<AIMode, OpenAIReasoningEffort> {
    return this.openAIReasoningEffort;
  }

  hasApiKey = $state<Record<AIProvider, boolean>>({
    gemini: false,
    openrouter: false,
    anthropic: false,
    openai: false,
    mistral: false
  });

  isValidating = $state(false);
  validationError = $state<string | null>(null);

  private initialized = false;
  private initializePromise: Promise<void> | null = null;

  constructor() {
    this.loadPreferences();
    if (typeof window !== 'undefined') {
      void this.initialize();
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
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

      try {
        await this.syncOpenRouterModelMetadata();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        const safeMsg = msg.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
        console.warn('Failed to sync OpenRouter model metadata:', safeMsg);
      }
    })();

    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
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

  setOpenAIReasoningEffort(mode: AIMode, effort: OpenAIReasoningEffort): void {
    this.openAIReasoningEffort = {
      ...this.openAIReasoningEffort,
      [mode]: effort
    };
    this.savePreferences();
  }

  async saveApiKey(provider: AIProvider, key: string): Promise<void> {
    const trimmedKey = key.trim();
    await invoke('ai_set_api_key', { provider, apiKey: trimmedKey });
    this.hasApiKey = { ...this.hasApiKey, [provider]: !!trimmedKey };
  }

  async removeApiKey(provider: AIProvider): Promise<void> {
    await invoke('ai_remove_api_key', { provider });
    this.hasApiKey = { ...this.hasApiKey, [provider]: false };
  }

  async validateApiKey(provider: AIProvider): Promise<ValidationResult> {
    this.isValidating = true;
    this.validationError = null;

    try {
      if (!this.hasApiKey[provider]) {
        this.validationError = 'No API key configured';
        return { success: false, error: 'No API key configured' };
      }

      const ok = await invoke<boolean>('ai_validate_api_key', { provider });
      const result: ValidationResult = ok
        ? { success: true }
        : { success: false, error: 'Validation failed' };

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
          const providerModes = sm[provider];
          if (providerModes) {
            this.selectedModels[provider] = {
              ask: sanitizeModeModel(provider, 'ask', providerModes.ask),
              plan: sanitizeModeModel(provider, 'plan', providerModes.plan),
              spec: sanitizeModeModel(provider, 'spec', providerModes.spec),
              agent: sanitizeModeModel(provider, 'agent', providerModes.agent)
            };
          }
        }
      } else if (prefs.modelPerMode) {
        // Backward compatibility: the legacy modelPerMode likely belonged to the then-selected provider
        const mpm = prefs.modelPerMode as Record<string, string>;
        const currentM = this.selectedModels[this.selectedProvider];

        this.selectedModels[this.selectedProvider] = {
          ask: sanitizeModeModel(this.selectedProvider, 'ask', mpm.ask || currentM.ask),
          plan: sanitizeModeModel(this.selectedProvider, 'plan', mpm.plan || currentM.plan),
          spec: sanitizeModeModel(this.selectedProvider, 'spec', mpm.spec || currentM.spec),
          agent: sanitizeModeModel(this.selectedProvider, 'agent', mpm.agent || currentM.agent)
        };
      }

      if (prefs.openAIReasoningEffort) {
        this.openAIReasoningEffort = {
          ask: prefs.openAIReasoningEffort.ask ?? 'medium',
          plan: prefs.openAIReasoningEffort.plan ?? 'high',
          spec: prefs.openAIReasoningEffort.spec ?? 'high',
          agent: prefs.openAIReasoningEffort.agent ?? 'high'
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
        selectedModels: $state.snapshot(this.selectedModels),
        openAIReasoningEffort: $state.snapshot(this.openAIReasoningEffort)
      };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Refresh OpenRouter model limits from live API metadata.
   * Keeps context meter and max token budgeting aligned with current upstream routing.
   */
  private async syncOpenRouterModelMetadata(): Promise<void> {
    const openRouterModels = PROVIDERS.openrouter.models;
    if (openRouterModels.length === 0) return;

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET'
      });
      if (!response.ok) return;

      const payload = await response.json() as {
        data?: Array<{
          id: string;
          context_length?: number;
          supported_parameters?: string[];
          top_provider?: { max_completion_tokens?: number | null };
          name?: string;
        }>;
      };
      if (!Array.isArray(payload.data)) return;

      const index = new Map(payload.data.map((m) => [m.id, m]));

      for (const modelId of openRouterModels) {
        const live = index.get(modelId);
        if (!live || typeof live.context_length !== 'number') continue;

        const existing = getModelConfig(modelId);
        const maxOut = typeof live.top_provider?.max_completion_tokens === 'number'
          ? live.top_provider.max_completion_tokens
          : (existing?.maxOutput ?? 8192);

        const updated = {
          id: modelId,
          name: existing?.name ?? live.name ?? modelId,
          provider: 'openrouter' as const,
          contextWindow: live.context_length,
          maxOutput: maxOut,
          supportsTools: Boolean(live.supported_parameters?.includes('tools')),
          free: modelId.endsWith(':free')
        };

        upsertModelConfig(updated);
      }
    } catch {
      // Best-effort metadata refresh: keep static defaults when offline/unavailable.
    }
  }
}

export const aiSettingsStore = new AISettingsStore();
