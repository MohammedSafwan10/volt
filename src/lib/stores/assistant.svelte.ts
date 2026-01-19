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

// Rough estimate: ~4 characters per token (conservative for code)
const CHARS_PER_TOKEN = 4;

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
    this.initConversation();
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
  }

  openPanel(): void {
    this.panelOpen = true;
  }

  closePanel(): void {
    this.panelOpen = false;
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

    // Include context in message if provided (legacy support)
    if (context && context.length > 0) {
      message.content = this.formatMessageWithContext(sanitizedContent, context);
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
    return id;
  }

  updateAssistantMessage(id: string, content: string, isStreaming = false): void {
    this.messages = this.messages.map(msg => {
      if (msg.id !== id) return msg;
      // Set endTime when streaming ends
      const endTime = !isStreaming && msg.isStreaming ? Date.now() : msg.endTime;
      return { ...msg, content, isStreaming, endTime };
    });
  }

  updateAssistantThinking(id: string, thinking: string, isThinking = true): void {
    const safeThinking = thinking.length > MAX_THINKING_CHARS
      ? thinking.slice(-MAX_THINKING_CHARS)
      : thinking;
    this.messages = this.messages.map(msg =>
      msg.id === id ? { ...msg, thinking: safeThinking, isThinking } : msg
    );
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
      if (msg.id === messageId) {
        const existing = msg.inlineToolCalls ?? [];
        const existingParts = msg.contentParts ?? [];
        return {
          ...msg,
          inlineToolCalls: [...existing, toolCall],
          // Add tool to content parts for interleaved rendering
          contentParts: [...existingParts, { type: 'tool' as const, toolCall }]
        };
      }
      return msg;
    });
  }

  /**
   * Update a tool call within a message
   */
  updateToolCallInMessage(messageId: string, toolCallId: string, updates: Partial<ToolCall>): void {
    this.messages = this.messages.map(msg => {
      if (msg.id === messageId) {
        // Update in inlineToolCalls
        const updatedInline = msg.inlineToolCalls?.map(tc =>
          tc.id === toolCallId ? { ...tc, ...updates } : tc
        );
        // Update in contentParts
        const updatedParts = msg.contentParts?.map(part => {
          if (part.type === 'tool' && part.toolCall.id === toolCallId) {
            return { ...part, toolCall: { ...part.toolCall, ...updates } };
          }
          return part;
        });
        return {
          ...msg,
          inlineToolCalls: updatedInline,
          contentParts: updatedParts
        };
      }
      return msg;
    });
  }

  /**
   * Add or update text content in a message (for interleaved rendering)
   * This appends text to the last text part or creates a new one
   */
  appendTextToMessage(messageId: string, text: string, isStreaming: boolean): void {
    this.messages = this.messages.map(msg => {
      if (msg.id === messageId) {
        const parts = msg.contentParts ?? [];
        const lastPart = parts[parts.length - 1];

        let newParts: ContentPart[];
        if (lastPart && lastPart.type === 'text') {
          // Append to existing text part
          newParts = [
            ...parts.slice(0, -1),
            { type: 'text' as const, text: lastPart.text + text }
          ];
        } else {
          // Create new text part
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

        return { ...msg, contentParts: newParts, thinking: fullThinking, isThinking: true };
      }
      return msg;
    });
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
   * Estimate token count from character count
   */
  estimateTokens(charCount: number): number {
    return Math.ceil(charCount / CHARS_PER_TOKEN);
  }

  /**
   * Get total conversation context size in characters
   * Includes all messages + pending attachments + input
   */
  getConversationContextChars(): number {
    let total = 0;

    // Count all messages
    for (const msg of this.messages) {
      total += msg.content.length;

      // Count thinking content if present
      if (msg.thinking) {
        total += msg.thinking.length;
      }

      // Count attachments in messages
      if (msg.attachments) {
        for (const a of msg.attachments) {
          if (a.type === 'file' || a.type === 'selection') {
            total += (a as FileAttachment | SelectionAttachment).content.length;
          }
          // Images are counted differently (base64 is ~1.33x the byte size)
          if (a.type === 'image') {
            total += (a as ImageAttachment).data.length;
          }
        }
      }
    }

    // Add pending attachments
    total += this.getTotalContextSize();

    // Add current input
    total += this.inputValue.length;

    return total;
  }

  /**
   * Get context usage info for UI display
   */
  getContextUsage(model = 'gemini-2.5-flash'): {
    usedTokens: number;
    maxTokens: number;
    usedChars: number;
    percentage: number;
    isNearLimit: boolean;
    isOverLimit: boolean;
  } {
    // Try model registry first, then fall back to old limits
    const modelConfig = getModelConfig(model);

    let maxTokens: number;
    if (modelConfig) {
      maxTokens = modelConfig.contextWindow;
    } else {
      // Fallback to old method
      const normalizedModel = model
        .replace(/\|thinking$/g, '')
        .replace(/^models\//g, '');
      const limits = MODEL_CONTEXT_LIMITS[normalizedModel] ?? DEFAULT_CONTEXT_LIMIT;
      maxTokens = limits.inputTokens;
    }

    const usedChars = this.getConversationContextChars();
    const usedTokens = this.estimateTokens(usedChars);
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
  private formatMessageWithContext(content: string, context: AttachedContext[]): string {
    if (context.length === 0) return content;

    const contextParts = context.map(c => {
      if (c.type === 'file') {
        return `[File: ${c.path}]\n\`\`\`\n${c.content}\n\`\`\``;
      }
      return `[Selection]\n\`\`\`\n${c.content}\n\`\`\``;
    });

    return `${contextParts.join('\n\n')}\n\n${content}`;
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
}

// Singleton instance
export const assistantStore = new AssistantStore();

// Export constants for use in components
export { MIN_PANEL_WIDTH, MAX_PANEL_WIDTH };

// Export utility functions
export { generateChecksum, isLikelySecretPath, redactSecrets };
