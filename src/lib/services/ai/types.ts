/**
 * AI Provider Types
 * Unified interface for all AI providers
 */

// Chat message role
export type MessageRole = 'user' | 'assistant' | 'system';

// Chat message
export interface ChatMessage {
  role: MessageRole;
  content: string;
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
  type: 'content' | 'tool_call' | 'done' | 'error';
  content?: string;
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
