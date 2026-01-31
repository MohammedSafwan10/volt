/**
 * Assistant Store - Manages AI assistant panel state
 * Handles conversation, modes, attachments, and streaming state
 * 
 * Docs consulted:
 * - Gemini API: multimodal vision with inline base64 data (mimeType + data format)
 * - Tauri v2: dialog plugin for file picker with filters
 * - Svelte 5: $state runes for immutable state management
 */

import type { AIMode } from './ai.svelte';
import { doesToolRequireApproval, getToolByName } from '$lib/services/ai/tools/definitions';
import { getModelConfig } from '$lib/services/ai/models';
import { countTokens, countConversationTokens, type ContentType } from '$lib/services/token-counter';
import { invoke } from '@tauri-apps/api/core';

// Message roles
export type MessageRole = 'user' | 'assistant' | 'tool';

// Tool call status
export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ToolCallReviewStatus = 'pending' | 'accepted' | 'rejected';

// Streaming progress for file write operations
export interface StreamingProgress {
  charsWritten: number;
  totalChars: number;
  linesWritten: number;
  totalLines: number;
  percent: number;
}

// Tool call representation
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  output?: string;
  error?: string;
  meta?: Record<string, unknown>;
  /** Additional data (e.g., image_base64 for screenshots) */
  data?: Record<string, unknown>;
  startTime?: number;
  endTime?: number;
  requiresApproval?: boolean;
  // Gemini 3 thought signature - must be preserved for multi-turn function calling
  thoughtSignature?: string;
  // Streaming progress for file write tools
  streamingProgress?: StreamingProgress;
  // Windsurf-style edit review (optional)
  reviewStatus?: ToolCallReviewStatus;
}

// Content part types for interleaved rendering (like Kiro/Cursor)
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolCall: ToolCall }
  | { type: 'thinking'; thinking: string; startTime: number; endTime?: number; title?: string; isActive?: boolean };

// Chat message with attachments
export interface AssistantMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  endTime?: number; // When the message/response completed
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  attachments?: MessageAttachment[];
  thinking?: string; // Model's thinking/reasoning (if available)
  isThinking?: boolean; // Currently in thinking phase
  // For inline tool display - tool calls that belong to this message
  inlineToolCalls?: ToolCall[];
  // Ordered content parts for interleaved text + tool rendering (like Kiro)
  contentParts?: ContentPart[];
  // Reference context block (hidden from UI, sent to provider)
  smartContextBlock?: string;
  // User-selected mentions from @ menu (shown as chips)
  contextMentions?: AttachedContext[];
}

// Conversation container
export interface Conversation {
  id: string;
  createdAt: number;
  messages: AssistantMessage[];
}

// Selection range for Monaco editor
export interface SelectionRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

// Base attachment interface
interface BaseAttachment {
  id: string;
  label: string;
  checksum?: string; // Short hash for stale detection
}

// File attachment
export interface FileAttachment extends BaseAttachment {
  type: 'file';
  path: string;
  content: string;
}

// Selection attachment (from Monaco)
export interface SelectionAttachment extends BaseAttachment {
  type: 'selection';
  path?: string;
  content: string;
  range?: SelectionRange;
}

// Folder scope attachment
export interface FolderAttachment extends BaseAttachment {
  type: 'folder';
  path: string;
}

// Image attachment (vision)
export interface ImageAttachment extends BaseAttachment {
  type: 'image';
  filename: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string; // Base64 encoded
  byteSize: number;
  dimensions?: { width: number; height: number };
}

// Browser element attachment (hidden context, shown as chip)
export interface ElementAttachment extends BaseAttachment {
  type: 'element';
  tagName: string;
  selector: string;
  html: string;
  css: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

// Union type for all attachments
export type MessageAttachment = FileAttachment | SelectionAttachment | FolderAttachment | ImageAttachment | ElementAttachment;

// Legacy attached context (for backward compatibility)
export interface AttachedContext {
  type: 'file' | 'selection';
  path?: string;
  content: string;
  label: string;
}

// Image attachment limits (configurable)
export const IMAGE_LIMITS = {
  maxImagesPerMessage: 5,
  maxImageBytes: 5 * 1024 * 1024, // 5MB per image
  maxTotalImageBytesPerMessage: 15 * 1024 * 1024, // 15MB total
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] as const
};

// Model context limits (in tokens)
// Gemini 2.5 Flash: 1,048,576 input tokens, 65,536 output tokens
// Gemini 3 Flash Preview: 1,048,576 input tokens, 65,536 output tokens (estimated)
export const MODEL_CONTEXT_LIMITS: Record<string, { inputTokens: number; outputTokens: number }> = {
  'gemini-2.5-flash': { inputTokens: 1_048_576, outputTokens: 65_536 },
  'gemini-2.5-flash-lite': { inputTokens: 1_048_576, outputTokens: 65_536 },
  'gemini-2.5-pro': { inputTokens: 1_048_576, outputTokens: 65_536 },
};

// Default context limit if model not found
const DEFAULT_CONTEXT_LIMIT = { inputTokens: 1_000_000, outputTokens: 8_192 };

// Context packing limits
export const CONTEXT_LIMITS = {
  maxContextSize: 100000, // ~100k chars default cap for attachments
  maxFilesPerMessage: 10
};

const MAX_THINKING_CHARS = 8000;

// Secret patterns to redact
const SECRET_PATTERNS = [
  /^\.env$/i,
  /\.env\./i,
  /secret/i,
  /password/i,
  /api[_-]?key/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i
];

// Mode capabilities - enforced in code, not just UI
export const MODE_CAPABILITIES: Record<AIMode, {
  canMutateFiles: boolean;
  canExecuteCommands: boolean;
  canUseTools: boolean;
  description: string;
}> = {
  ask: {
    canMutateFiles: false,
    canExecuteCommands: false,
    canUseTools: true, // Read-only tools are allowed
    description: 'Read-only mode for questions and explanations'
  },
  plan: {
    canMutateFiles: false,
    canExecuteCommands: false,
    canUseTools: true,
    description: 'Planning mode - can analyze but not modify'
  },
  agent: {
    canMutateFiles: true,
    canExecuteCommands: true,
    canUseTools: true,
    description: 'Full agent mode with file and command access'
  }
};

// Panel width storage key
const PANEL_WIDTH_KEY = 'volt.assistant.panelWidth';
const PANEL_OPEN_KEY = 'volt.assistant.panelOpen';
const CURRENT_CONV_ID_KEY = 'volt.assistant.currentConversationId';
const DEFAULT_PANEL_WIDTH = 400;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 800;

