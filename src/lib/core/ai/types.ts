/**
 * AI Provider Types
 * Unified interface for all AI providers
 * 
 * Docs consulted:
 * - Gemini API: multimodal vision with inline base64 data (mimeType + data format)
 */

// Chat message role
export type MessageRole = 'user' | 'assistant' | 'system';

// Content part types for multimodal messages
export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string; // Base64 encoded
}

export interface FunctionCallPart {
  type: 'function_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  // Gemini 3 thought signature - must be preserved and sent back for multi-turn function calling
  thoughtSignature?: string;
}

export interface FunctionResponsePart {
  type: 'function_response';
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export interface ThinkingPart {
  type: 'thinking';
  text: string;
}

export type ContentPart = TextPart | ImagePart | FunctionCallPart | FunctionResponsePart | ThinkingPart;

// Chat message (supports multimodal content)
export interface ChatMessage {
  role: MessageRole;
  content: string;
  parts?: ContentPart[]; // For multimodal messages
}

// Tool definition for function calling
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Tool call from the model
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  // Gemini 3 thought signature - must be preserved and sent back for multi-turn function calling
  thoughtSignature?: string;
}

// Chat request options
export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}

// Non-streaming response
export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// Streaming chunk
export interface StreamChunk {
  type: 'content' | 'thinking' | 'tool_call' | 'done' | 'error';
  content?: string;
  thinking?: string; // Thinking/reasoning content from model
  toolCall?: ToolCall;
  error?: string;
}

// Provider capabilities
export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsJsonSchema: boolean;
  maxContextHint: number;
}

// Provider interface
export interface AIProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Send a chat request (non-streaming)
   */
  sendChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): Promise<ChatResponse>;

  /**
   * Send a streaming chat request
   * Returns an async generator that yields chunks
   */
  streamChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): AsyncGenerator<StreamChunk>;

  /**
   * Validate the API key
   */
  validateKey(apiKey: string): Promise<{ success: boolean; error?: string }>;
}
