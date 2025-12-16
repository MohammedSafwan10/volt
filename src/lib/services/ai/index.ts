/**
 * AI Service
 * Unified interface for AI providers with streaming and cancellation support
 */

export * from './types';
export { geminiProvider, validateGeminiKey } from './gemini';

import type { AIProvider, ChatRequest, ChatResponse, StreamChunk } from './types';
import { geminiProvider } from './gemini';
import { aiSettingsStore, type AIProvider as AIProviderType, type AIMode } from '$lib/stores/ai.svelte';

// Provider registry
const providers: Record<AIProviderType, AIProvider> = {
  gemini: geminiProvider
};

/**
 * Get the current provider instance
 */
export function getCurrentProvider(): AIProvider {
  return providers[aiSettingsStore.selectedProvider];
}

/**
 * Get a specific provider instance
 */
export function getProvider(id: AIProviderType): AIProvider {
  return providers[id];
}

/**
 * Send a chat request using the current provider
 * Automatically retrieves the API key from secure storage
 */
export async function sendChat(
  request: Omit<ChatRequest, 'model'>,
  mode: AIMode = 'ask',
  signal?: AbortSignal
): Promise<ChatResponse> {
  const provider = getCurrentProvider();
  const model = aiSettingsStore.modelPerMode[mode];
  const apiKey = await aiSettingsStore.getApiKey(aiSettingsStore.selectedProvider);
  
  if (!apiKey) {
    throw new Error('No API key configured. Please add your API key in Settings → AI.');
  }
  
  return provider.sendChat({ ...request, model }, apiKey, signal);
}

/**
 * Stream a chat request using the current provider
 * Automatically retrieves the API key from secure storage
 */
export async function* streamChat(
  request: Omit<ChatRequest, 'model'>,
  mode: AIMode = 'ask',
  signal?: AbortSignal
): AsyncGenerator<StreamChunk> {
  const provider = getCurrentProvider();
  const model = aiSettingsStore.modelPerMode[mode];
  const apiKey = await aiSettingsStore.getApiKey(aiSettingsStore.selectedProvider);
  
  if (!apiKey) {
    yield { type: 'error', error: 'No API key configured. Please add your API key in Settings → AI.' };
    return;
  }
  
  yield* provider.streamChat({ ...request, model }, apiKey, signal);
}

/**
 * Check if the current provider supports a capability
 */
export function supportsCapability(capability: 'streaming' | 'tools' | 'jsonSchema'): boolean {
  const provider = getCurrentProvider();
  switch (capability) {
    case 'streaming':
      return provider.capabilities.supportsStreaming;
    case 'tools':
      return provider.capabilities.supportsTools;
    case 'jsonSchema':
      return provider.capabilities.supportsJsonSchema;
    default:
      return false;
  }
}

/**
 * Check if agent mode is available with current configuration
 */
export function isAgentModeAvailable(): boolean {
  const provider = getCurrentProvider();
  return provider.capabilities.supportsTools;
}