/**
 * Generate a short checksum for content (for stale detection)
 */
function generateChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

/**
 * Check if a path looks like it contains secrets
 */
function isLikelySecretPath(path: string): boolean {
  const filename = path.split('/').pop() ?? path;
  return SECRET_PATTERNS.some(pattern => pattern.test(filename));
}

/**
 * Redact potential secrets from content
 */
function redactSecrets(content: string): string {
  // Redact common secret patterns
  return content
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*["']?([^"'\s\n]+)["']?/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9_-]{20,}/gi, 'Bearer [REDACTED]')
    .replace(/[A-Za-z0-9_-]{32,}/g, (match) => {
      // Only redact if it looks like a key (mixed case, numbers, etc.)
      if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
        return '[REDACTED]';
      }
      return match;
    });
}

/**
 * Sanitize user input to remove excessive repetition
 * This prevents the model from echoing back massive repetitive text
 */
function sanitizeUserInput(content: string): string {
  // Max input length (chars) - roughly 50k tokens
  const MAX_INPUT_LENGTH = 200_000;

  // If input is short, no need to process
  if (content.length < 500) {
    return content;
  }

  // Truncate if excessively long
  if (content.length > MAX_INPUT_LENGTH) {
    content = content.slice(0, MAX_INPUT_LENGTH) + '\n\n[Input truncated due to length]';
  }

  // Detect repetitive patterns (phrases repeated 3+ times consecutively)
  // Common pattern: "make it better and add features and make it better and add features..."
  const words = content.split(/\s+/);

  // Look for repeated phrase patterns (5-30 words)
  for (let phraseLen = 5; phraseLen <= 30; phraseLen++) {
    if (words.length < phraseLen * 3) continue;

    for (let start = 0; start < words.length - phraseLen * 2; start++) {
      const phrase = words.slice(start, start + phraseLen).join(' ');
      let repeatCount = 1;
      let checkPos = start + phraseLen;

      while (checkPos + phraseLen <= words.length) {
        const nextPhrase = words.slice(checkPos, checkPos + phraseLen).join(' ');
        if (nextPhrase === phrase) {
          repeatCount++;
          checkPos += phraseLen;
        } else {
          break;
        }
      }

      // If phrase repeats 3+ times, collapse it
      if (repeatCount >= 3) {
        const beforeRepeat = words.slice(0, start).join(' ');
        const afterRepeat = words.slice(start + phraseLen * repeatCount).join(' ');
        const collapsed = `${beforeRepeat} ${phrase} [repeated ${repeatCount}x, collapsed] ${afterRepeat}`.trim();
        return sanitizeUserInput(collapsed); // Recurse to catch nested patterns
      }
    }
  }

  return content;
}

class AssistantStore {
  // Panel state
  panelOpen = $state(false);
  panelWidth = $state(DEFAULT_PANEL_WIDTH);

  // Mode state
  // Default to agent mode on startup.
  currentMode = $state<AIMode>('agent');

  // Conversation state
  currentConversation = $state<Conversation | null>(null);
  messages = $state<AssistantMessage[]>([]);

  // Input state
  inputValue = $state("");
  attachedContext = $state<AttachedContext[]>([]);
  inputHistory = $state<string[]>([]);
  historyIndex = $state(-1); // -1 means current draft
  draftValue = $state(""); // Stores what the user was typing before navigating history

  // New attachment model
  pendingAttachments = $state<MessageAttachment[]>([]);

  // Streaming state
  isStreaming = $state(false);
  abortController = $state<AbortController | null>(null);

  // Current tool calls being displayed
  activeToolCalls = $state<ToolCall[]>([]);

  constructor() {
    this.loadPanelWidth();
    this.loadPanelOpen();
    this.initConversation();
    this.loadCurrentConversationId();
  }

