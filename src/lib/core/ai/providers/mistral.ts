/**
 * Mistral Provider
 *
 * API reference:
 * - https://docs.mistral.ai/api/#tag/chat
 */

import type {
  AIProvider,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ToolCall,
  ToolDefinition
} from '$core/ai/types';
import { Channel, invoke } from '@tauri-apps/api/core';

interface MistralToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface MistralMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: MistralToolCall[];
  tool_call_id?: string;
}

interface MistralTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface MistralRequest {
  model: string;
  messages: MistralMessage[];
  stream?: boolean;
  tools?: MistralTool[];
  tool_choice?: 'none' | 'auto';
  max_tokens?: number;
  temperature?: number;
}

interface MistralChoice {
  message?: {
    content?: string | null;
    tool_calls?: MistralToolCall[];
  };
  delta?: {
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason?: string | null;
}

interface MistralResponse {
  choices?: MistralChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    message?: string;
    code?: string | number;
  };
}

const MISTRAL_TOOL_ID_RE = /^[A-Za-z0-9]{9}$/;

function isMistralToolId(id: string): boolean {
  return MISTRAL_TOOL_ID_RE.test(id);
}

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalizeMistralToolId(
  rawId: string,
  idMap: Map<string, string>,
  usedIds: Set<string>
): string {
  const trimmed = (rawId || '').trim();
  if (trimmed && isMistralToolId(trimmed)) {
    idMap.set(trimmed, trimmed);
    usedIds.add(trimmed);
    return trimmed;
  }

  const existing = idMap.get(trimmed);
  if (existing) return existing;

  const basis = trimmed || `tool_${Date.now()}_${Math.random()}`;
  let candidate = fnv1a32(basis).toString(36).padStart(9, '0').slice(0, 9);
  let salt = 0;
  while (usedIds.has(candidate)) {
    salt++;
    candidate = fnv1a32(`${basis}:${salt}`).toString(36).padStart(9, '0').slice(0, 9);
  }

  idMap.set(trimmed, candidate);
  usedIds.add(candidate);
  return candidate;
}

function mapMistralError(input: unknown): string {
  if (!input) return 'Mistral request failed.';
  if (typeof input === 'string') {
    return input.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  }
  if (input instanceof Error) {
    return input.message.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  }
  if (typeof input === 'object') {
    try {
      const obj = input as Record<string, unknown>;
      const candidate =
        (typeof obj.message === 'string' && obj.message) ||
        (typeof (obj.error as Record<string, unknown> | undefined)?.message === 'string'
          ? String((obj.error as Record<string, unknown>).message)
          : '') ||
        JSON.stringify(obj);
      return candidate.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
    } catch {
      // fall through to String(input)
    }
  }
  return String(input).replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toMistralTools(tools: ToolDefinition[]): MistralTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function toMistralMessages(messages: ChatMessage[], systemPrompt?: string): MistralMessage[] {
  const result: MistralMessage[] = [];
  const seenToolCallIds = new Set<string>();
  const consumedToolCallIds = new Set<string>();
  const toolIdMap = new Map<string, string>();
  const usedToolIds = new Set<string>();

  if (systemPrompt?.trim()) {
    result.push({ role: 'system', content: systemPrompt.trim() });
  }

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) {
        result.push({ role: 'system', content: message.content });
      }
      continue;
    }

    if (message.parts && message.parts.length > 0) {
      let contentText = '';
      const toolCalls: MistralToolCall[] = [];

      for (const part of message.parts) {
        if (part.type === 'text') {
          if (part.text) contentText += part.text;
          continue;
        }

        if (part.type === 'function_call') {
          if (!part.id || !part.id.trim() || !part.name?.trim()) {
            continue;
          }
          const toolCallId = normalizeMistralToolId(part.id, toolIdMap, usedToolIds);
          toolCalls.push({
            id: toolCallId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.arguments || {})
            }
          });
          continue;
        }

        if (part.type === 'function_response') {
          if (!part.id || !part.id.trim()) {
            continue;
          }
          const toolCallId = normalizeMistralToolId(part.id, toolIdMap, usedToolIds);
          if (!seenToolCallIds.has(toolCallId) || consumedToolCallIds.has(toolCallId)) {
            continue;
          }
          result.push({
            role: 'tool',
            name: part.name,
            content: JSON.stringify(part.response || {}),
            tool_call_id: toolCallId
          });
          consumedToolCallIds.add(toolCallId);
        }
      }

      if (message.role === 'assistant' && toolCalls.length > 0) {
        for (const call of toolCalls) {
          seenToolCallIds.add(call.id);
        }
        result.push({
          role: 'assistant',
          content: contentText,
          tool_calls: toolCalls
        });
      } else if (contentText.trim()) {
        result.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: contentText
        });
      }
      continue;
    }

    if (message.content.trim()) {
      result.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content
      });
    }
  }

  return result;
}

