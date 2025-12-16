/**
 * Google Gemini AI Provider
 * 
 * Docs consulted:
 * - Gemini API: `x-goog-api-key` auth header
 * - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent (SSE)
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

// Gemini API types
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
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

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
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
 */
function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  return messages
    .filter(m => m.role !== 'system') // System handled separately
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
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
    const url = `${GEMINI_API_BASE}/models/${request.model}:generateContent`;
    
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
    }
    
    // Add generation config
    geminiRequest.generationConfig = {};
    if (request.temperature !== undefined) {
      geminiRequest.generationConfig.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      geminiRequest.generationConfig.maxOutputTokens = request.maxTokens;
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
    const url = `${GEMINI_API_BASE}/models/${request.model}:streamGenerateContent?alt=sse`;
    
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
    }
    
    // Add generation config
    geminiRequest.generationConfig = {};
    if (request.temperature !== undefined) {
      geminiRequest.generationConfig.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      geminiRequest.generationConfig.maxOutputTokens = request.maxTokens;
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
      const data = await response.json() as GeminiResponse;
      yield { type: 'error', error: mapGeminiError(data.error) };
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
        const { done, value } = await reader.read();
        
        if (done) {
          yield { type: 'done' };
          break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        
        // Process SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            
            try {
              const data = JSON.parse(jsonStr) as GeminiResponse;
              
              if (data.error) {
                yield { type: 'error', error: mapGeminiError(data.error) };
                return;
              }
              
              if (data.candidates && data.candidates.length > 0) {
                const candidate = data.candidates[0];
                
                for (const part of candidate.content.parts) {
                  if (part.text) {
                    yield { type: 'content', content: part.text };
                  }
                  if (part.functionCall) {
                    yield {
                      type: 'tool_call',
                      toolCall: {
                        id: `call_${Date.now()}`,
                        name: part.functionCall.name,
                        arguments: part.functionCall.args
                      }
                    };
                  }
                }
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  validateKey: validateGeminiKey
};
