/**
 * OpenRouter AI Provider
 * 
 * OpenRouter provides access to multiple AI models through a single API.
 * API is OpenAI-compatible with some extensions.
 * 
 * Docs: https://openrouter.ai/docs/api-reference/overview
 * Free models: Qwen3, GLM, StepFun, etc.
 */

import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ChatMessage,
  ToolDefinition,
  ToolCall,
  ProviderCapabilities
} from '$core/ai/types';
import { getModelConfig } from '$core/ai/models';
import { invoke, Channel } from '@tauri-apps/api/core';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

// OpenRouter request types (OpenAI-compatible)
interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenRouterContentPart[];
  name?: string;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
}

interface OpenRouterContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  tools?: OpenRouterTool[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

interface OpenRouterChoice {
  index: number;
  message?: {
    role: string;
    content: string | null;
    tool_calls?: OpenRouterToolCall[];
  };
  delta?: {
    role?: string;
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason: string | null;
}

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: OpenRouterChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    code: number | string;
    message: string;
  };
}

/**
 * Convert our message format to OpenRouter format
 */
function toOpenRouterMessages(messages: ChatMessage[], systemPrompt?: string): OpenRouterMessage[] {
  const result: OpenRouterMessage[] = [];

  // Add system prompt first if provided
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const m of messages) {
    if (m.role === 'system') {
      result.push({ role: 'system', content: m.content || '' });
      continue;
    }

    // Handle multimodal parts
    if (m.parts && m.parts.length > 0) {
      const contentParts: OpenRouterContentPart[] = [];
      const toolCalls: OpenRouterToolCall[] = [];

      for (const part of m.parts) {
        if (part.type === 'text') {
          contentParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          contentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${part.mimeType};base64,${part.data}`,
              detail: 'auto'
            }
          });
        } else if (part.type === 'function_call') {
          // Assistant's tool calls
          toolCalls.push({
            id: part.id || `call_${Date.now()}`,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.arguments)
            }
          });
        } else if (part.type === 'function_response') {
          // Tool response - add as separate message
          result.push({
            role: 'tool',
            content: JSON.stringify(part.response),
            tool_call_id: part.id || ''
          });
          continue;
        }
      }

      if (m.role === 'assistant' && toolCalls.length > 0) {
        // Assistant message with tool calls
        result.push({
          role: 'assistant',
          content: contentParts.length > 0 ? contentParts : '',
          tool_calls: toolCalls
        } as any);
      } else if (contentParts.length > 0) {
        result.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: contentParts.length === 1 && contentParts[0].type === 'text'
            ? contentParts[0].text!
            : contentParts
        });
      }
    } else if (m.content && m.content.trim()) {
      result.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      });
    }
  }

  return result;
}

/**
 * Convert tool definitions to OpenRouter format
 */
function toOpenRouterTools(tools: ToolDefinition[]): OpenRouterTool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

/**
 * Extract tool calls from OpenRouter response
 */
function extractToolCalls(choice: OpenRouterChoice): ToolCall[] {
  const calls: ToolCall[] = [];
  const toolCalls = choice.message?.tool_calls || [];

  for (const tc of toolCalls) {
    try {
      calls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments)
      });
    } catch {
      // Skip malformed tool calls
      console.warn('[OpenRouter] Failed to parse tool call arguments:', tc.function.arguments);
    }
  }

  return calls;
}

/**
 * Map OpenRouter error to user-friendly message
 */
function mapOpenRouterError(error: OpenRouterResponse['error']): string {
  if (!error) return 'Unknown error';

  const code = error.code;
  const message = error.message;

  if (code === 401 || message.includes('Unauthorized')) {
    return 'Invalid API key. Please check your OpenRouter API key.';
  }
  if (code === 402 || message.includes('insufficient')) {
    return 'Insufficient credits. Please add credits to your OpenRouter account.';
  }
  if (code === 429 || message.includes('rate')) {
    return 'Rate limit exceeded. Please wait a moment and try again.';
  }
  if (code === 503 || message.includes('unavailable')) {
    return 'Model is temporarily unavailable. Please try again later.';
  }

  // Redact potential sensitive data
  const safeMessage = message.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  return `OpenRouter error: ${safeMessage}`;
}

/**
 * Validate an OpenRouter API key
 */
export async function validateOpenRouterKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Use the models endpoint to validate - lightweight check
    const response = await fetch(`${OPENROUTER_API_BASE}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://volt.dev',
        'X-Title': 'Volt IDE'
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: 'Invalid API key' };
      }
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch')) {
      return { success: false, error: 'Network error. Please check your internet connection.' };
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: msg };
  }
}

/**
 * OpenRouter AI Provider implementation
 */
