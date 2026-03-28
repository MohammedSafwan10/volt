/**
 * Google Gemini AI Provider
 * 
 * Docs consulted:
 * - Gemini API: `x-goog-api-key` auth header
 * - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent (SSE)
 * - Gemini API: multimodal vision with inline base64 data (mimeType + data format)
 * - Gemini API: thinkingConfig for native reasoning (thinkingBudget, includeThoughts)
 * - Gemini 2.5 models support thinking by default, can be configured via thinkingConfig
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
import { invoke, Channel } from '@tauri-apps/api/core';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const GEMINI_THINKING_SUFFIX = '|thinking';

/**
 * Check if model is Gemini 3 series
 */
function isGemini3Model(model: string): boolean {
  return model.includes('gemini-3');
}



/**
 * Build thinking config based on model series
 * - Gemini 3 Pro: supports LOW/HIGH only (MINIMAL not supported)
 * - Gemini 3 Flash: supports MINIMAL/LOW/MEDIUM/HIGH
 * - Gemini 2.5: uses thinkingBudget (0 to disable, -1 for unlimited)
 */
function buildThinkingConfig(model: string, thinkingEnabled: boolean): GeminiThinkingConfig | undefined {
  if (isGemini3Model(model)) {
    // For Gemini 3, when thinking is "off" in Volt's model selector, omit thinkingConfig.
    // This avoids INVALID_ARGUMENT on models that don't support MINIMAL (e.g. 3 Pro).
    // Gemini will use default dynamic reasoning for the model.
    if (!thinkingEnabled) return undefined;

    // Gemini 3 models support thinking parameters.
    return {
      includeThoughts: true,
      thinkingLevel: 'HIGH'
    };
  }

  // Gemini 2.5 series: use thinkingBudget (camelCase for REST API)
  return {
    includeThoughts: thinkingEnabled,
    thinkingBudget: thinkingEnabled ? -1 : 0
  };
}

function parseGeminiModel(rawModel: string): { model: string; thinkingEnabled: boolean } {
  const modelWithoutPrefix = rawModel.startsWith('models/') ? rawModel.slice('models/'.length) : rawModel;
  if (modelWithoutPrefix.endsWith(GEMINI_THINKING_SUFFIX)) {
    return {
      model: modelWithoutPrefix.slice(0, -GEMINI_THINKING_SUFFIX.length),
      thinkingEnabled: true
    };
  }
  return { model: modelWithoutPrefix, thinkingEnabled: false };
}

// Gemini API types
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean; // True if this part is a thinking/reasoning part
  thoughtSignature?: string; // Gemini 3 thought signature - MUST be preserved for function calling
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    id?: string; // Optional call ID for parallel calling/Gemini 3
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string; // Must match the functionCall.id
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// CRITICAL: Gemini REST API uses camelCase for thinkingConfig fields!
interface GeminiThinkingConfig {
  includeThoughts?: boolean; // Include thought summaries in response
  thinkingBudget?: number; // 2.5 series: 0 to disable, positive for token budget
  thinkingLevel?: 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL'; // 3 series: dynamic vs explicit
}

interface GeminiFunctionCallingConfig {
  mode: 'AUTO' | 'ANY' | 'NONE';
  allowedFunctionNames?: string[];
}

interface GeminiToolConfig {
  functionCallingConfig: GeminiFunctionCallingConfig;
}

// CRITICAL: Gemini REST API uses camelCase for generationConfig!
interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent; // camelCase for REST API
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    topK?: number;
    topP?: number;
    thinkingConfig?: GeminiThinkingConfig;
    responseMimeType?: string; // Force text/plain to prevent JSON output
  };
}

