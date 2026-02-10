/**
 * AI Service
 * Unified interface for AI providers with streaming and cancellation support
 */

export * from './types';
export { geminiProvider, validateGeminiKey } from './gemini';
export { openRouterProvider, validateOpenRouterKey } from './openrouter';

import type { AIProvider, ChatRequest, ChatResponse, StreamChunk } from './types';
import { geminiProvider } from './gemini';
import { openRouterProvider } from './openrouter';
import { aiSettingsStore, type AIProvider as AIProviderType, type AIMode } from '$lib/stores/ai.svelte';

// Provider registry
const providers: Record<AIProviderType, AIProvider> = {
  gemini: geminiProvider,
  openrouter: openRouterProvider
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
 * Includes retry logic for transient network failures (like Kiro)
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
  
  // Retry configuration (like Kiro)
  const MAX_RETRIES = 3;
  const INITIAL_DELAY_MS = 1000;
  
  let lastError: string | null = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let hasYieldedContent = false;
      let sawDone = false;
      
      for await (const chunk of provider.streamChat({ ...request, model }, apiKey, signal)) {
        // If we get any content, reset retry state
        if (chunk.type === 'content' || chunk.type === 'tool_call' || chunk.type === 'thinking') {
          hasYieldedContent = true;
        }
        
        // Check for retryable errors
        if (chunk.type === 'error') {
          const errorMsg = chunk.error || 'Unknown error';
          const isRetryable = isRetryableError(errorMsg);
          
          // Only retry if we haven't yielded any content yet
          if (isRetryable && !hasYieldedContent && attempt < MAX_RETRIES) {
            lastError = errorMsg;
            const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
            console.warn(`[AI] Retryable error on attempt ${attempt}, retrying in ${delay}ms:`, errorMsg);
            await sleep(delay);
            break; // Break inner loop to retry
          }
          
          // Non-retryable or exhausted retries
          yield chunk;
          return;
        }
        
        yield chunk;
        
        // If we got 'done', we're finished successfully
        if (chunk.type === 'done') {
          sawDone = true;
          return;
        }
      }
      
      // Normal successful completion should always include explicit done.
      if (sawDone) {
        return;
      }

      // Stream ended unexpectedly without done/error.
      // Retry if possible; otherwise surface a clear error.
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
        const reason = hasYieldedContent
          ? 'Stream interrupted before completion.'
          : 'No stream data received.';
        lastError = reason;
        console.warn(`[AI] Stream ended early on attempt ${attempt}, retrying in ${delay}ms:`, reason);
        await sleep(delay);
        continue;
      }
      yield {
        type: 'error',
        error:
          lastError ||
          (hasYieldedContent
            ? 'Streaming interrupted before completion.'
            : 'No streaming response received.'),
      };
      return;
      
    } catch (err) {
      // Handle unexpected errors
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      if (signal?.aborted) {
        return; // User cancelled, don't retry
      }
      
      if (isRetryableError(errorMsg) && attempt < MAX_RETRIES) {
        lastError = errorMsg;
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[AI] Exception on attempt ${attempt}, retrying in ${delay}ms:`, errorMsg);
        await sleep(delay);
        continue;
      }
      
      yield { type: 'error', error: errorMsg };
      return;
    }
  }
  
  // Exhausted all retries
  yield { type: 'error', error: lastError || 'Failed after multiple retries' };
}

/**
 * Check if an error is retryable (transient network issues)
 */
function isRetryableError(error: string): boolean {
  const retryablePatterns = [
    /network/i,
    /timeout/i,
    /connection/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /socket hang up/i,
    /interrupted/i,
    /503/i, // Service unavailable
    /502/i, // Bad gateway
    /504/i, // Gateway timeout
    /rate limit/i,
    /too many requests/i,
    /429/i,
  ];
  
  return retryablePatterns.some(pattern => pattern.test(error));
}

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
