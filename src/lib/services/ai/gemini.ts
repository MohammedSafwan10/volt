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
} from './types';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const GEMINI_THINKING_SUFFIX = '|thinking';

function buildThinkingConfig(model: string): GeminiThinkingConfig {
  // Some Gemini 3 preview models appear to ignore or be picky about thinkingBudget.
  // Keep the config minimal for maximum compatibility.
  if (/^gemini-3/i.test(model)) {
    return {
      // IMPORTANT: Do not request thought summaries; they can leak system/context text.
      // We only want internal reasoning, not user-visible reasoning output.
      includeThoughts: false
    };
  }

  // Gemini 2.5 models support explicit budgeting.
  return {
    // Keep internal reasoning enabled, but do not ask Gemini to emit thought text.
    includeThoughts: false,
    thinkingBudget: 1024
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
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
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

interface GeminiThinkingConfig {
  thinkingBudget?: number; // 0 to disable, positive number for token budget
  includeThoughts?: boolean; // Include thought summaries in response
}

interface GeminiFunctionCallingConfig {
  mode: 'AUTO' | 'ANY' | 'NONE';
  allowedFunctionNames?: string[];
}

interface GeminiToolConfig {
  functionCallingConfig: GeminiFunctionCallingConfig;
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    thinkingConfig?: GeminiThinkingConfig;
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
    let hasFunctionResponse = false;
    
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
        } else if (part.type === 'function_call') {
          // Model's function call - must go in 'model' role
          // CRITICAL: Include thoughtSignature for Gemini 3 models
          const fcPart: GeminiPart = {
            functionCall: {
              name: part.name,
              args: part.arguments
            }
          };
          // Preserve thought signature if present (required for Gemini 3)
          if (part.thoughtSignature) {
            fcPart.thoughtSignature = part.thoughtSignature;
          }
          parts.push(fcPart);
        } else if (part.type === 'function_response') {
          // Tool result - must go in 'user' role as functionResponse
          // Gemini expects each functionResponse in its own content block
          // Format: { name: string, response: { result: ... } }
          hasFunctionResponse = true;
          
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
  const merged: GeminiContent[] = [];
  for (const content of filtered) {
    const last = merged[merged.length - 1];
    if (last && last.role === content.role) {
      // Merge parts into the previous message with same role
      last.parts = [...last.parts, ...content.parts];
    } else {
      merged.push(content);
    }
  }
  
  return merged;
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
        id: `call_${Date.now()}_${calls.length}`,
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
    
    const geminiRequest: GeminiRequest = {
      contents: toGeminiContents(request.messages)
    };
    
    // Add system instruction if provided
    if (request.systemPrompt) {
      geminiRequest.systemInstruction = {
        role: 'user',
        parts: [{ text: request.systemPrompt }]
      };
    }
    
    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      geminiRequest.tools = toGeminiTools(request.tools);
      // Use AUTO mode - model decides when to call functions
      // This allows the model to respond with text when appropriate
      // but still use tools when needed
      geminiRequest.toolConfig = {
        functionCallingConfig: {
          mode: 'AUTO'
        }
      };
    }
    
    // Add generation config with high output limit (Gemini supports up to 65,536)
    geminiRequest.generationConfig = {
      // Default to 8192 tokens for non-streaming, can be overridden
      maxOutputTokens: request.maxTokens ?? 8192
    };
    if (request.temperature !== undefined) {
      geminiRequest.generationConfig.temperature = request.temperature;
    }

    // Explicit thinking toggle (UI-only model suffix)
    if (thinkingEnabled) {
		geminiRequest.generationConfig.thinkingConfig = buildThinkingConfig(model);
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(geminiRequest),
      signal
    });
    
    const data = await response.json() as GeminiResponse;
    
    if (!response.ok || data.error) {
      throw new Error(mapGeminiError(data.error));
    }
    
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('No response from Gemini');
    }
    
    const candidate = data.candidates[0];
    const toolCalls = extractToolCalls(candidate);
    
    // Extract text content
    let content = '';
    for (const part of candidate.content.parts) {
      if (part.text) {
        content += part.text;
      }
    }
    
    // Map finish reason
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
  },

  async *streamChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const { model, thinkingEnabled } = parseGeminiModel(request.model);
    const url = `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`;
    
    const geminiRequest: GeminiRequest = {
      contents: toGeminiContents(request.messages)
    };
    
    // Add system instruction if provided
    if (request.systemPrompt) {
      geminiRequest.systemInstruction = {
        role: 'user',
        parts: [{ text: request.systemPrompt }]
      };
    }
    
    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      geminiRequest.tools = toGeminiTools(request.tools);
      // Use AUTO mode - model decides when to call functions
      // This allows the model to respond with text when appropriate
      // but still use tools when needed
      geminiRequest.toolConfig = {
        functionCallingConfig: {
          mode: 'AUTO'
        }
      };
    }
    
    // Add generation config with high output limit for streaming
    // Gemini 2.5/3 models support up to 65,536 output tokens
    // Default to 16384 for streaming to allow long responses
    geminiRequest.generationConfig = {
      maxOutputTokens: request.maxTokens ?? 16384
    };
    if (request.temperature !== undefined) {
      geminiRequest.generationConfig.temperature = request.temperature;
    }

    // Explicit thinking toggle (UI-only model suffix)
    if (thinkingEnabled) {
		// Keep stream thinking config compatible across model families.
		geminiRequest.generationConfig.thinkingConfig = buildThinkingConfig(model);
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(geminiRequest),
      signal
    });
    
    if (!response.ok) {
      // Try to parse error response
      try {
        const data = await response.json() as GeminiResponse;
        yield { type: 'error', error: mapGeminiError(data.error) };
      } catch {
        yield { type: 'error', error: `HTTP ${response.status}: ${response.statusText}` };
      }
      return;
    }
    
    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    try {
      while (true) {
        let result;
        try {
          result = await reader.read();
        } catch (err) {
          console.error('[Gemini] Stream read error:', err);
          yield { type: 'error', error: 'Connection interrupted while streaming.' };
          break;
        }

        const { done, value } = result;
        
        if (done) {
          if (buffer.trim()) {
            yield* processSSELine(buffer);
          }
          yield { type: 'done' };
          break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        
        // Handle Gemini's SSE format which can use \n\n or \n as separators
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          
          if (line) {
            yield* processSSELine(line);
          }
        }
      }
    } finally {
      reader.releaseLock();
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
            
            // Handle block reasons (Safety, etc.)
            if (candidate.finishReason && ['SAFETY', 'OTHER', 'RECITATION'].includes(candidate.finishReason)) {
               yield { type: 'error', error: `Response blocked by Gemini safety filters (${candidate.finishReason}).` };
               return;
            }

            if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                if (part.text) {
                  const isThought = Boolean((part as any).thought);
                  if (isThought) {
                    yield { type: 'thinking', thinking: part.text };
                  } else {
                    yield { type: 'content', content: part.text };
                  }
                }
                if (part.functionCall) {
                  yield {
                    type: 'tool_call',
                    toolCall: {
                      id: `call_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                      name: part.functionCall.name,
                      arguments: part.functionCall.args,
                      thoughtSignature: part.thoughtSignature
                    }
                  };
                }
              }
            }
          }
        } catch (err) {
          // Log parsing error but don't crash the stream
          console.warn('[Gemini] Failed to parse SSE chunk:', err, line);
        }
      }
    }
  },

  validateKey: validateGeminiKey
};