export const openRouterProvider: AIProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  capabilities: {
    supportsStreaming: true,
    supportsTools: true,
    supportsJsonSchema: true,
    maxContextHint: 128000 // Varies by model, use conservative default
  } as ProviderCapabilities,

  async sendChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): Promise<ChatResponse> {
    const url = `${OPENROUTER_API_BASE}/chat/completions`;

    // Get model-specific max output, fallback to 8192
    const modelConfig = getModelConfig(request.model);
    const safeMaxTokens = request.maxTokens ?? Math.min(modelConfig?.maxOutput ?? 8192, 8192);

    const openRouterRequest: OpenRouterRequest = {
      model: request.model,
      messages: toOpenRouterMessages(request.messages, request.systemPrompt),
      max_tokens: safeMaxTokens,
      temperature: request.temperature
    };

    if (request.tools && request.tools.length > 0) {
      openRouterRequest.tools = toOpenRouterTools(request.tools);
      openRouterRequest.tool_choice = 'auto';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://volt.dev',
        'X-Title': 'Volt IDE'
      },
      body: JSON.stringify(openRouterRequest),
      signal
    });

    const data = await response.json() as OpenRouterResponse;

    if (!response.ok || data.error) {
      throw new Error(mapOpenRouterError(data.error));
    }

    if (!data.choices || data.choices.length === 0) {
      throw new Error('No response from OpenRouter');
    }

    const choice = data.choices[0];
    const toolCalls = extractToolCalls(choice);
    const content = choice.message?.content || '';

    let finishReason: ChatResponse['finishReason'] = 'stop';
    if (toolCalls.length > 0) {
      finishReason = 'tool_calls';
    } else if (choice.finish_reason === 'length') {
      finishReason = 'length';
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  },

  async *streamChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const url = `${OPENROUTER_API_BASE}/chat/completions`;

    // Get model-specific limits - use conservative max for streaming
    const modelConfig = getModelConfig(request.model);
    const maxOutput = modelConfig?.maxOutput ?? 8192;
    // For streaming, use smaller of model max or 16K to avoid context overflow
    const safeMaxTokens = request.maxTokens ?? Math.min(maxOutput, 16384);

    const openRouterRequest: OpenRouterRequest = {
      model: request.model,
      messages: toOpenRouterMessages(request.messages, request.systemPrompt),
      stream: true,
      max_tokens: safeMaxTokens,
      temperature: request.temperature
    };

    if (request.tools && request.tools.length > 0) {
      openRouterRequest.tools = toOpenRouterTools(request.tools);
      openRouterRequest.tool_choice = 'auto';
    }

    const channel = new Channel<string>();
    const chunkQueue: string[] = [];
    let resolveNext: ((v: string | null) => void) | null = null;
    let isDone = false;
    let error: any = null;

    channel.onmessage = (chunk: string) => {
      if (resolveNext) {
        resolveNext(chunk);
        resolveNext = null;
      } else {
        chunkQueue.push(chunk);
      }
    };

    const invokePromise = invoke('openrouter_proxy_stream', {
      body: openRouterRequest,
      apiKey: apiKey.trim(),
      onEvent: channel
    }).then(() => {
      isDone = true;
      if (resolveNext) resolveNext(null);
    }).catch(err => {
      isDone = true;
      error = err;
      if (resolveNext) resolveNext(null);
    });

    let buffer = '';

    // Track tool calls being built up across chunks
    const pendingToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let sawDeltaContent = false;
    let fallbackAccumulated = '';

    try {
      while (true) {
        let line: string | null = null;
        if (chunkQueue.length > 0) {
          line = chunkQueue.shift()!;
        } else if (!isDone) {
          line = await new Promise<string | null>(r => { resolveNext = r; });
        } else {
          break;
        }

        if (error) {
          yield { type: 'error', error: String(error) };
          return;
        }

        if (line === null) break;

        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const data = JSON.parse(jsonStr) as OpenRouterResponse;

          if (data.error) {
            yield { type: 'error', error: mapOpenRouterError(data.error) };
            return;
          }

          if (data.choices && data.choices.length > 0) {
            const choice = data.choices[0];
            const delta = choice.delta;

            if (delta?.content) {
              sawDeltaContent = true;
              yield { type: 'content', content: delta.content };
            }

            // Some OpenRouter models stream reasoning in separate fields.
            // Surface it as thinking so UI does not appear "stuck" while reasoning streams.
            if (delta?.reasoning) {
              yield { type: 'thinking', thinking: delta.reasoning };
            }
            if (delta?.reasoning_content) {
              yield { type: 'thinking', thinking: delta.reasoning_content };
            }

            // Some upstream providers only send final/cumulative message content in stream events.
            // Emit fallback content only when no delta content has been seen, and only emit novel suffix.
            if (
              !sawDeltaContent &&
              !delta?.content &&
              typeof choice.message?.content === 'string' &&
              choice.message.content.length > 0
            ) {
              const nextContent = choice.message.content;
              let novel = nextContent;
              if (fallbackAccumulated && nextContent.startsWith(fallbackAccumulated)) {
                novel = nextContent.slice(fallbackAccumulated.length);
              } else if (nextContent === fallbackAccumulated) {
                novel = '';
              }
              fallbackAccumulated = nextContent;
              if (novel) {
                yield { type: 'content', content: novel };
              }
            }

            // Handle streaming tool calls
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;

                if (!pendingToolCalls.has(idx)) {
                  pendingToolCalls.set(idx, {
                    id: tc.id || `call_${Date.now()}_${idx}`,
                    name: tc.function?.name || '',
                    arguments: ''
                  });
                }

                const pending = pendingToolCalls.get(idx)!;
                if (tc.function?.name) pending.name = tc.function.name;
                if (tc.function?.arguments) pending.arguments += tc.function.arguments;
              }
            }
          }
        } catch (err) {
          console.warn('[OpenRouter] Failed to parse SSE chunk:', err, line);
        }
      }
    } finally {
      // Final tool call emission if stream ended
      for (const [, tc] of pendingToolCalls) {
        try {
          yield {
            type: 'tool_call',
            toolCall: {
              id: tc.id,
              name: tc.name,
              arguments: JSON.parse(tc.arguments)
            }
          };
        } catch { }
      }
      yield { type: 'done' };
      await invokePromise;
    }
  },

  validateKey: validateOpenRouterKey
};