  /**
   * Initialize a new conversation
   */
  private initConversation(): void {
    // Always default to agent mode for new conversations.
    this.currentMode = 'agent';
    this.currentConversation = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      messages: []
    };
  }

  /**
   * Start a fresh conversation (clears current and creates new ID)
   * Called by UI when user clicks "New Chat"
   */
  newConversation(): void {
    // Clear current state
    this.messages = [];
    this.activeToolCalls = [];
    this.pendingAttachments = [];
    this.inputValue = "";
    this.currentMode = 'agent';

    // Initialize fresh conversation
    this.currentConversation = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      messages: []
    };
    this.saveCurrentConversationId();
  }

  /**
   * Load a conversation from chat history
   * Restores messages and mode from persisted data
   */
  loadConversation(conversation: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    isPinned: boolean;
    mode: string;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      timestamp: number;
      metadata?: string;
    }>;
  }): void {
    // Clear current state
    this.activeToolCalls = [];
    this.pendingAttachments = [];
    this.inputValue = "";

    // Restore mode
    this.currentMode = (conversation.mode as AIMode) || 'agent';

    // Convert persisted messages to AssistantMessage format
    const restoredMessages: AssistantMessage[] = conversation.messages.map(msg => {
      const base: AssistantMessage = {
        id: msg.id,
        role: msg.role as MessageRole,
        content: msg.content,
        timestamp: msg.timestamp,
      };

      // Restore metadata (tool calls, attachments, etc.)
      if (msg.metadata) {
        try {
          const meta = JSON.parse(msg.metadata);
          if (meta.attachments) base.attachments = meta.attachments;
          if (meta.toolCalls) base.toolCalls = meta.toolCalls;
          if (meta.inlineToolCalls) base.inlineToolCalls = meta.inlineToolCalls;
          if (meta.contentParts) base.contentParts = meta.contentParts;
          if (meta.thinking) base.thinking = meta.thinking;
          if (meta.smartContextBlock) base.smartContextBlock = meta.smartContextBlock;
          if (meta.contextMentions) base.contextMentions = meta.contextMentions;
        } catch (e) {
          console.warn('[AssistantStore] Failed to parse message metadata:', e);
        }
      }

      // SELF-HEALING: Reconstruct contentParts if missing (fixes disappearing tools/thinking in history)
      if (!base.contentParts || base.contentParts.length === 0) {
        const parts: any[] = []; // Use any to avoid strict typing issues during manual construction

        // 1. Restore thinking
        if (base.thinking) {
          parts.push({
            type: 'thinking',
            thinking: base.thinking,
            startTime: base.timestamp,
            isActive: false, // History items are never active
            title: 'Thought'
          });
        }

        // 2. Restore text content
        if (base.content) {
          parts.push({ type: 'text', text: base.content });
        }

        // 3. Restore inline tool calls
        if (base.inlineToolCalls && base.inlineToolCalls.length > 0) {
          base.inlineToolCalls.forEach(tc => {
            parts.push({ type: 'tool', toolCall: tc });
          });
        }

        if (parts.length > 0) {
          base.contentParts = parts as ContentPart[];
        }
      }

      return base;
    });

    this.messages = restoredMessages;

    // Set current conversation
    this.currentConversation = {
      id: conversation.id,
      createdAt: conversation.createdAt,
      messages: restoredMessages
    };
  }

  /**
   * Get current mode capabilities
   */
  get modeCapabilities() {
    return MODE_CAPABILITIES[this.currentMode];
  }

  /**
   * Check if current mode allows file mutations
   */
  canMutateFiles(): boolean {
    return MODE_CAPABILITIES[this.currentMode].canMutateFiles;
  }

  /**
   * Check if current mode allows command execution
   */
  canExecuteCommands(): boolean {
    return MODE_CAPABILITIES[this.currentMode].canExecuteCommands;
  }

  /**
   * Check if current mode allows tool usage
   */
  canUseTools(): boolean {
    return MODE_CAPABILITIES[this.currentMode].canUseTools;
  }

  /**
   * Validate a tool call against current mode using the tool router
   * Returns error message if not allowed, null if allowed
   */
  validateToolCall(toolName: string, _args?: Record<string, unknown>): string | null {
    const tool = getToolByName(toolName);
    if (!tool) {
      return `Unknown tool: "${toolName}"`;
    }

    // Mode restrictions: use the centralized allowedModes list
    if (!tool.allowedModes.includes(this.currentMode)) {
      return `Tool "${toolName}" is not allowed in ${this.currentMode} mode.`;
    }

    // Capability restrictions (enforced in code, not just UI)
    const caps = MODE_CAPABILITIES[this.currentMode];
    if (tool.category === 'file_write' && !caps.canMutateFiles) {
      return `Tool "${toolName}" requires agent mode (file mutations).`;
    }
    if (tool.category === 'terminal' && !caps.canExecuteCommands) {
      return `Tool "${toolName}" requires agent mode (terminal access).`;
    }

    return null;
  }

  /**
   * Check if a tool requires user approval before execution
   */
  toolRequiresApproval(toolName: string): boolean {
    return doesToolRequireApproval(toolName);
  }

  // Panel controls
  togglePanel(): void {
    this.panelOpen = !this.panelOpen;
    this.savePanelOpen();
  }

  openPanel(): void {
    this.panelOpen = true;
    this.savePanelOpen();
  }

  closePanel(): void {
    this.panelOpen = false;
    this.savePanelOpen();
  }

  setPanelWidth(width: number): void {
    const clamped = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width));
    this.panelWidth = clamped;
    this.savePanelWidth();
  }

  // Mode controls
  setMode(mode: AIMode): void {
    this.currentMode = mode;
  }

  // History management
  addToHistory(value: string): void {
    if (!value.trim()) return;
    // Don't add duplicate consecutive entries
    if (this.inputHistory[this.inputHistory.length - 1] === value) return;
    this.inputHistory = [...this.inputHistory, value];
    this.historyIndex = -1;
    this.draftValue = "";
  }

  navigateHistory(direction: "up" | "down"): string | null {
    if (this.inputHistory.length === 0) return null;

    if (direction === "up") {
      // First time pressing up, save the current draft
      if (this.historyIndex === -1) {
        this.draftValue = this.inputValue;
        this.historyIndex = this.inputHistory.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex--;
      }
      return this.inputHistory[this.historyIndex];
    } else {
      // Down
      if (this.historyIndex === -1) return null;

      if (this.historyIndex < this.inputHistory.length - 1) {
        this.historyIndex++;
        return this.inputHistory[this.historyIndex];
      } else {
        // Returned to draft
        this.historyIndex = -1;
        return this.draftValue;
      }
    }
  }

  cycleMode(): void {
    const modes: AIMode[] = ['ask', 'plan', 'agent'];
    const currentIndex = modes.indexOf(this.currentMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    this.currentMode = modes[nextIndex];
  }

  // Message management
  addUserMessage(content: string, context?: AttachedContext[], smartContextBlock?: string): string {
    // Sanitize user input to remove excessive repetition
    const sanitizedContent = sanitizeUserInput(content);

    const id = crypto.randomUUID();
    const message: AssistantMessage = {
      id,
      role: 'user',
      content: sanitizedContent,
      timestamp: Date.now(),
      attachments: [...this.pendingAttachments], // Include pending attachments
      smartContextBlock
    };

    // Include context in message if provided
    if (context && context.length > 0) {
      // Store separately for UI rendering as clean chips
      message.contextMentions = [...context];

      // Prepare full content block for AI as "smart context"
      const fullContextBlock = context.map(c => {
        if (c.type === 'file') {
          return `[File: ${c.path}]\n\`\`\`\n${c.content}\n\`\`\``;
        }
        return `[Selection: ${c.label || 'Code'}]\n\`\`\`\n${c.content}\n\`\`\``;
      }).join('\n\n');

      message.smartContextBlock = (message.smartContextBlock ? message.smartContextBlock + '\n\n' : '') + fullContextBlock;
    }

    this.messages = [...this.messages, message];

    // Update conversation
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: [...this.currentConversation.messages, message]
      };
    }

    // Clear pending attachments after adding to message
    this.pendingAttachments = [];

    this.saveCurrentConversationId();

    return id;
  }

  addAssistantMessage(content: string, isStreaming = false): string {
    const id = crypto.randomUUID();
    const message: AssistantMessage = {
      id,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      isStreaming
    };
    this.messages = [...this.messages, message];

    // Update conversation
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: [...this.currentConversation.messages, message]
      };
    }

    this.saveCurrentConversationId();

    return id;
  }

  updateAssistantMessage(id: string, content: string, isStreaming = false): void {
    this.messages = this.messages.map(msg => {
      if (msg.id !== id) return msg;
      // Set endTime when streaming ends
      const endTime = !isStreaming && msg.isStreaming ? Date.now() : msg.endTime;
      return { ...msg, content, isStreaming, endTime };
    });

    // Also update in currentConversation
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.currentConversation.messages.map(msg => {
          if (msg.id !== id) return msg;
          const endTime = !isStreaming && msg.isStreaming ? Date.now() : msg.endTime;
          return { ...msg, content, isStreaming, endTime };
        })
      };
    }

    // Persist to database immediately
    this.persistMessageToHistory(id);
  }

  updateAssistantThinking(id: string, thinking: string, isThinking = true): void {
    const safeThinking = thinking.length > MAX_THINKING_CHARS
      ? thinking.slice(-MAX_THINKING_CHARS)
      : thinking;
    this.messages = this.messages.map(msg =>
      msg.id === id ? { ...msg, thinking: safeThinking, isThinking } : msg
    );

    // Persist to database immediately
    this.persistMessageToHistory(id);
  }

  addToolMessage(toolCall: ToolCall): string {
    const id = crypto.randomUUID();
    const message: AssistantMessage = {
      id,
      role: 'tool',
      content: toolCall.output ?? '',
      timestamp: Date.now(),
      toolCalls: [toolCall]
    };
    this.messages = [...this.messages, message];

    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: [...this.currentConversation.messages, message]
      };
    }

    this.saveCurrentConversationId();
    this.persistMessageToHistory(id);
    return id;
  }

  // Tool call management
  addToolCall(toolCall: ToolCall): void {
    this.activeToolCalls = [...this.activeToolCalls, toolCall];
  }

  updateToolCall(id: string, updates: Partial<ToolCall>): void {
    this.activeToolCalls = this.activeToolCalls.map(tc =>
      tc.id === id ? { ...tc, ...updates } : tc
    );
  }

  clearToolCalls(): void {
    this.activeToolCalls = [];
  }

  /**
   * Add a tool call to a specific assistant message (for inline display)
   */
  addToolCallToMessage(messageId: string, toolCall: ToolCall): void {
    this.messages = this.messages.map(msg => {
      if (msg.id !== messageId) return msg;
      const inlineToolCalls = [...(msg.inlineToolCalls || []), toolCall];
      const contentParts = [...(msg.contentParts || [])];
      contentParts.push({ type: "tool", toolCall });
      return { ...msg, inlineToolCalls, contentParts };
    });

    // Also update in currentConversation
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.currentConversation.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          const inlineToolCalls = [...(msg.inlineToolCalls || []), toolCall];
          const contentParts = [...(msg.contentParts || [])];
          contentParts.push({ type: "tool", toolCall });
          return { ...msg, inlineToolCalls, contentParts };
        }),
      };
    }

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }

  /**
   * Update a tool call within a message
   */
  updateToolCallInMessage(messageId: string, toolCallId: string, updates: Partial<ToolCall>): void {
    this.messages = this.messages.map(msg => {
      if (msg.id !== messageId) return msg;

      const inlineToolCalls = (msg.inlineToolCalls || []).map(tc =>
        tc.id === toolCallId ? { ...tc, ...updates } : tc,
      );

      const contentParts = (msg.contentParts || []).map(part => {
        if (part.type === "tool" && part.toolCall.id === toolCallId) {
          return {
            ...part,
            toolCall: { ...part.toolCall, ...updates },
          };
        }
        return part;
      });

      return { ...msg, inlineToolCalls, contentParts };
    });

    // Also update in currentConversation
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.currentConversation.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          const inlineToolCalls = (msg.inlineToolCalls || []).map(tc =>
            tc.id === toolCallId ? { ...tc, ...updates } : tc,
          );
          const contentParts = (msg.contentParts || []).map(part => {
            if (part.type === "tool" && part.toolCall.id === toolCallId) {
              return {
                ...part,
                toolCall: { ...part.toolCall, ...updates },
              };
            }
            return part;
          });
          return { ...msg, inlineToolCalls, contentParts };
        }),
      };
    }

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }

  /**
   * Helper to persist a specific message to history database
   */
  private async persistMessageToHistory(messageId: string): Promise<void> {
    const msg = this.messages.find(m => m.id === messageId);
    const convId = this.currentConversation?.id;
    if (!msg || !convId) return;

    try {
      const { chatHistoryStore } = await import('./chat-history.svelte');
      try {
        await chatHistoryStore.createConversation(convId, this.currentMode);
      } catch (createErr) {
        console.debug('[AssistantStore] Conversation may already exist:', createErr);
      }
      const metadata = JSON.stringify({
        attachments: msg.attachments,
        toolCalls: msg.toolCalls,
        inlineToolCalls: msg.inlineToolCalls,
        contentParts: msg.contentParts,
        thinking: msg.thinking,
        smartContextBlock: msg.smartContextBlock,
        contextMentions: msg.contextMentions
      });

      await chatHistoryStore.saveMessage(convId, {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        metadata
      });
    } catch (err) {
      console.error('[AssistantStore] Failed to persist message to history:', err);
    }
  }

  appendTextToMessage(messageId: string, text: string, isStreaming: boolean): void {
    this.messages = this.messages.map(msg => {
      if (msg.id === messageId) {
        const parts = msg.contentParts ?? [];
        const lastPart = parts[parts.length - 1];

        let newParts: ContentPart[];
        if (lastPart && lastPart.type === 'text') {
          newParts = [
            ...parts.slice(0, -1),
            { type: 'text' as const, text: lastPart.text + text }
          ];
        } else {
          newParts = [...parts, { type: 'text' as const, text }];
        }

        // Also update the legacy content field
        const fullContent = newParts
          .filter(p => p.type === 'text')
          .map(p => (p as { type: 'text'; text: string }).text)
          .join('');

        return { ...msg, contentParts: newParts, content: fullContent, isStreaming };
      }
      return msg;
    });

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }

  /**
   * Add or update thinking content in a message (for inline thinking like Cursor)
   * Creates a new thinking part if the last part isn't thinking, or appends to it
   */
  appendThinkingToMessage(messageId: string, thinking: string): void {
    this.messages = this.messages.map(msg => {
      if (msg.id === messageId) {
        const parts = msg.contentParts ?? [];
        const lastPart = parts[parts.length - 1];

        let newParts: ContentPart[];
        if (lastPart && lastPart.type === 'thinking' && lastPart.isActive) {
          // Append to existing active thinking part
          newParts = [
            ...parts.slice(0, -1),
            {
              type: 'thinking' as const,
              thinking: lastPart.thinking + thinking,
              startTime: lastPart.startTime,
              isActive: true
            }
          ];
        } else {
          // Create new thinking part
          newParts = [...parts, {
            type: 'thinking' as const,
            thinking,
            startTime: Date.now(),
            isActive: true
          }];
        }

        // Also update the legacy thinking field (for compatibility)
        const fullThinking = newParts
          .filter(p => p.type === 'thinking')
          .map(p => (p as { type: 'thinking'; thinking: string }).thinking)
          .join('\n\n');

        return {
          ...msg,
          contentParts: newParts,
          thinking: fullThinking,
          isThinking: true
        };
      }
      return msg;
    });

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }

  /**
   * End the current thinking part (set endTime and title)
   * Called when thinking ends or when a tool/text part is about to be added
   */
  endThinkingPart(messageId: string): void {
    this.messages = this.messages.map(msg => {
      if (msg.id === messageId) {
        const parts = msg.contentParts ?? [];

        const newParts = parts.map(part => {
          if (part.type === 'thinking' && part.isActive) {
            // Extract title from first line or first sentence of thinking
            const thinking = part.thinking;
            let title = '';

            // Try to extract a meaningful title from the thinking content
            const lines = thinking.split('\n').filter(l => l.trim());
            if (lines.length > 0) {
              // Take first line, limit to 60 chars
              title = lines[0].slice(0, 60);
              if (lines[0].length > 60) title += '...';
            }

            return {
              ...part,
              endTime: Date.now(),
              title: title || 'Reasoning',
              isActive: false
            };
          }
          return part;
        });

        return { ...msg, contentParts: newParts, isThinking: false };
      }
      return msg;
    });

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }

  /**
   * Finalize all thinking in a message (called when streaming ends)
   */
  finalizeThinking(messageId: string): void {
    this.endThinkingPart(messageId);
  }

  /**
   * Set the full text content for a message (replaces all text parts)
   */
  setMessageContent(messageId: string, content: string, isStreaming: boolean): void {
    this.messages = this.messages.map(msg => {
      if (msg.id === messageId) {
        // Preserve tool/text interleaving. We treat the message's full legacy `content`
        // as the concatenation of all text parts in `contentParts`.
        // If `contentParts` exists, keep tool parts in place and update only the last text part.
        const parts = msg.contentParts ?? [];
        const lastTextIndex = [...parts].reverse().findIndex(p => p.type === 'text');

        if (parts.length === 0) {
          return {
            ...msg,
            contentParts: content ? [{ type: 'text' as const, text: content }] : [],
            content,
            isStreaming
          };
        }

        if (lastTextIndex === -1) {
          // No existing text parts, append one at the end
          return {
            ...msg,
            contentParts: content ? [...parts, { type: 'text' as const, text: content }] : parts,
            content,
            isStreaming
          };
        }

        const idx = parts.length - 1 - lastTextIndex;
        const newParts = parts.map((p, i) => (i === idx && p.type === 'text') ? { type: 'text' as const, text: content } : p);
        return { ...msg, contentParts: newParts, content, isStreaming };
      }
      return msg;
    });
  }

  /**
   * Get the last assistant message ID (for adding tool calls)
   */
  getLastAssistantMessageId(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        return this.messages[i].id;
      }
    }
    return null;
  }

  // Context management (legacy)
  attachContext(context: AttachedContext): void {
    // Avoid duplicates
    const exists = this.attachedContext.some(
      c => c.type === context.type && c.path === context.path
    );
    if (!exists) {
      this.attachedContext = [...this.attachedContext, context];
    }
  }

  removeContext(index: number): void {
    this.attachedContext = this.attachedContext.filter((_, i) => i !== index);
  }

  clearContext(): void {
    this.attachedContext = [];
  }

  // New attachment model methods

  /**
   * Add a file attachment
   */
  attachFile(path: string, content: string, label?: string): { success: boolean; error?: string } {
    // Check for secrets
    if (isLikelySecretPath(path)) {
      return {
        success: false,
        error: `File "${path}" appears to contain secrets. Redacting sensitive content.`
      };
    }

    // Check limits
    if (this.pendingAttachments.filter(a => a.type === 'file').length >= CONTEXT_LIMITS.maxFilesPerMessage) {
      return { success: false, error: `Maximum ${CONTEXT_LIMITS.maxFilesPerMessage} files per message` };
    }

    // Avoid duplicates
    const exists = this.pendingAttachments.some(
      a => a.type === 'file' && (a as FileAttachment).path === path
    );
    if (exists) {
      return { success: false, error: 'File already attached' };
    }

    // Redact secrets from content
    const safeContent = redactSecrets(content);

    const attachment: FileAttachment = {
      id: crypto.randomUUID(),
      type: 'file',
      path,
      content: safeContent,
      label: label ?? path.split('/').pop() ?? path,
      checksum: generateChecksum(safeContent)
    };

    this.pendingAttachments = [...this.pendingAttachments, attachment];
    return { success: true };
  }

  /**
   * Add a selection attachment
   */
  attachSelection(content: string, path?: string, range?: SelectionRange): { success: boolean; error?: string } {
    if (!content.trim()) {
      return { success: false, error: 'Selection is empty' };
    }

    // Redact secrets
    const safeContent = redactSecrets(content);

    const attachment: SelectionAttachment = {
      id: crypto.randomUUID(),
      type: 'selection',
      path,
      content: safeContent,
      range,
      label: `Selection${path ? ` from ${path.split('/').pop()}` : ''}`,
      checksum: generateChecksum(safeContent)
    };

    this.pendingAttachments = [...this.pendingAttachments, attachment];
    return { success: true };
  }

  /**
   * Add a folder scope attachment
   */
  attachFolder(path: string): { success: boolean; error?: string } {
    // Avoid duplicates
    const exists = this.pendingAttachments.some(
      a => a.type === 'folder' && (a as FolderAttachment).path === path
    );
    if (exists) {
      return { success: false, error: 'Folder already attached' };
    }

    const attachment: FolderAttachment = {
      id: crypto.randomUUID(),
      type: 'folder',
      path,
      label: path.split('/').pop() ?? path
    };

    this.pendingAttachments = [...this.pendingAttachments, attachment];
    return { success: true };
  }

  /**
   * Add an image attachment (vision)
   */
  attachImage(
    filename: string,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
    base64Data: string,
    dimensions?: { width: number; height: number }
  ): { success: boolean; error?: string } {
    // Validate mime type
    if (!IMAGE_LIMITS.allowedMimeTypes.includes(mimeType)) {
      return { success: false, error: `Unsupported image type: ${mimeType}. Allowed: PNG, JPEG, WebP` };
    }

    // Calculate byte size from base64
    const byteSize = Math.ceil((base64Data.length * 3) / 4);

    // Check individual image size
    if (byteSize > IMAGE_LIMITS.maxImageBytes) {
      const maxMB = IMAGE_LIMITS.maxImageBytes / (1024 * 1024);
      return { success: false, error: `Image too large (${(byteSize / (1024 * 1024)).toFixed(1)}MB). Maximum: ${maxMB}MB` };
    }

    // Check image count
    const currentImages = this.pendingAttachments.filter(a => a.type === 'image') as ImageAttachment[];
    if (currentImages.length >= IMAGE_LIMITS.maxImagesPerMessage) {
      return { success: false, error: `Maximum ${IMAGE_LIMITS.maxImagesPerMessage} images per message` };
    }

    // Check total size
    const currentTotalSize = currentImages.reduce((sum, img) => sum + img.byteSize, 0);
    if (currentTotalSize + byteSize > IMAGE_LIMITS.maxTotalImageBytesPerMessage) {
      const maxMB = IMAGE_LIMITS.maxTotalImageBytesPerMessage / (1024 * 1024);
      return { success: false, error: `Total image size would exceed ${maxMB}MB limit` };
    }

    const attachment: ImageAttachment = {
      id: crypto.randomUUID(),
      type: 'image',
      filename,
      mimeType,
      data: base64Data,
      byteSize,
      dimensions,
      label: filename,
      checksum: generateChecksum(base64Data.slice(0, 1000)) // Only hash first 1000 chars for perf
    };

    this.pendingAttachments = [...this.pendingAttachments, attachment];
    return { success: true };
  }

  /**
   * Add a browser element attachment (shown as chip, context hidden)
   */
  attachElement(element: {
    tagName: string;
    id?: string;
    classes: string[];
    html: string;
    css: Record<string, string>;
    rect: { x: number; y: number; width: number; height: number };
    selector: string;
  }): { success: boolean; error?: string } {
    // Remove any existing element attachment (only one at a time)
    this.pendingAttachments = this.pendingAttachments.filter(a => a.type !== 'element');

    const label = element.id
      ? `<${element.tagName}#${element.id}>`
      : element.classes.length > 0
        ? `<${element.tagName}.${element.classes[0]}>`
        : `<${element.tagName}>`;

    const attachment: ElementAttachment = {
      id: crypto.randomUUID(),
      type: 'element',
      tagName: element.tagName,
      selector: element.selector,
      html: element.html.slice(0, 3000), // Limit HTML size
      css: element.css,
      rect: element.rect,
      label,
    };

    this.pendingAttachments = [...this.pendingAttachments, attachment];
    return { success: true };
  }

  /**
   * Remove a pending attachment by ID
   */
  removeAttachment(id: string): void {
    this.pendingAttachments = this.pendingAttachments.filter(a => a.id !== id);
  }

  /**
   * Clear all pending attachments
   */
  clearAttachments(): void {
    this.pendingAttachments = [];
  }

  /**
   * Get attachment preview info (for UI display)
   */
  getAttachmentPreviews(): Array<{
    id: string;
    type: MessageAttachment['type'];
    label: string;
    size?: string;
    dimensions?: string;
    isImage: boolean;
    thumbnailData?: string;
  }> {
    return this.pendingAttachments.map(a => {
      const base = {
        id: a.id,
        type: a.type,
        label: a.label,
        isImage: a.type === 'image'
      };

      if (a.type === 'image') {
        const img = a as ImageAttachment;
        return {
          ...base,
          size: `${(img.byteSize / 1024).toFixed(1)}KB`,
          dimensions: img.dimensions ? `${img.dimensions.width}×${img.dimensions.height}` : undefined,
          thumbnailData: img.data // For preview
        };
      }

      if (a.type === 'file' || a.type === 'selection') {
        const content = (a as FileAttachment | SelectionAttachment).content;
        return {
          ...base,
          size: `${content.length} chars`
        };
      }

      if (a.type === 'element') {
        const el = a as ElementAttachment;
        return {
          ...base,
          size: `${Math.round(el.rect.width)}×${Math.round(el.rect.height)}`
        };
      }

      return base;
    });
  }

  /**
   * Get total context size for current attachments
   */
  getTotalContextSize(): number {
    return this.pendingAttachments.reduce((total, a) => {
      if (a.type === 'file' || a.type === 'selection') {
        return total + (a as FileAttachment | SelectionAttachment).content.length;
      }
      if (a.type === 'image') {
        return total + (a as ImageAttachment).byteSize;
      }
      return total;
    }, 0);
  }

  /**
   * Check if context size is within limits
   */
  isContextWithinLimits(): boolean {
    const textSize = this.pendingAttachments
      .filter(a => a.type === 'file' || a.type === 'selection')
      .reduce((sum, a) => sum + (a as FileAttachment | SelectionAttachment).content.length, 0);

    return textSize <= CONTEXT_LIMITS.maxContextSize;
  }

  /**
   * Estimate token count from character count (uses accurate token counter)
   */
  estimateTokens(charCount: number, contentType: ContentType = 'mixed'): number {
    return countTokens('x'.repeat(charCount), contentType);
  }

  /**
   * Get accurate token count for the entire conversation
   * Uses content-aware token counting (code vs prose vs mixed)
   */
  getConversationTokens(): number {
    const messagesForCount = this.messages.map(msg => ({
      content: msg.content + (msg.thinking ? `\n${msg.thinking}` : ''),
      attachments: msg.attachments?.map(a => {
        if (a.type === 'file' || a.type === 'selection') {
          return { type: a.type, content: (a as FileAttachment | SelectionAttachment).content };
        }
        if (a.type === 'image') {
          return { type: a.type, data: (a as ImageAttachment).data };
        }
        return { type: a.type };
      })
    }));

    const pendingAtts = this.pendingAttachments.map(a => {
      if (a.type === 'file' || a.type === 'selection') {
        return { type: a.type, content: (a as FileAttachment | SelectionAttachment).content };
      }
      if (a.type === 'image') {
        return { type: a.type, data: (a as ImageAttachment).data };
      }
      return { type: a.type };
    });

    return countConversationTokens(messagesForCount, this.inputValue, pendingAtts);
  }

  /**
   * Get total conversation context size in characters (legacy, for compatibility)
   * Includes all messages + pending attachments + input
   */
  getConversationContextChars(): number {
    let total = 0;

    for (const msg of this.messages) {
      total += msg.content.length;
      if (msg.thinking) {
        total += msg.thinking.length;
      }
      if (msg.attachments) {
        for (const a of msg.attachments) {
          if (a.type === 'file' || a.type === 'selection') {
            total += (a as FileAttachment | SelectionAttachment).content.length;
          }
          if (a.type === 'image') {
            total += (a as ImageAttachment).data.length;
          }
        }
      }
    }

    total += this.getTotalContextSize();
    total += this.inputValue.length;

    return total;
  }

  /**
   * Get context usage info for UI display (uses accurate token counting)
   */
  getContextUsage(model = 'gemini-2.5-flash'): {
    usedTokens: number;
    maxTokens: number;
    usedChars: number;
    percentage: number;
    isNearLimit: boolean;
    isOverLimit: boolean;
  } {
    const modelConfig = getModelConfig(model);

    let maxTokens: number;
    if (modelConfig) {
      maxTokens = modelConfig.contextWindow;
    } else {
      const normalizedModel = model
        .replace(/\|thinking$/g, '')
        .replace(/^models\//g, '');
      const limits = MODEL_CONTEXT_LIMITS[normalizedModel] ?? DEFAULT_CONTEXT_LIMIT;
      maxTokens = limits.inputTokens;
    }

    const usedChars = this.getConversationContextChars();
    const usedTokens = this.getConversationTokens(); // Use accurate counting
    const percentage = Math.min(100, (usedTokens / maxTokens) * 100);

    return {
      usedTokens,
      maxTokens,
      usedChars,
      percentage,
      isNearLimit: percentage > 80,
      isOverLimit: percentage >= 100
    };
  }

  /**
   * Format token count for display (e.g., "1.2M", "500K", "1,234")
   */
  formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(1)}M`;
    }
    if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(0)}K`;
    }
    return tokens.toLocaleString();
  }

  // Streaming controls
  startStreaming(): AbortController {
    const controller = new AbortController();
    this.abortController = controller;
    this.isStreaming = true;
    return controller;
  }

  stopStreaming(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isStreaming = false;

    // Mark any streaming messages as complete
    this.messages = this.messages.map(msg =>
      msg.isStreaming ? { ...msg, isStreaming: false } : msg
    );

    // Cancel any running tool calls
    this.activeToolCalls = this.activeToolCalls.map(tc =>
      tc.status === 'running' || tc.status === 'pending'
        ? { ...tc, status: 'cancelled' as ToolCallStatus, endTime: Date.now() }
        : tc
    );
  }

  // Clear conversation
  clearConversation(): void {
    this.messages = [];
    this.activeToolCalls = [];
    this.inputValue = '';
    this.attachedContext = [];
    this.pendingAttachments = [];
    this.initConversation();
  }

  // Input management
  setInputValue(value: string): void {
    this.inputValue = value;
  }

  // Helper to format message with context
  // This creates a USER-FACING version with just labels (not full content)
  // The full context is passed to the AI separately via the attachments
  private formatMessageWithContext(content: string, context: AttachedContext[]): string {
    if (context.length === 0) return content;

    // Show only labels/references to user, not full content
    const contextLabels = context.map(c => {
      if (c.type === 'file') {
        return `📎 ${c.label}`;
      }
      return `📎 ${c.label || 'Selection'}`;
    });

    // Prepend context labels as a clean summary
    return `${contextLabels.join(' | ')}\n\n${content}`;
  }

  // Persistence
  private loadPanelWidth(): void {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(PANEL_WIDTH_KEY);
      if (stored) {
        const width = parseInt(stored, 10);
        if (!isNaN(width)) {
          this.panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width));
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  private savePanelWidth(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(this.panelWidth));
    } catch {
      // Ignore storage errors
    }
  }

  private loadPanelOpen(): void {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(PANEL_OPEN_KEY);
      if (stored !== null) {
        this.panelOpen = stored === 'true';
      }
    } catch {
      // Ignore storage errors
    }
  }

  private savePanelOpen(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(PANEL_OPEN_KEY, String(this.panelOpen));
    } catch {
      // Ignore storage errors
    }
  }

  private loadCurrentConversationId(): void {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(CURRENT_CONV_ID_KEY);
      if (stored) {
        // We'll need to fetch the actual conversation from the DB
        // For now, we at least know what the ID was
        void this.restoreLastConversation(stored);
      }
    } catch {
      // Ignore storage errors
    }
  }

  private saveCurrentConversationId(): void {
    if (typeof window === 'undefined') return;
    try {
      if (this.currentConversation) {
        localStorage.setItem(CURRENT_CONV_ID_KEY, this.currentConversation.id);
      }
    } catch {
      // Ignore storage errors
    }
  }

  private async restoreLastConversation(id: string): Promise<void> {
    try {
      const lastConvId = localStorage.getItem(CURRENT_CONV_ID_KEY);
      if (lastConvId && lastConvId !== "undefined") {
        try {
          const conv = await invoke<Conversation>("chat_get_conversation", {
            conversationId: lastConvId,
          });
          if (conv) {
            this.currentConversation = {
              id: conv.id,
              createdAt: conv.createdAt || Date.now(),
              messages: conv.messages
            };
            this.messages = conv.messages;
          }
        } catch (err) {
          console.warn("[AssistantStore] Failed to restore last conversation:", err);
          localStorage.removeItem(CURRENT_CONV_ID_KEY);
        }
      }
    } catch (err) {
      console.warn('[AssistantStore] Failed to restore last conversation:', err);
    }
  }

  /**
   * Get metadata about what would happen if we revert to a specific message
   * Returns a list of files and their predicted diff stats
   */
  async getRevertMetadata(messageId: string): Promise<Array<{
    path: string;
    name: string;
    isNewFile: boolean;
    isDeletion: boolean;
    isRename: boolean;
    addedLines: number;
    removedLines: number;
  }>> {
    const index = this.messages.findIndex(m => m.id === messageId);
    if (index === -1) return [];

    const filesToRevert = new Map<string, { before: string | null; isNew: boolean }>();
    const renames = new Map<string, string>(); // newPath -> oldPath

    // 1. Traverse backward to find the state to revert to
    for (let i = this.messages.length - 1; i >= index; i--) {
      const msg = this.messages[i];
      const toolCalls = [
        ...(msg.toolCalls || []),
        ...(msg.inlineToolCalls || []),
        ...(msg.contentParts?.filter(p => p.type === 'tool').map((p: any) => p.toolCall) || [])
      ];

      for (const tc of toolCalls) {
        if (!tc || tc.status !== 'completed' || !tc.meta) continue;

        if (tc.meta.fileEdit) {
          const { absolutePath, beforeContent, isNewFile } = tc.meta.fileEdit as any;
          if (!filesToRevert.has(absolutePath)) {
            filesToRevert.set(absolutePath, { before: isNewFile ? null : beforeContent, isNew: isNewFile === true });
          }
        }

        if (tc.meta.fileDeleted) {
          const { absolutePath, beforeContent, isDirectory } = tc.meta.fileDeleted as any;
          if (!isDirectory && beforeContent !== null && !filesToRevert.has(absolutePath)) {
            filesToRevert.set(absolutePath, { before: beforeContent, isNew: false });
          }
        }

        if (tc.meta.pathRenamed) {
          const { oldAbsolutePath, newAbsolutePath } = tc.meta.pathRenamed as any;
          renames.set(newAbsolutePath, oldAbsolutePath);
        }
      }
    }

    // 2. Format results and calculate rough diffs
    const results = [];
    const { readFile } = await import('$lib/services/file-system');

    for (const [path, { before, isNew }] of filesToRevert.entries()) {
      const name = path.split(/[/\\]/).pop() || path;
      let addedLines = 0;
      let removedLines = 0;

      if (isNew) {
        // Find current line count to show as removal
        try {
          const currentContent = await readFile(path);
          removedLines = currentContent ? currentContent.split('\n').length : 0;
        } catch { }
      } else if (before !== null) {
        try {
          const currentContent = await readFile(path);
          if (currentContent !== null) {
            const beforeLines = before.split('\n');
            const currentLines = currentContent.split('\n');

            const diff = beforeLines.length - currentLines.length;
            if (diff > 0) addedLines = diff;
            else removedLines = Math.abs(diff);

            if (addedLines === 0 && removedLines === 0 && before !== currentContent) {
              addedLines = 1;
              removedLines = 1;
            }
          }
        } catch { }
      } else {
        // This shouldn't happen with the current tool meta structure
        // but if it does, it's a no-op modification
      }

      results.push({
        path,
        name,
        isNewFile: isNew,
        isDeletion: before === null && !isNew, // This case is actually handled by isNew mostly
        isRename: false,
        addedLines,
        removedLines
      });
    }

    for (const [newPath, oldPath] of renames.entries()) {
      results.push({
        path: newPath,
        name: `${oldPath.split(/[/\\]/).pop()} (Renamed back from ${newPath.split(/[/\\]/).pop()})`,
        isNewFile: false,
        isDeletion: false,
        isRename: true,
        addedLines: 0,
        removedLines: 0
      });
    }

    return results;
  }

  /**
   * Revert conversation to a specific user message
   * Reverts file changes, restores input, and removes subsequent messages
   */
  async revertToMessage(messageId: string): Promise<void> {
    const index = this.messages.findIndex(m => m.id === messageId);
    if (index === -1) return;

    // 1. Identify all messages to be removed
    // We want to revert all changes made by AI *after* this user message
    const filesToRevert = new Map<string, string | null>(); // path -> content (null means delete)
    const filesToRenameBack = [] as Array<{ newPath: string; oldPath: string }>;
    const messagesToTruncate = this.messages.slice(index);

    // Iterate from latest to messageId (backward for correct undo order)
    for (let i = this.messages.length - 1; i >= index; i--) {
      const msg = this.messages[i];
      // Check all possible tool call locations
      const toolCalls = [
        ...(msg.toolCalls || []),
        ...(msg.inlineToolCalls || []),
        ...(msg.contentParts?.filter(p => p.type === 'tool').map((p: any) => p.toolCall) || [])
      ];

      for (const tc of toolCalls) {
        if (!tc || tc.status !== 'completed' || !tc.meta) continue;

        // Handle file write/edit
        if (tc.meta.fileEdit) {
          const { absolutePath, beforeContent, isNewFile } = tc.meta.fileEdit as any;
          // Chronologically first "beforeContent" (encountered last in backward loop) wins.
          // If isNewFile is true, we want to delete the file on revert.
          filesToRevert.set(absolutePath, isNewFile === true ? null : beforeContent);
        }

        // Handle file deletion
        if (tc.meta.fileDeleted) {
          const { absolutePath, beforeContent, isDirectory } = tc.meta.fileDeleted as any;
          if (!isDirectory && beforeContent !== null) {
            filesToRevert.set(absolutePath, beforeContent);
          }
        }

        // Handle renames
        if (tc.meta.pathRenamed) {
          const { oldAbsolutePath, newAbsolutePath } = tc.meta.pathRenamed as any;
          filesToRenameBack.push({ newPath: newAbsolutePath, oldPath: oldAbsolutePath });
        }
      }
    }

    // 2. Perform physical revert
    try {
      // De-rename first (reverse order)
      for (const { newPath, oldPath } of filesToRenameBack) {
        try {
          await invoke('rename_path', { oldPath: newPath, newPath: oldPath });
        } catch (e) {
          console.warn(`[Revert] Failed to rename ${newPath} back to ${oldPath}:`, e);
        }
      }

      // Restore contents
      for (const [path, content] of filesToRevert) {
        try {
          if (content === null) {
            await invoke('delete_path', { path });
          } else {
            await invoke('write_file', { path, content });
          }
        } catch (e) {
          console.error(`[Revert] Failed for ${path}:`, e);
        }
      }

      // Sync editor state
      const { editorStore } = await import('./editor.svelte');

      // 1. Sync renames
      for (const { newPath, oldPath } of filesToRenameBack) {
        await editorStore.renameFile(newPath, oldPath);
      }

      // 2. Sync content restorations and deletions
      for (const [path, content] of filesToRevert) {
        if (content === null) {
          // It was a new file produced by the AI, so we just deleted it. Close tab if open.
          editorStore.closeFile(path, true);
        } else {
          // It was an edit, reload the restored content.
          await editorStore.reloadFile(path);
        }
      }

      // Refresh tree
      const { projectStore } = await import('./project.svelte');
      await projectStore.refreshTree();
    } catch (err) {
      console.error('[AssistantStore] Revert failed:', err);
      const { showToast } = await import('./toast.svelte');
      showToast({ message: 'Failed to revert some file changes', type: 'error' });
    }

    // 3. Restore user message text and context to input (as a draft)
    const userMsg = this.messages[index];
    if (userMsg.role === 'user') {
      this.inputValue = userMsg.content;

      // Restore attached context so the user can easily refine/resend
      if (userMsg.contextMentions) {
        this.attachedContext = [...userMsg.contextMentions];
      }
      if (userMsg.attachments) {
        this.pendingAttachments = [...userMsg.attachments];
      }
    }

    // 4. Truncate in-memory history
    this.messages = this.messages.slice(0, index);

    // 5. Truncate persistent history
    if (this.currentConversation) {
      try {
        await invoke('chat_truncate_conversation', {
          conversationId: this.currentConversation.id,
          messageId
        });
      } catch (err) {
        console.error('[AssistantStore] Failed to truncate history:', err);
      }
    }

    const { showToast } = await import('./toast.svelte');
    showToast({ message: 'Reverted conversation', type: 'info' });
  }
}

// Singleton instance
export const assistantStore = new AssistantStore();

// Export constants for use in components
export { MIN_PANEL_WIDTH, MAX_PANEL_WIDTH };

// Export utility functions
export { generateChecksum, isLikelySecretPath, redactSecrets };