// Streaming response can have partial candidates
interface GeminiStreamCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiStreamResponse {
  candidates?: GeminiStreamCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Convert our message format to Gemini format
 * Supports multimodal content (text + images + function calls/responses)
 * 
 * CRITICAL for multi-turn function calling:
 * - Model's function calls must be in 'model' role with functionCall parts
 * - Function responses must be in 'user' role with functionResponse parts
 * - The sequence must be: user -> model (with functionCall) -> user (with functionResponse) -> model continues
 */
function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === 'system') continue; // System handled separately

    const parts: GeminiPart[] = [];

    // If message has multimodal parts, use them
    if (m.parts && m.parts.length > 0) {
      for (const part of m.parts) {
        if (part.type === 'text') {
          parts.push({ text: part.text });
        } else if (part.type === 'image') {
          parts.push({
            inlineData: {
              mimeType: part.mimeType,
              data: part.data
            }
          });
        } else if (part.type === 'thinking') {
          // Model's previous thinking - send back as thought part
          parts.push({
            text: part.text,
            thought: true
          } as any);
        } else if (part.type === 'function_call') {
          // Model's function call - must go in 'model' role
          // CRITICAL: Include thoughtSignature for Gemini 3 models
          const fcPart: GeminiPart = {
            functionCall: {
              id: part.id, // Include native ID for multi-turn matching
              name: part.name,
              args: part.arguments
            }
          };
          // Preserve thought signature if present (required for Gemini 3)
          if (part.thoughtSignature) {
            fcPart.thoughtSignature = part.thoughtSignature;
          }
          // Preserve native function call ID if present (required for Gemini 3 and 2.5)
          if (part.id) {
            // Note: Gemini API often expects this to be handled via the specific response object structure
            // but we keep it here for our internal state tracking.
          }
          parts.push(fcPart);
        } else if (part.type === 'function_response') {
          // Tool result - must go in 'user' role as functionResponse
          // Gemini expects each functionResponse in its own content block
          // Format: { name: string, response: { result: ... } }

          // If we have accumulated parts, push them first
          if (parts.length > 0) {
            contents.push({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [...parts]
            });
            parts.length = 0;
          }

          // Add function response as separate content with 'user' role
          // Wrap the response in 'result' key as per Gemini API spec
          contents.push({
            role: 'user',
            parts: [{
              functionResponse: {
                id: part.id, // Must match original call ID
                name: part.name,
                response: { result: part.response }
              }
            }]
          });
        }
      }
    } else if (m.content && m.content.trim()) {
      // Fallback to text-only content (only if non-empty)
      parts.push({ text: m.content });
    }

    // Push remaining parts if any (and not already handled by function response)
    // Skip empty parts arrays to avoid "Invalid request" errors
    if (parts.length > 0) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts
      });
    }
  }

  // Filter out any content blocks with empty parts (safety check)
  const filtered = contents.filter(c => c.parts && c.parts.length > 0);

  // Gemini requires alternating user/model roles
  // Merge consecutive same-role messages to avoid "Invalid request" errors
  const hasFunctionResponsePart = (c: GeminiContent): boolean =>
    c.parts?.some((p) => Boolean((p as GeminiPart).functionResponse));

  const merged: GeminiContent[] = [];
  for (const content of filtered) {
    const last = merged[merged.length - 1];
    if (last && last.role === content.role) {
      const lastHasFnResp = hasFunctionResponsePart(last);
      const currHasFnResp = hasFunctionResponsePart(content);

      // Avoid merging functionResponse parts with normal text/image parts.
      // (Function responses are sensitive to formatting in the Gemini API.)
      if (lastHasFnResp !== currHasFnResp) {
        merged.push(content);
        continue;
      }

      // Merge parts into the previous message with same role
      last.parts = [...last.parts, ...content.parts];
    } else {
      merged.push(content);
    }
  }

  return merged;
}

export function ensureGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const contents = toGeminiContents(messages);
  if (contents.length > 0) {
    return contents;
  }

  return [
    {
      role: 'user',
      parts: [{ text: 'Please continue.' }],
    },
  ];
}

/**
 * Convert tool definitions to Gemini format
 */
function toGeminiTools(tools: ToolDefinition[]): GeminiTool[] {
  if (tools.length === 0) return [];

  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }];
}

/**
 * Extract tool calls from Gemini response
 */
