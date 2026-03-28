import type { AIMode } from '../ai.svelte';
import { getModelConfig, MODEL_REGISTRY, type ModelConfig } from '$core/ai/models';

export const IMAGE_LIMITS = {
  maxImagesPerMessage: 5,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalImageBytesPerMessage: 15 * 1024 * 1024,
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
};

// Conservative fallback for unknown models.
// Using 1M here hides overflow risk for many non-Gemini models.
const DEFAULT_CONTEXT_LIMIT = { inputTokens: 128_000, outputTokens: 8_192 };

export function getModelContextLimits(modelId: string): { inputTokens: number; outputTokens: number } {
  const config = getModelConfig(modelId);
  if (config) {
    return {
      inputTokens: config.contextWindow,
      outputTokens: config.maxOutput,
    };
  }
  return DEFAULT_CONTEXT_LIMIT;
}

export const MODEL_CONTEXT_LIMITS: Record<string, { inputTokens: number; outputTokens: number }> =
  Object.fromEntries(
    Object.values(MODEL_REGISTRY).map((model: ModelConfig) => [
      model.id.replace(/\|thinking$/, ''),
      { inputTokens: model.contextWindow, outputTokens: model.maxOutput },
    ]),
  );

export const CONTEXT_LIMITS = {
  maxContextSize: 100_000,
  maxFilesPerMessage: 10,
};

export const MODE_CAPABILITIES: Record<
  AIMode,
  {
    canMutateFiles: boolean;
    canExecuteCommands: boolean;
    canUseTools: boolean;
    description: string;
  }
> = {
  ask: {
    canMutateFiles: false,
    canExecuteCommands: false,
    canUseTools: true,
    description: 'Read-only mode for questions and explanations',
  },
  plan: {
    canMutateFiles: false,
    canExecuteCommands: false,
    canUseTools: true,
    description: 'Planning mode - can analyze but not modify',
  },
  spec: {
    canMutateFiles: false,
    canExecuteCommands: false,
    canUseTools: true,
    description: 'Specification mode - creates structured requirements, design, and task plans',
  },
  agent: {
    canMutateFiles: true,
    canExecuteCommands: true,
    canUseTools: true,
    description: 'Full agent mode with file and command access',
  },
};
