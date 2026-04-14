/**
 * OpenAI Provider
 * 
 * Supports GPT-5 series with Thinking modes
 */

import type {
    AIProvider,
    ChatRequest,
    ChatResponse,
    StreamChunk,
} from '$core/ai/types';
import { invoke, Channel } from '@tauri-apps/api/core';
import { computeNovelStreamText } from './stream-dedupe';

const OPENAI_THINKING_SUFFIX = '|thinking';
const LOCAL_CODEX_PROXY_BASE_URL = 'http://localhost:8317/v1';
const LOCAL_CODEX_PROXY_API_KEY = 'dummy-key';

type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

interface OpenAIRequest {
    model: string;
    messages: any[];
    stream?: boolean;
    tools?: any[];
    max_completion_tokens?: number;
    temperature?: number;
    thinking?: {
        enabled: boolean;
        time_limit?: number;
    };
    reasoning_effort?: ReasoningEffort;
}

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | OpenAIContentPart[];
    name?: string;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
}

interface OpenAIContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
        url: string;
        detail?: 'auto';
    };
}

function isReasoningModel(model: string): boolean {
    return model.endsWith(OPENAI_THINKING_SUFFIX);
}

interface OpenAIChoice {
    message?: {
        content?: string | null;
        tool_calls?: Array<{
            id: string;
            function: {
                name: string;
                arguments: string;
            };
        }>;
    };
    delta?: {
        content?: string | null;
        tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: {
                name?: string;
                arguments?: string;
            };
        }>;
        reasoning_content?: string | null;
    };
    finish_reason?: string | null;
}

interface OpenAIResponse {
    choices?: OpenAIChoice[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    error?: {
        message?: string;
        code?: string | number;
    };
}

function extractStreamContent(choice: OpenAIChoice): string {
    if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
        return choice.delta.content;
    }

    if (typeof choice.message?.content === 'string' && choice.message.content.length > 0) {
        return choice.message.content;
    }

    return '';
}

function toOpenAIMessageText(message: ChatRequest['messages'][number]): string {
    if (message.content?.trim()) return message.content;
    if (!message.parts?.length) return '';

    const textParts = message.parts
        .filter((part) => part.type === 'text' || part.type === 'thinking')
        .map((part) => part.text);

    return textParts.join('\n').trim();
}

function toOpenAIContentParts(message: ChatRequest['messages'][number]): OpenAIContentPart[] {
    const contentParts: OpenAIContentPart[] = [];

    if (!message.parts?.length) {
        const text = message.content?.trim();
        return text ? [{ type: 'text', text }] : [];
    }

    for (const part of message.parts) {
        if (part.type === 'text' || part.type === 'thinking') {
            if (part.text.trim()) {
                contentParts.push({ type: 'text', text: part.text });
            }
            continue;
        }

        if (part.type === 'image') {
            contentParts.push({
                type: 'image_url',
                image_url: {
                    url: `data:${part.mimeType};base64,${part.data}`,
                    detail: 'auto',
                },
            });
        }
    }

    return contentParts;
}

export function toOpenAIMessages(messages: ChatRequest['messages'], systemPrompt?: string): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];
    const seenToolCallIds = new Set<string>();
    const consumedToolCallIds = new Set<string>();

    if (systemPrompt?.trim()) {
        result.push({ role: 'system', content: systemPrompt.trim() });
    }

    for (const message of messages) {
        const functionCalls = message.parts?.filter((part) => part.type === 'function_call') ?? [];
        const functionResponses = message.parts?.filter((part) => part.type === 'function_response') ?? [];
        const textContent = toOpenAIMessageText(message);

        if (functionCalls.length > 0) {
            for (const part of functionCalls) {
                if (part.id?.trim()) {
                    seenToolCallIds.add(part.id);
                }
            }
            result.push({
                role: 'assistant',
                content: textContent || '',
                tool_calls: functionCalls.map((part) => ({
                    id: part.id,
                    type: 'function',
                    function: {
                        name: part.name,
                        arguments: JSON.stringify(part.arguments ?? {}),
                    },
                })),
            });
            continue;
        }

        if (functionResponses.length > 0) {
            for (const part of functionResponses) {
                const toolCallId = part.id?.trim();
                if (!toolCallId || !seenToolCallIds.has(toolCallId) || consumedToolCallIds.has(toolCallId)) {
                    continue;
                }
                result.push({
                    role: 'tool',
                    name: part.name,
                    tool_call_id: toolCallId,
                    content: JSON.stringify(part.response ?? {}),
                });
                consumedToolCallIds.add(toolCallId);
            }
            continue;
        }

        const contentParts = toOpenAIContentParts(message);
        if (contentParts.length === 0) continue;

        const content =
            contentParts.length === 1 && contentParts[0].type === 'text'
                ? contentParts[0].text ?? ''
                : contentParts;
        result.push({
            role: message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user',
            content,
        });
    }

    return result;
}

