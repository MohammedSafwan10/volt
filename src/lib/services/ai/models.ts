/**
 * AI Model Registry
 * Centralized configuration for all supported AI models
 */

export interface ModelConfig {
  id: string;              // Full model ID (e.g., 'moonshotai/kimi-k2:free')
  name: string;            // Display name
  provider: 'gemini' | 'openrouter';
  contextWindow: number;   // Total context window in tokens
  maxOutput: number;       // Max output tokens
  supportsTools: boolean;  // Function calling support
  free: boolean;           // Is it free tier
}

/**
 * All supported models with their configurations
 */
export const MODEL_REGISTRY: Record<string, ModelConfig> = {
  // ============ Gemini Models ============
  'gemini-3-pro-preview|thinking': {
    id: 'gemini-3-pro-preview|thinking',
    name: 'Gemini 3 Pro (thinking)',
    provider: 'gemini',
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    free: false
  },
  'gemini-3-pro-preview': {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro',
    provider: 'gemini',
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    free: false
  },
  'gemini-3-flash-preview|thinking': {
    id: 'gemini-3-flash-preview|thinking',
    name: 'Gemini 3 Flash (thinking)',
    provider: 'gemini',
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    free: false
  },
  'gemini-3-flash-preview': {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash',
    provider: 'gemini',
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    free: false
  },
  'gemini-2.5-flash|thinking': {
    id: 'gemini-2.5-flash|thinking',
    name: 'Gemini 2.5 Flash (thinking)',
    provider: 'gemini',
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    free: false
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'gemini',
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    free: false
  },

  // ============ OpenRouter Free Models ============
  'mistralai/devstral-2512:free': {
    id: 'mistralai/devstral-2512:free',
    name: 'Devstral',
    provider: 'openrouter',
    contextWindow: 262000,
    maxOutput: 262000,
    supportsTools: true,
    free: true
  },
  'qwen/qwen3-coder:free': {
    id: 'qwen/qwen3-coder:free',
    name: 'Qwen3 Coder',
    provider: 'openrouter',
    contextWindow: 262000,
    maxOutput: 262000,
    supportsTools: true,
    free: true
  },
  'z-ai/glm-4.5-air:free': {
    id: 'z-ai/glm-4.5-air:free',
    name: 'GLM 4.5 Air',
    provider: 'openrouter',
    contextWindow: 131000,
    maxOutput: 96000,
    supportsTools: true,
    free: true
  },
  'stepfun/step-3.5-flash:free': {
    id: 'stepfun/step-3.5-flash:free',
    name: 'Step 3.5 Flash',
    provider: 'openrouter',
    contextWindow: 256000,
    maxOutput: 256000,
    supportsTools: true,
    free: true
  }
};

/**
 * Get model config by ID
 */
export function getModelConfig(modelId: string): ModelConfig | undefined {
  return MODEL_REGISTRY[modelId];
}

/**
 * Get safe max output tokens for a model given current input size
 * Leaves buffer for safety
 */
export function getSafeMaxOutput(modelId: string, inputTokens: number = 0): number {
  const config = MODEL_REGISTRY[modelId];
  if (!config) return 8192; // Safe default

  const buffer = 1000; // Safety buffer
  const available = config.contextWindow - inputTokens - buffer;

  // Return minimum of model's max output and available space
  return Math.max(1024, Math.min(config.maxOutput, available));
}

/**
 * Format token count for display (e.g., "131K", "1M")
 */
export function formatContextSize(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return tokens.toString();
}

/**
 * Get all models for a provider
 */
export function getModelsForProvider(provider: 'gemini' | 'openrouter'): ModelConfig[] {
  return Object.values(MODEL_REGISTRY).filter(m => m.provider === provider);
}