function extractToolCalls(candidate: GeminiCandidate): ToolCall[] {
  const calls: ToolCall[] = [];

  for (const part of candidate.content.parts) {
    if (part.functionCall) {
      calls.push({
        id: (part as any).id || (part as any).functionCall.id || `call_${Date.now()}_${calls.length}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args
      });
    }
  }

  return calls;
}

/**
 * Map Gemini error to user-friendly message
 * NEVER includes the API key in error messages
 */
function mapGeminiError(error: GeminiResponse['error']): string {
  if (!error) return 'Unknown error';

  const code = error.code;
  const status = error.status;

  // Map common errors
  if (code === 401 || status === 'UNAUTHENTICATED') {
    return 'Invalid API key. Please check your Gemini API key.';
  }
  if (code === 403 || status === 'PERMISSION_DENIED') {
    return 'API key does not have permission. Check your API key settings.';
  }
  if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
    return 'Rate limit exceeded. Please wait a moment and try again.';
  }
  if (code === 400 || status === 'INVALID_ARGUMENT') {
    return 'Invalid request. Please check your input.';
  }
  if (code === 503 || status === 'UNAVAILABLE') {
    return 'Gemini service is temporarily unavailable. Please try again later.';
  }

  // Generic error - redact any potential sensitive data
  const safeMessage = error.message.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  return `Gemini API error: ${safeMessage}`;
}

/**
 * Validate a Gemini API key by making a minimal request
 */
export async function validateGeminiKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
  try {
    const url = `${GEMINI_API_BASE}/models/gemini-2.5-flash:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: 'Hi' }]
        }],
        generationConfig: {
          maxOutputTokens: 5
        }
      })
    });

    if (!response.ok) {
      const data = await response.json() as GeminiResponse;
      return { success: false, error: mapGeminiError(data.error) };
    }

    return { success: true };
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch')) {
      return { success: false, error: 'Network error. Please check your internet connection.' };
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const safeMsg = msg.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
    return { success: false, error: safeMsg };
  }
}

/**
 * Gemini AI Provider implementation
 */
