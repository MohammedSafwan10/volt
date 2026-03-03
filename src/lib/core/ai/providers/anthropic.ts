/**
 * Anthropic AI Provider
 * 
 * Docs consulted:
 * - Anthropic API (2026): Claude Opus 4.6 with adaptive thinking & effort controls
 * - API Key: x-api-key header
 * - Anthropic Version: 2023-06-01
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

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

const ANTHROPIC_THINKING_SUFFIX = '|thinking';

/**
 * Anthropic API types
 */
interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentPart[];
}

type AnthropicContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string }
    | { type: 'thinking'; thinking: string; signature?: string };

interface AnthropicTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    system?: string;
    max_tokens: number;
    temperature?: number;
    stream?: boolean;
    tools?: AnthropicTool[];
    thinking?: {
        type: 'adaptive' | 'disabled';
    };
    output_config?: {
        effort: 'low' | 'medium' | 'high' | 'max';
    };
}

interface AnthropicResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentPart[];
    model: string;
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
    stop_sequence: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
    error?: {
        type: string;
        message: string;
    };
}

/**
 * Mapping help
 */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
    const anthropicMessages: AnthropicMessage[] = [];

    for (const m of messages) {
        if (m.role === 'system') continue;

        const parts: AnthropicContentPart[] = [];

        if (m.parts && m.parts.length > 0) {
            for (const part of m.parts) {
                if (part.type === 'text') {
                    parts.push({ type: 'text', text: part.text });
                } else if (part.type === 'image') {
                    parts.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: part.mimeType,
                            data: part.data
                        }
                    });
                } else if (part.type === 'thinking') {
                    parts.push({
                        type: 'thinking',
                        thinking: part.text
                    });
                } else if (part.type === 'function_call') {
                    parts.push({
                        type: 'tool_use',
                        id: part.id,
                        name: part.name,
                        input: part.arguments
                    });
                } else if (part.type === 'function_response') {
                    parts.push({
                        type: 'tool_result',
                        tool_use_id: part.id,
                        content: JSON.stringify(part.response)
                    });
                }
            }
        } else {
            parts.push({ type: 'text', text: m.content });
        }

        anthropicMessages.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: parts
        });
    }

    return anthropicMessages;
}

function parseAnthropicModel(model: string): { baseModel: string; effort: 'low' | 'medium' | 'high' | 'max' } {
    if (model.endsWith(ANTHROPIC_THINKING_SUFFIX)) {
        return {
            baseModel: model.slice(0, -ANTHROPIC_THINKING_SUFFIX.length),
            effort: 'max'
        };
    }
    return {
        baseModel: model,
        effort: 'high' // Default effort level for 4.6
    };
}

/**
 * Map Anthropic error
 */
function mapAnthropicError(error: any): string {
    if (!error) return 'Unknown Anthropic error';

    const type = error.type;
    const message = error.message || 'No details provided';

    if (type === 'authentication_error') {
        return 'Invalid Anthropic API key. Tip: Ensure you have a balance of at least $10 in your Anthropic Console (API is separate from Claude Pro).';
    }
    if (type === 'rate_limit_error') {
        return 'Anthropic rate limit exceeded. If you just upgraded, it may take a few hours for limits to refresh.';
    }
    if (type === 'overloaded_error') {
        return 'Anthropic servers are overloaded. Please try again later.';
    }

    return `Anthropic Error (${type}): ${message}`;
}

export async function validateAnthropicKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
        const result = await invoke<any>('anthropic_proxy', {
            body: {
                model: 'claude-opus-4-6',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'Hi' }]
            },
            apiKey: apiKey.trim(),
            anthropicVersion: ANTHROPIC_VERSION
        });

        // If invoke succeeded without error, but the API returned an error inside JSON
        if (result.error && result.error.type === 'authentication_error') {
            return { success: false, error: 'Invalid API key.' };
        }
        return { success: true };
    } catch (err) {
        // Rust returns the error message as a string
        const errorMsg = String(err);
        if (errorMsg.includes('401') || errorMsg.includes('authentication_error')) {
            return { success: false, error: 'Invalid API key.' };
        }
        return { success: false, error: errorMsg };
    }
}

