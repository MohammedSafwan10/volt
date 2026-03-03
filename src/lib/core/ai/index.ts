/**
 * AI Service
 * Unified interface for AI providers with streaming and cancellation support
 */

export * from '$core/ai/types';
export { geminiProvider, validateGeminiKey } from '$core/ai/providers/gemini';
export { openRouterProvider, validateOpenRouterKey } from '$core/ai/providers/openrouter';
export { anthropicProvider, validateAnthropicKey } from '$core/ai/providers/anthropic';
export { openaiProvider, validateOpenAIKey } from '$core/ai/providers/openai';
export { mistralProvider, validateMistralKey } from '$core/ai/providers/mistral';

import type { AIProvider, ChatRequest, ChatResponse, StreamChunk } from '$core/ai/types';
import { geminiProvider } from '$core/ai/providers/gemini';
import { openRouterProvider } from '$core/ai/providers/openrouter';
import { anthropicProvider } from '$core/ai/providers/anthropic';
import { openaiProvider } from '$core/ai/providers/openai';
import { mistralProvider } from '$core/ai/providers/mistral';
import { aiSettingsStore, type AIProvider as AIProviderType, type AIMode } from '$features/assistant/stores/ai.svelte';

// Provider registry
const providers: Record<AIProviderType, AIProvider> = {
  gemini: geminiProvider,
  openrouter: openRouterProvider,
  anthropic: anthropicProvider,
  openai: openaiProvider,
  mistral: mistralProvider
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
  const STREAM_IDLE_TIMEOUT_MS = 45_000;

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let hasYieldedContent = false;
    let retryScheduledFromError = false;
    try {
      let sawDone = false;
      const streamIterator = provider
        .streamChat({ ...request, model }, apiKey, signal)[Symbol.asyncIterator]();

      while (true) {
        const next = await nextWithIdleTimeout(
          streamIterator,
          STREAM_IDLE_TIMEOUT_MS,
          signal,
        );
        if (next.done) break;
        const chunk = next.value;
        // If we get any content, reset retry state
        if (chunk.type === 'content' || chunk.type === 'tool_call' || chunk.type === 'thinking') {
          hasYieldedContent = true;
        }

        // Check for retryable errors
        if (chunk.type === 'error') {
          const errorMsg = chunk.error || 'Unknown error';
          if (isQuotaExhaustedError(errorMsg)) {
            yield {
              type: 'error',
              error:
                'Model quota exceeded (429 RESOURCE_EXHAUSTED). Please wait for quota reset or switch model/provider.',
            };
            return;
          }
          const isRetryable = isRetryableError(errorMsg);

          // Only retry if we haven't yielded any content yet
          if (isRetryable && !hasYieldedContent && attempt < MAX_RETRIES) {
            lastError = errorMsg;
            const delay = getRetryDelayMs(errorMsg, INITIAL_DELAY_MS * Math.pow(2, attempt - 1));
            console.warn(`[AI] Retryable error on attempt ${attempt}, retrying in ${delay}ms:`, errorMsg);
            await sleep(delay, signal);
            retryScheduledFromError = true;
            break; // Break inner loop and continue outer retry loop
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

      // Normal successful completion should include explicit done.
      if (sawDone) {
        return;
      }

      // We already scheduled a retry due to an explicit error chunk.
      // Avoid logging/triggering a second retry path as "No stream data received".
      if (retryScheduledFromError) {
        continue;
      }

      // If we already received partial content, avoid retrying the whole request.
      // Retrying after partial output duplicates content in the UI/tool loop.
      if (hasYieldedContent) {
        console.warn('[AI] Stream ended without explicit done after partial output; treating as completed.');
        yield { type: 'done' };
        return;
      }

      // No data and no done/error: retry as transient upstream issue.
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
        const reason = 'No stream data received.';
        lastError = reason;
        console.warn(`[AI] Stream ended early on attempt ${attempt}, retrying in ${delay}ms:`, reason);
        await sleep(delay, signal);
        continue;
      }
      yield {
        type: 'error',
        error:
          lastError ||
          'No streaming response received.',
      };
      return;

    } catch (err) {
      // Handle unexpected errors
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (signal?.aborted) {
        return; // User cancelled, don't retry
      }

      if (isQuotaExhaustedError(errorMsg)) {
        yield {
          type: 'error',
          error:
            'Model quota exceeded (429 RESOURCE_EXHAUSTED). Please wait for quota reset or switch model/provider.',
        };
        return;
      }

      if (isRetryableError(errorMsg) && !hasYieldedContent && attempt < MAX_RETRIES) {
        lastError = errorMsg;
        const delay = getRetryDelayMs(errorMsg, INITIAL_DELAY_MS * Math.pow(2, attempt - 1));
        console.warn(`[AI] Exception on attempt ${attempt}, retrying in ${delay}ms:`, errorMsg);
        await sleep(delay, signal);
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

function isQuotaExhaustedError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('quota exceeded') ||
    (lower.includes('status 429') && lower.includes('generativelanguage.googleapis.com'))
  );
}

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('Stream cancelled'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Stream cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function getRetryDelayMs(error: string, fallbackMs: number): number {
  // Gemini frequently returns "Please retry in 30.404132517s." or retryDelay fields.
  const secondsMatch = error.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (secondsMatch?.[1]) {
    const parsed = Number(secondsMatch[1]);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.max(250, Math.round(parsed * 1000));
    }
  }

  const millisMatch = error.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)ms/i);
  if (millisMatch?.[1]) {
    const parsed = Number(millisMatch[1]);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.max(250, Math.round(parsed));
    }
  }

  return fallbackMs;
}

async function nextWithIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal?.aborted) {
    throw new Error('Stream cancelled');
  }

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            done(() =>
              reject(
                new Error(`Stream idle timeout after ${Math.round(timeoutMs / 1000)}s`),
              ),
            );
          }, timeoutMs)
        : null;

    const onAbort = () => {
      done(() => reject(new Error('Stream cancelled')));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    iterator
      .next()
      .then((value) => done(() => resolve(value)))
      .catch((err) => done(() => reject(err)));
  });
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