export const geminiProvider: AIProvider = {
  id: 'gemini',
  name: 'Google Gemini',
  capabilities: {
    supportsStreaming: true,
    supportsTools: true,
    supportsJsonSchema: true,
    maxContextHint: 1000000
  } as ProviderCapabilities,

  async sendChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): Promise<ChatResponse> {
    const { model, thinkingEnabled } = parseGeminiModel(request.model);
    const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

    const geminiBody = {
      contents: ensureGeminiContents(request.messages),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 8192,
        stopSequences: ['<system_context', '</system_context', '<smart_context', '</smart_context'],
        topK: 40,
        topP: 0.95
      } as any,
      tools: undefined as GeminiTool[] | undefined,
      toolConfig: undefined as any
    };

    if (request.systemPrompt) {
      (geminiBody as GeminiRequest).systemInstruction = {
        parts: [{ text: request.systemPrompt }]
      } as any;
    }

    if (request.tools && request.tools.length > 0) {
      geminiBody.tools = toGeminiTools(request.tools);
      geminiBody.toolConfig = {
        functionCallingConfig: {
          mode: 'AUTO'
        }
      };
    }

    if (request.temperature !== undefined) {
      geminiBody.generationConfig.temperature = request.temperature;
    }

    geminiBody.generationConfig.thinkingConfig = buildThinkingConfig(model, thinkingEnabled);

    try {
      const data = await invoke<GeminiResponse>('gemini_proxy', {
        body: geminiBody,
        apiKey: apiKey,
        model: model
      });

      if (data.error) {
        throw new Error(mapGeminiError(data.error));
      }

      if (!data.candidates || data.candidates.length === 0) {
        throw new Error('No response from Gemini');
      }

      const candidate = data.candidates[0];
      const toolCalls = extractToolCalls(candidate);

      let content = '';
      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            content += part.text;
          }
        }
      }

      let finishReason: ChatResponse['finishReason'] = 'stop';
      if (toolCalls.length > 0) {
        finishReason = 'tool_calls';
      } else if (candidate.finishReason === 'MAX_TOKENS') {
        finishReason = 'length';
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        usage: data.usageMetadata ? {
          promptTokens: data.usageMetadata.promptTokenCount,
          completionTokens: data.usageMetadata.candidatesTokenCount,
          totalTokens: data.usageMetadata.totalTokenCount
        } : undefined
      };
    } catch (err: any) {
      throw new Error(`Gemini error: ${err.message || String(err)}`);
    }
  },

  async *streamChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const { model, thinkingEnabled } = parseGeminiModel(request.model);

    const geminiBody = {
      contents: ensureGeminiContents(request.messages),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 65536,
        stopSequences: ['<system_context', '</system_context', '<smart_context', '</smart_context'],
        topK: 40,
        topP: 0.95
      } as any,
      tools: undefined as GeminiTool[] | undefined,
      toolConfig: undefined as any
    };

    if (request.systemPrompt) {
      (geminiBody as GeminiRequest).systemInstruction = {
        parts: [{ text: request.systemPrompt }]
      } as any;
    }

    if (request.tools && request.tools.length > 0) {
      geminiBody.tools = toGeminiTools(request.tools);
      geminiBody.toolConfig = {
        functionCallingConfig: {
          mode: 'AUTO'
        }
      };
    }

    if (request.temperature !== undefined) {
      geminiBody.generationConfig.temperature = request.temperature;
    }

    geminiBody.generationConfig.thinkingConfig = buildThinkingConfig(model, thinkingEnabled);

    const chunkQueue: string[] = [];
    let resolveNext: ((val: string | null) => void) | null = null;
    let isDone = false;
    let error: Error | null = null;

    const onEvent = new Channel<string>();
    onEvent.onmessage = (message) => {
      chunkQueue.push(message);
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve(chunkQueue.shift()!);
      }
    };

    const invokePromise = invoke('gemini_proxy_stream', {
      body: geminiBody,
      apiKey: apiKey,
      model: model,
      onEvent
    }).then(() => {
      isDone = true;
      if (resolveNext) resolveNext(null);
    }).catch(err => {
      error = err;
      if (resolveNext) resolveNext(null);
    });

    const yieldedToolCalls = new Set<string>();

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

        yield* processSSELine(line);
      }
    } finally {
      try {
        await invokePromise;
      } catch (cleanupErr) {
        // invokePromise rejection was already surfaced via the error variable;
        // swallow here so the 'done' event always fires.
        console.warn('[Gemini] invoke promise rejected during cleanup:', cleanupErr);
      }
      yield { type: 'done' };
    }

    function* processSSELine(line: string): Generator<StreamChunk> {
      if (line.startsWith('data:')) {
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') return;

        try {
          const data = JSON.parse(jsonStr) as GeminiStreamResponse;

          if (data.error) {
            yield { type: 'error', error: mapGeminiError(data.error) };
            return;
          }

          if (data.candidates && data.candidates.length > 0) {
            const candidate = data.candidates[0];

            if (candidate.finishReason && ['SAFETY', 'OTHER', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate.finishReason)) {
              yield { type: 'error', error: `Response blocked by Gemini safety filters (${candidate.finishReason}).` };
              return;
            }

            if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                if (part.functionCall) {
                  // Deduplicate tool calls: Gemini sometimes sends the same call multiple times in a stream,
                  // or the agent might hallucinate identical parallel calls. We only want one unique call per turn.
                  // We use a simple JSON stream signature.
                  const signature = JSON.stringify({
                    n: part.functionCall.name,
                    a: part.functionCall.args
                  });

                  if (yieldedToolCalls.has(signature)) {
                    continue;
                  }
                  yieldedToolCalls.add(signature);

                  yield {
                    type: 'tool_call',
                    toolCall: {
                      id: (part as any).id || (part as any).functionCall.id || `call_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                      name: part.functionCall.name,
                      arguments: part.functionCall.args,
                      thoughtSignature: part.thoughtSignature
                    }
                  };
                  continue;
                }

                if (!part.text || !part.text.trim()) {
                  continue;
                }

                const text = part.text;
                const isThought = Boolean((part as any).thought);

                if (isThought) {
                  yield { type: 'thinking', thinking: text };
                } else {
                  yield { type: 'content', content: text };
                }
              }
            }
          }
        } catch (err) {
          console.warn('[Gemini] Failed to parse SSE chunk:', err, line);
        }
      }
    }
  },

  validateKey: validateGeminiKey
};
