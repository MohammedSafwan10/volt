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
    ChatMessage,
    ToolCall,
} from './types';
import { invoke, Channel } from '@tauri-apps/api/core';

const OPENAI_THINKING_SUFFIX = '|thinking';

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
}

export async function validateOpenAIKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
        await invoke('openai_proxy', {
            body: {
                model: 'gpt-5-mini',
                max_completion_tokens: 1,
                messages: [{ role: 'user', content: 'Hi' }]
            },
            apiKey: apiKey.trim()
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
        const thinking = request.model.endsWith(OPENAI_THINKING_SUFFIX);
        const baseModel = thinking ? request.model.slice(0, -OPENAI_THINKING_SUFFIX.length) : request.model;

        const body: OpenAIRequest = {
            model: baseModel,
            messages: request.messages,
            max_completion_tokens: request.maxTokens,
            temperature: thinking ? undefined : request.temperature,
            thinking: thinking ? { enabled: true } : undefined
        };

        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }
            }));
        }

        const data = await invoke<any>('openai_proxy', {
            body,
            apiKey: apiKey.trim()
        });

        if (data.error) {
            throw new Error(data.error.message || 'OpenAI Error');
        }

        const choice = data.choices[0];
        return {
            content: choice.message.content || '',
            toolCalls: choice.message.tool_calls?.map((tc: any) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments)
            })),
            finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
            usage: {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens
            }
        };
    },

    async *streamChat(request: ChatRequest, apiKey: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
        const thinking = request.model.endsWith(OPENAI_THINKING_SUFFIX);
        const baseModel = thinking ? request.model.slice(0, -OPENAI_THINKING_SUFFIX.length) : request.model;

        const body: OpenAIRequest = {
            model: baseModel,
            messages: request.messages,
            max_completion_tokens: request.maxTokens,
            stream: true,
            temperature: thinking ? undefined : request.temperature,
            thinking: thinking ? { enabled: true } : undefined
        };

        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }
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

        const invokePromise = invoke('openai_proxy_stream', {
            body,
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
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') continue;

            try {
                const event = JSON.parse(jsonStr);
                const choice = event.choices[0];

                if (choice.delta.content) {
                    yield { type: 'content', content: choice.delta.content };
                }

                if (choice.delta.reasoning_content) {
                    yield { type: 'thinking', thinking: choice.delta.reasoning_content };
                }
            } catch (e) { }
        }

        yield { type: 'done' };
        await invokePromise;
    },

    validateKey: validateOpenAIKey
};