function mapOpenAIError(response: Response, data?: OpenAIResponse | null, fallback?: string): string {
    const proxyMessage = data?.error?.message?.trim();
    if (proxyMessage) {
        return `Codex proxy error (Status ${response.status} ${response.statusText}): ${proxyMessage}`;
    }
    if (fallback?.trim()) {
        return `Codex proxy error (Status ${response.status} ${response.statusText}): ${fallback.trim()}`;
    }
    return `Codex proxy error (Status ${response.status} ${response.statusText})`;
}

async function parseProxyJson(response: Response): Promise<OpenAIResponse> {
    const raw = await response.text();
    if (!raw.trim()) {
        throw new Error('Codex proxy returned an empty response body.');
    }

    try {
        return JSON.parse(raw) as OpenAIResponse;
    } catch {
        throw new Error(`Codex proxy returned malformed JSON: ${raw.slice(0, 400)}`);
    }
}

function extractChoiceMessage(data: OpenAIResponse): OpenAIChoice {
    const choice = data.choices?.[0];
    if (!choice) {
        throw new Error('Codex proxy returned no choices.');
    }
    return choice;
}

async function fetchLocalCodexProxy(body: OpenAIRequest, signal?: AbortSignal): Promise<OpenAIResponse> {
    const response = await fetch(`${LOCAL_CODEX_PROXY_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LOCAL_CODEX_PROXY_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal,
    });

    const data = await parseProxyJson(response);
    if (!response.ok || data.error) {
        throw new Error(mapOpenAIError(response, data));
    }
    return data;
}

function buildOpenAIRequest(request: ChatRequest): OpenAIRequest {
    const thinking = isReasoningModel(request.model);
    const baseModel = thinking ? request.model.slice(0, -OPENAI_THINKING_SUFFIX.length) : request.model;

    const body: OpenAIRequest = {
        model: baseModel,
        messages: toOpenAIMessages(request.messages, request.systemPrompt),
        max_completion_tokens: request.maxTokens,
        temperature: thinking ? undefined : request.temperature,
        reasoning_effort: request.reasoningEffort,
    };

    if (thinking) {
        body.temperature = undefined;
    }

    if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));
    }

    if (!body.messages.length) {
        body.messages = [{ role: 'user', content: 'Please continue.' }];
    }

    return body;
}

function parseToolArguments(raw: string): Record<string, unknown> {
    try {
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function getStreamedToolArguments(raw: string): {
    arguments: Record<string, unknown>;
    complete: boolean;
} {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { arguments: {}, complete: false };
    }

    try {
        return {
            arguments: JSON.parse(trimmed) as Record<string, unknown>,
            complete: true,
        };
    } catch {
        return { arguments: {}, complete: false };
    }
}

export async function validateOpenAIKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
        await fetchLocalCodexProxy({
            model: 'gpt-5.4',
            max_completion_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }],
        });
        return { success: true };
    } catch (err) {
        return { success: false, error: String(err) };
    }
}

export const openaiProvider: AIProvider = {
    id: 'openai',
    name: 'OpenAI',
    capabilities: {
        supportsStreaming: true,
        supportsTools: true,
        supportsJsonSchema: true,
        maxContextHint: 1000000
    },

    async sendChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): Promise<ChatResponse> {
        const body = buildOpenAIRequest(request);
        const data = await fetchLocalCodexProxy(body, signal);
        const choice = extractChoiceMessage(data);
        const usage = data.usage &&
            typeof data.usage.prompt_tokens === 'number' &&
            typeof data.usage.completion_tokens === 'number' &&
            typeof data.usage.total_tokens === 'number'
            ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            }
            : undefined;
        return {
            content: choice.message?.content || '',
            toolCalls: choice.message?.tool_calls?.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: parseToolArguments(tc.function.arguments)
            })),
            finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
            usage
        };
    },

    async *streamChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
        const reasoningEnabled = isReasoningModel(request.model);
        const body = {
            ...buildOpenAIRequest(request),
            stream: true,
        } satisfies OpenAIRequest;

        // Use Tauri Rust backend to stream from the local codex proxy.
        // Rust reads SSE directly and forwards each line via IPC Channel.
        const channel = new Channel<string>();
        const chunkQueue: string[] = [];
        let resolveNext: ((v: string | null) => void) | null = null;
        let isDone = false;
        let invokeError: string | null = null;

        channel.onmessage = (chunk: string) => {
            if (resolveNext) {
                resolveNext(chunk);
                resolveNext = null;
            } else {
                chunkQueue.push(chunk);
            }
        };

        const invokePromise = invoke('codex_proxy_stream', {
            url: `${LOCAL_CODEX_PROXY_BASE_URL}/chat/completions`,
            body,
            apiKey: LOCAL_CODEX_PROXY_API_KEY,
            onEvent: channel,
        }).then(() => {
            isDone = true;
            if (resolveNext) { resolveNext(null); resolveNext = null; }
        }).catch((err: unknown) => {
            isDone = true;
            invokeError = err instanceof Error ? err.message : String(err);
            if (resolveNext) { resolveNext(null); resolveNext = null; }
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                isDone = true;
                if (resolveNext) { resolveNext(null); resolveNext = null; }
            }, { once: true });
        }

        const pendingToolCalls = new Map<
            number,
            {
                id: string;
                name: string;
                arguments: string;
                emittedPartial: boolean;
                emittedArgsKey: string | null;
                emittedFinal: boolean;
            }
        >();
        let buffer = '';
        let accumulatedContent = '';

        while (true) {
            let sseChunk: string | null = null;
            if (chunkQueue.length > 0) {
                sseChunk = chunkQueue.shift()!;
            } else if (!isDone) {
                sseChunk = await new Promise<string | null>(r => { resolveNext = r; });
            } else {
                break;
            }

            if (invokeError) {
                yield { type: 'error', error: invokeError };
                return;
            }
            if (signal?.aborted) return;
            if (sseChunk === null) break;

            buffer += sseChunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';

            for (const rawLine of lines) {
                const trimmed = rawLine.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;

                const jsonStr = trimmed.slice(5).trim();
                if (!jsonStr) continue;
                if (jsonStr === '[DONE]') continue;

                let event: OpenAIResponse;
                try {
                    event = JSON.parse(jsonStr) as OpenAIResponse;
                } catch {
                    yield {
                        type: 'error',
                        error: `Codex proxy returned malformed SSE JSON: ${jsonStr.slice(0, 400)}`,
                    };
                    return;
                }

                if (event.error) {
                    yield {
                        type: 'error',
                        error: event.error.message || 'Codex proxy streaming error',
                    };
                    return;
                }

                const choice = event.choices?.[0];
                if (!choice) continue;

                const streamedContent = extractStreamContent(choice);
                if (streamedContent) {
                    const next = computeNovelStreamText(streamedContent, accumulatedContent);
                    accumulatedContent = next.nextAccumulated;
                    if (next.novel) {
                        yield { type: 'content', content: next.novel };
                    }
                }

                if (reasoningEnabled && choice.delta?.reasoning_content) {
                    yield { type: 'thinking', thinking: choice.delta.reasoning_content };
                }

                if (Array.isArray(choice.delta?.tool_calls)) {
                    for (const call of choice.delta.tool_calls) {
                        const idx = call.index ?? 0;
                        if (!pendingToolCalls.has(idx)) {
                            pendingToolCalls.set(idx, {
                                id: call.id || `call_${Date.now()}_${idx}`,
                                name: '',
                                arguments: '',
                                emittedPartial: false,
                                emittedArgsKey: null,
                                emittedFinal: false,
                            });
                        }

                        const pending = pendingToolCalls.get(idx)!;
                        if (call.id) pending.id = call.id;
                        if (call.function?.name) pending.name = call.function.name;
                        if (call.function?.arguments) pending.arguments += call.function.arguments;

                        if (!pending.name) {
                            continue;
                        }

                        const parsed = getStreamedToolArguments(pending.arguments);
                        const argsKey = JSON.stringify(parsed.arguments);
                        const shouldEmit =
                            !pending.emittedPartial ||
                            argsKey !== pending.emittedArgsKey;

                        if (!shouldEmit) {
                            continue;
                        }

                        yield {
                            type: 'tool_call',
                            partial: true,
                            toolCall: {
                                id: pending.id,
                                name: pending.name,
                                arguments: parsed.arguments,
                            },
                        };

                        pending.emittedPartial = true;
                        pending.emittedArgsKey = argsKey;
                        pending.emittedFinal = false;
                    }
                }
            }
        }

        // Wait for the invoke to finish
        await invokePromise.catch(() => {});

        for (const [, pending] of pendingToolCalls) {
            if (!pending.name) continue;
            const parsed = getStreamedToolArguments(pending.arguments);
            yield {
                type: 'tool_call',
                partial: false,
                toolCall: {
                    id: pending.id,
                    name: pending.name,
                    arguments: parsed.complete ? parsed.arguments : parseToolArguments(pending.arguments),
                },
            };
        }

        yield { type: 'done' };
    },

    validateKey: validateOpenAIKey
};