export const anthropicProvider: AIProvider = {
    id: 'anthropic',
    name: 'Anthropic',
    capabilities: {
        supportsStreaming: true,
        supportsTools: true,
        supportsJsonSchema: true,
        maxContextHint: 1000000
    },

    async sendChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): Promise<ChatResponse> {
        const { baseModel, effort } = parseAnthropicModel(request.model);

        const body: AnthropicRequest = {
            model: baseModel,
            messages: toAnthropicMessages(request.messages),
            max_tokens: request.maxTokens || 4096,
            system: request.systemPrompt,
            output_config: { effort: effort },
            thinking: { type: 'adaptive' }
        };

        if (request.temperature !== undefined) {
            body.temperature = request.temperature;
        }

        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as any
            }));
        }

        const data = await invoke<AnthropicResponse>('anthropic_proxy', {
            body,
            apiKey: apiKey.trim(),
            anthropicVersion: ANTHROPIC_VERSION
        });

        if (data.error) {
            throw new Error(mapAnthropicError(data.error));
        }

        let content = '';
        const toolCalls: ToolCall[] = [];

        for (const part of data.content) {
            if (part.type === 'text') {
                content += part.text;
            } else if (part.type === 'tool_use') {
                toolCalls.push({
                    id: part.id,
                    name: part.name,
                    arguments: part.input
                });
            }
        }

        let finishReason: ChatResponse['finishReason'] = 'stop';
        if (data.stop_reason === 'tool_use') finishReason = 'tool_calls';
        else if (data.stop_reason === 'max_tokens') finishReason = 'length';

        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            finishReason,
            usage: {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens: data.usage.input_tokens + data.usage.output_tokens
            }
        };
    },

    async *streamChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
        const { baseModel, effort } = parseAnthropicModel(request.model);

        const body: AnthropicRequest = {
            model: baseModel,
            messages: toAnthropicMessages(request.messages),
            max_tokens: request.maxTokens || 4096,
            system: request.systemPrompt,
            stream: true,
            output_config: { effort: effort },
            thinking: { type: 'adaptive' }
        };

        if (request.temperature !== undefined) {
            body.temperature = request.temperature;
        }

        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as any
            }));
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

        const invokePromise = invoke('anthropic_proxy_stream', {
            body,
            apiKey: apiKey.trim(),
            anthropicVersion: ANTHROPIC_VERSION,
            onEvent: channel
        }).then(() => {
            isDone = true;
            if (resolveNext) {
                resolveNext(null);
                resolveNext = null;
            }
        }).catch(err => {
            isDone = true;
            error = err;
            if (resolveNext) {
                resolveNext(null);
                resolveNext = null;
            }
        });

        let buffer = '';
        let activeToolUse: { id: string; name: string; input: string } | null = null;

        while (true) {
            let sseChunk: string | null = null;
            if (chunkQueue.length > 0) {
                sseChunk = chunkQueue.shift()!;
            } else if (!isDone) {
                sseChunk = await new Promise<string | null>(r => { resolveNext = r; });
            } else {
                break;
            }

            if (error) {
                yield { type: 'error', error: mapAnthropicError({ type: 'error', message: String(error) }) };
                return;
            }

            if (sseChunk === null) break;

            buffer += sseChunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr === '[DONE]') continue;

                try {
                    const event = JSON.parse(jsonStr);

                    if (event.type === 'content_block_start') {
                        if (event.content_block.type === 'tool_use') {
                            activeToolUse = {
                                id: event.content_block.id,
                                name: event.content_block.name,
                                input: ''
                            };
                        }
                    } else if (event.type === 'content_block_delta') {
                        if (event.delta.type === 'text_delta') {
                            yield { type: 'content', content: event.delta.text };
                        } else if (event.delta.type === 'thinking_delta') {
                            yield { type: 'thinking', thinking: event.delta.thinking };
                        } else if (event.delta.type === 'input_json_delta' && activeToolUse) {
                            activeToolUse.input += event.delta.partial_json;
                        }
                    } else if (event.type === 'content_block_stop') {
                        if (activeToolUse) {
                            try {
                                const args = JSON.parse(activeToolUse.input || '{}');
                                yield {
                                    type: 'tool_call',
                                    toolCall: {
                                        id: activeToolUse.id,
                                        name: activeToolUse.name,
                                        arguments: args
                                    }
                                };
                            } catch (e) {
                                console.error('[Anthropic] Failed to parse tool input JSON:', activeToolUse.input);
                            }
                            activeToolUse = null;
                        }
                    } else if (event.type === 'message_delta') {
                        // Usage and stop reason are here
                    } else if (event.type === 'error') {
                        yield { type: 'error', error: mapAnthropicError(event.error) };
                        return;
                    }
                } catch (e) {
                    // Partial JSON or error parsing
                }
            }
        }
        yield { type: 'done' };
        await invokePromise;
    },

    validateKey: validateAnthropicKey
};