function extractToolCalls(choice: MistralChoice | undefined): ToolCall[] {
  if (!choice?.message?.tool_calls?.length) return [];
  const parsed: ToolCall[] = [];

  for (const call of choice.message.tool_calls) {
    if (!call.id || !call.function?.name) continue;
    try {
      parsed.push({
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      });
    } catch {
      // skip malformed tool payload
    }
  }

  return parsed;
}

export async function validateMistralKey(
  apiKey: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await invoke('mistral_proxy', {
      body: {
        model: 'devstral-medium-latest',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }]
      },
      apiKey: apiKey.trim()
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: mapMistralError(err) };
  }
}

export const mistralProvider: AIProvider = {
  id: 'mistral',
  name: 'Mistral',
  capabilities: {
    supportsStreaming: true,
    supportsTools: true,
    supportsJsonSchema: true,
    maxContextHint: 128000
  },

  async sendChat(request: ChatRequest, apiKey: string): Promise<ChatResponse> {
    const body: MistralRequest = {
      model: request.model,
      messages: toMistralMessages(request.messages, request.systemPrompt),
      max_tokens: request.maxTokens,
      temperature: request.temperature
    };

    if (request.tools?.length) {
      body.tools = toMistralTools(request.tools);
      body.tool_choice = 'auto';
    }

    const data = await invoke<MistralResponse>('mistral_proxy', {
      body,
      apiKey: apiKey.trim()
    });

    if (data.error) {
      throw new Error(mapMistralError(data.error.message || data.error.code || 'Unknown error'));
    }

    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content || '',
      toolCalls: extractToolCalls(choice),
      finishReason: choice?.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0
          }
        : undefined
    };
  },

  async *streamChat(request: ChatRequest, apiKey: string): AsyncGenerator<StreamChunk> {
    const body: MistralRequest = {
      model: request.model,
      messages: toMistralMessages(request.messages, request.systemPrompt),
      max_tokens: request.maxTokens,
      stream: true,
      temperature: request.temperature
    };

    if (request.tools?.length) {
      body.tools = toMistralTools(request.tools);
      body.tool_choice = 'auto';
    }

    const channel = new Channel<string>();
    const chunkQueue: string[] = [];
    let resolveNext: ((v: string | null) => void) | null = null;
    let done = false;
    let streamError: unknown = null;

    channel.onmessage = (chunk: string) => {
      if (resolveNext) {
        resolveNext(chunk);
        resolveNext = null;
      } else {
        chunkQueue.push(chunk);
      }
    };

    const invokePromise = invoke('mistral_proxy_stream', {
      body,
      apiKey: apiKey.trim(),
      onEvent: channel
    })
      .then(() => {
        done = true;
        if (resolveNext) resolveNext(null);
      })
      .catch((err: unknown) => {
        streamError = err;
        done = true;
        if (resolveNext) resolveNext(null);
      });

    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    const streamToolIdMap = new Map<string, string>();
    const streamUsedToolIds = new Set<string>();

    while (true) {
      let line: string | null;
      if (chunkQueue.length > 0) {
        line = chunkQueue.shift() ?? null;
      } else if (!done) {
        line = await new Promise<string | null>((resolve) => {
          resolveNext = resolve;
        });
      } else {
        break;
      }

      if (streamError) {
        yield { type: 'error', error: mapMistralError(streamError) };
        return;
      }
      if (!line) continue;

      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const data = JSON.parse(jsonStr) as MistralResponse;
        if (data.error) {
          yield { type: 'error', error: mapMistralError(data.error.message || data.error.code) };
          return;
        }
        const choice = data.choices?.[0];
        const delta = choice?.delta;

        if (delta?.content) {
          yield { type: 'content', content: delta.content };
        }

        if (Array.isArray(delta?.tool_calls)) {
          for (const call of delta.tool_calls) {
            const idx = call.index ?? 0;
            if (!pendingToolCalls.has(idx)) {
              const fallbackRaw = `idx_${idx}_${Date.now()}`;
              pendingToolCalls.set(idx, {
                id: normalizeMistralToolId(call.id || fallbackRaw, streamToolIdMap, streamUsedToolIds),
                name: call.function?.name || '',
                arguments: ''
              });
            }
            const pending = pendingToolCalls.get(idx);
            if (!pending) continue;
            if (call.id) {
              pending.id = normalizeMistralToolId(call.id, streamToolIdMap, streamUsedToolIds);
            }
            if (call.function?.name) pending.name = call.function.name;
            if (call.function?.arguments) pending.arguments += call.function.arguments;
          }
        }
      } catch {
        // ignore malformed SSE lines
      }
    }

    for (const [, pending] of pendingToolCalls) {
      if (!pending.name) continue;
      yield {
        type: 'tool_call',
        toolCall: {
          id: normalizeMistralToolId(
            pending.id || `end_${Date.now()}`,
            streamToolIdMap,
            streamUsedToolIds
          ),
          name: pending.name,
          arguments: parseToolArguments(pending.arguments)
        }
      };
    }

    yield { type: 'done' };
    await invokePromise;
  },

  validateKey: validateMistralKey
};
