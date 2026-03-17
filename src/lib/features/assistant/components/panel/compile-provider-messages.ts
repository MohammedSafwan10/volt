import type { ChatMessage, ContentPart } from '$core/ai';
import type { AssistantMessage } from '$features/assistant/stores/assistant.svelte';
import { countTokens } from '$core/services/token-counter';
import { getModelContextLimits } from '$features/assistant/stores/assistant/config';
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

function getFunctionCallIds(message: ChatMessage): Set<string> {
  const ids = new Set<string>();
  for (const part of message.parts ?? []) {
    if (part.type === 'function_call' && part.id) {
      ids.add(part.id);
    }
  }
  return ids;
}

function getFunctionResponseIds(message: ChatMessage): Set<string> {
  const ids = new Set<string>();
  for (const part of message.parts ?? []) {
    if (part.type === 'function_response' && part.id) {
      ids.add(part.id);
    }
  }
  return ids;
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

interface MessageBlock {
  messages: ChatMessage[];
  containsFunctionExchange: boolean;
  isComplete: boolean;
}

function buildMessageBlocks(nonSystem: ChatMessage[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];

  for (let i = 0; i < nonSystem.length; i++) {
    const current = nonSystem[i];

    if (!hasFunctionCall(current)) {
      blocks.push({
        messages: [current],
        containsFunctionExchange: hasFunctionResponse(current),
        isComplete: !hasFunctionResponse(current),
      });
      continue;
    }

    const callIds = getFunctionCallIds(current);
    const responseIds = new Set<string>();
    const blockMessages: ChatMessage[] = [current];
    let j = i + 1;

    while (j < nonSystem.length && hasFunctionResponse(nonSystem[j])) {
      blockMessages.push(nonSystem[j]);
      for (const responseId of getFunctionResponseIds(nonSystem[j])) {
        responseIds.add(responseId);
      }
      j += 1;
    }

    i = j - 1;

    const isComplete =
      callIds.size > 0 &&
      Array.from(callIds).every((id) => responseIds.has(id));

    blocks.push({
      messages: blockMessages,
      containsFunctionExchange: true,
      isComplete,
    });
  }

  return blocks;
}

function flattenBlocks(blocks: MessageBlock[]): ChatMessage[] {
  return blocks.flatMap((block) => block.messages);
}

function estimateBlockTokens(block: MessageBlock): number {
  return estimateMessagesTokens(block.messages);
}

function buildProtectedTail(blocks: MessageBlock[], tailCount = DEFAULT_TAIL_MESSAGES): MessageBlock[] {
  if (blocks.length <= tailCount) return [...blocks];

  let start = Math.max(0, blocks.length - tailCount);
  let tail = blocks.slice(start);

  // Ensure the tail starts at a safe boundary. If the first protected block is an
  // incomplete function exchange or starts with function responses only, extend backwards.
  while (start > 0) {
    const first = tail[0];
    if (!first.containsFunctionExchange || first.isComplete) break;
    start -= 1;
    tail = blocks.slice(start);
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
  const allBlocks = buildMessageBlocks(nonSystem).filter(
    (block) => !block.containsFunctionExchange || block.isComplete,
  );
  const protectedTail = buildProtectedTail(allBlocks);
  const protectedTailStart = Math.max(0, allBlocks.length - protectedTail.length);
  const historyPool = allBlocks.slice(0, protectedTailStart);

  const protectedMessages = flattenBlocks(protectedTail);
  const protectedTokens = estimateMessagesTokens([...system, ...protectedMessages]);
  if (protectedTokens >= budgetTokens) {
    const compiled = [...system, ...protectedMessages];
    return {
      messages: compiled,
      didPrune: compiled.length < providerMessages.length,
      estimatedTokens: protectedTokens,
      budgetTokens,
    };
  }

  // Add newest history first while staying under budget, then restore chronological order.
  const selectedHistory: MessageBlock[] = [];
  let runningTokens = protectedTokens;
  for (let i = historyPool.length - 1; i >= 0; i--) {
    const candidate = historyPool[i];
    const candidateTokens = estimateBlockTokens(candidate);
    if (runningTokens + candidateTokens > budgetTokens) continue;
    selectedHistory.push(candidate);
    runningTokens += candidateTokens;
  }
  selectedHistory.reverse();

  const compiled = [
    ...system,
    ...flattenBlocks(selectedHistory),
    ...protectedMessages,
  ];
  return {
    messages: compiled,
    didPrune: compiled.length < providerMessages.length,
    estimatedTokens: runningTokens,
    budgetTokens,
  };
}
