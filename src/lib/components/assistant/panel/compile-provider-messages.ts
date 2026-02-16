import type { ChatMessage, ContentPart } from '$lib/services/ai';
import type { AssistantMessage } from '$lib/stores/assistant.svelte';
import { countTokens } from '$lib/services/token-counter';
import { getModelContextLimits } from '$lib/stores/assistant/config';
import { toProviderMessages } from './provider-messages';

export interface CompiledProviderMessages {
  messages: ChatMessage[];
  didPrune: boolean;
  estimatedTokens: number;
  budgetTokens: number;
}

const MAX_COUNTING_BUFFER = 1000;
const COUNTING_BUFFER_RATIO = 0.02;
const MIN_OUTPUT_RESERVE = 1000;
const DEFAULT_TAIL_MESSAGES = 8;

function getCountingSafetyBuffer(contextWindow: number): number {
  return Math.min(MAX_COUNTING_BUFFER, Math.floor(contextWindow * COUNTING_BUFFER_RATIO));
}

function isFunctionPart(part: ContentPart | undefined, type: 'function_call' | 'function_response'): boolean {
  return Boolean(part && part.type === type);
}

function hasFunctionCall(message: ChatMessage): boolean {
  return Boolean(message.parts?.some((part) => isFunctionPart(part, 'function_call')));
}

function hasFunctionResponse(message: ChatMessage): boolean {
  return Boolean(message.parts?.some((part) => isFunctionPart(part, 'function_response')));
}

function serializeMessageForTokenEstimate(message: ChatMessage): string {
  const role = message.role;
  const parts = message.parts ?? [{ type: 'text', text: message.content } as ContentPart];
  const pieces: string[] = [`<${role}>`];

  for (const part of parts) {
    if (part.type === 'text') {
      pieces.push(part.text);
      continue;
    }
    if (part.type === 'image') {
      // Keep image accounting conservative.
      pieces.push(`[image:${part.mimeType}:${part.data.length}]`);
      continue;
    }
    if (part.type === 'function_call') {
      pieces.push(`[function_call:${part.name}:${JSON.stringify(part.arguments)}]`);
      continue;
    }
    if (part.type === 'function_response') {
      pieces.push(`[function_response:${part.name}:${JSON.stringify(part.response)}]`);
      continue;
    }
    if (part.type === 'thinking') {
      pieces.push(part.text);
    }
  }

  return pieces.join('\n');
}

function estimateMessageTokens(message: ChatMessage): number {
  // small role/protocol overhead
  const payload = serializeMessageForTokenEstimate(message);
  return countTokens(payload, 'mixed') + 6;
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function splitMessages(messages: ChatMessage[]): { system: ChatMessage[]; nonSystem: ChatMessage[] } {
  const system: ChatMessage[] = [];
  const nonSystem: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message);
    } else {
      nonSystem.push(message);
    }
  }
  return { system, nonSystem };
}

function buildProtectedTail(nonSystem: ChatMessage[], tailCount = DEFAULT_TAIL_MESSAGES): ChatMessage[] {
  if (nonSystem.length <= tailCount) return [...nonSystem];

  let start = Math.max(0, nonSystem.length - tailCount);
  let tail = nonSystem.slice(start);

  // Ensure we don't leave orphan function_response messages in tail.
  // If the tail starts with function_response without preceding function_call,
  // extend the tail backwards until the corresponding assistant function_call boundary.
  while (start > 0) {
    const first = tail[0];
    if (!hasFunctionResponse(first)) break;
    start -= 1;
    tail = nonSystem.slice(start);
    if (hasFunctionCall(nonSystem[start])) break;
  }

  return tail;
}

export function compileProviderMessages(
  assistantMessages: AssistantMessage[],
  modelId: string,
): CompiledProviderMessages {
  const providerMessages = toProviderMessages(assistantMessages);
  const { inputTokens, outputTokens } = getModelContextLimits(modelId.replace(/\|thinking$/, ''));
  const safetyBuffer = getCountingSafetyBuffer(inputTokens);
  const reserveOutput = Math.max(MIN_OUTPUT_RESERVE, outputTokens);
  const budgetTokens = Math.max(1024, inputTokens - safetyBuffer - reserveOutput);

  const { system, nonSystem } = splitMessages(providerMessages);
  const protectedTail = buildProtectedTail(nonSystem);
  const protectedTailStart = Math.max(0, nonSystem.length - protectedTail.length);
  const historyPool = nonSystem.slice(0, protectedTailStart);

  const protectedTokens = estimateMessagesTokens([...system, ...protectedTail]);
  if (protectedTokens >= budgetTokens) {
    return {
      messages: [...system, ...protectedTail],
      didPrune: nonSystem.length > protectedTail.length,
      estimatedTokens: protectedTokens,
      budgetTokens,
    };
  }

  // Add newest history first while staying under budget, then restore chronological order.
  const selectedHistory: ChatMessage[] = [];
  let runningTokens = protectedTokens;
  for (let i = historyPool.length - 1; i >= 0; i--) {
    const candidate = historyPool[i];
    const candidateTokens = estimateMessageTokens(candidate);
    if (runningTokens + candidateTokens > budgetTokens) continue;
    selectedHistory.push(candidate);
    runningTokens += candidateTokens;
  }
  selectedHistory.reverse();

  const compiled = [...system, ...selectedHistory, ...protectedTail];
  return {
    messages: compiled,
    didPrune: compiled.length < providerMessages.length,
    estimatedTokens: runningTokens,
    budgetTokens,
  };
}
