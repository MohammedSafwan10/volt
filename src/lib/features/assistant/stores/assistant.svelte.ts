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
import { doesToolRequireApproval, getToolByName } from '$core/ai/tools/definitions';
import type { ContentType } from '$core/services/token-counter';
import { readFile } from '$core/services/file-system';
import { invoke } from '@tauri-apps/api/core';
import { fileService } from '$core/services/file-service';
import { terminalStore } from '$features/terminal/stores/terminal.svelte';
import { projectStore } from '$shared/stores/project.svelte';
import { editorStore } from '$features/editor/stores/editor.svelte';
import { chatHistoryStore } from './chat-history.svelte';
import { agentTelemetryStore } from './agent-telemetry.svelte';
import {
  isValidLoopTransition,
  type AgentLoopState,
} from './assistant/loop-state';
import {
  estimateTokensFromChars,
  generateChecksum,
  isLikelySecretPath,
  redactSecrets,
  sanitizeUserInput,
} from './assistant/utils';
import {
  CONTEXT_LIMITS,
  IMAGE_LIMITS,
  MODE_CAPABILITIES,
} from './assistant/config';
import {
  formatTokenCount,
  getAttachmentPreviews,
  getContextUsage,
  getConversationContextChars,
  getConversationTokens,
  getTotalContextSize,
  isContextWithinLimits,
  type ContextUsage,
} from './assistant/context-utils';

// Message roles
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

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
  // System summary marker (for auto-summary)
  isSummary?: boolean;
  // Reference context block (hidden from UI, sent to provider)
  smartContextBlock?: string;
  // User-selected mentions from @ menu (shown as chips)
  contextMentions?: AttachedContext[];
  // Streaming lifecycle truthfulness for partial/failed streams
  streamState?: 'active' | 'completed' | 'interrupted' | 'cancelled' | 'failed';
  streamIssue?: string;
}

// Conversation container
export interface Conversation {
  id: string;
  createdAt: number;
  title?: string;
  updatedAt?: number;
  isPinned?: boolean;
  mode?: string;
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

const MAX_THINKING_CHARS = 8000;
const MAX_IN_MEMORY_MESSAGES = 500;
const IN_MEMORY_KEEP_RECENT = 220;

// Panel width storage key
const PANEL_WIDTH_KEY = 'volt.assistant.panelWidth';
const PANEL_OPEN_KEY = 'volt.assistant.panelOpen';
const BROWSER_TOOLS_ENABLED_KEY = 'volt.assistant.browserToolsEnabled';
const CURRENT_CONV_ID_KEY = 'volt.assistant.currentConversationId';
const DEFAULT_PANEL_WIDTH = 400;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 800;

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
  inputHistory = $state<Array<{ content: string; attachments: MessageAttachment[] }>>([]);
  historyIndex = $state(-1); // -1 means current draft
  draftValue = $state(""); // Stores what the user was typing before navigating history
  draftAttachments = $state<MessageAttachment[]>([]);

  // New attachment model
  pendingAttachments = $state<MessageAttachment[]>([]);

  // Streaming state
  isStreaming = $state(false);
  abortController = $state<AbortController | null>(null);
  agentLoopState = $state<AgentLoopState>('completed');
  agentLoopMeta = $state<Record<string, unknown>>({});

  // Current tool calls being displayed
  activeToolCalls = $state<ToolCall[]>([]);
  browserToolsEnabled = $state(false);

  constructor() {
    this.loadPanelWidth();
    this.loadPanelOpen();
    this.loadBrowserToolsEnabled();
    this.initConversation();
    this.loadCurrentConversationId();
  }

  private enforceInMemoryBudget(): void {
    if (this.messages.length <= MAX_IN_MEMORY_MESSAGES) return;

    const summary = this.messages.find((m) => m.role === 'system' && m.isSummary);
    const nonSummary = this.messages.filter(
      (m) => !(m.role === 'system' && m.isSummary)
    );
    const keepTail = nonSummary.slice(-IN_MEMORY_KEEP_RECENT);
    this.messages = summary ? [summary, ...keepTail] : keepTail;

    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.messages,
      };
    }
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
    const newId = crypto.randomUUID();
    this.currentConversation = {
      id: newId,
      createdAt: Date.now(),
      messages: []
    };
    this.saveCurrentConversationId();

    // Immediately notify chat history store of the new active ID.
    // The conversation will be persisted when the first message is sent.
    chatHistoryStore.activeConversationId = newId;
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
          if (meta.isSummary) base.isSummary = true;
          // Only restore contentParts if it's a non-empty array
          if (meta.contentParts && Array.isArray(meta.contentParts) && meta.contentParts.length > 0) {
            base.contentParts = meta.contentParts;
          }
          if (meta.thinking) base.thinking = meta.thinking;
          if (meta.smartContextBlock) base.smartContextBlock = meta.smartContextBlock;
          if (meta.contextMentions) base.contextMentions = meta.contextMentions;
          if (meta.streamState) base.streamState = meta.streamState;
          if (meta.streamIssue) base.streamIssue = meta.streamIssue;
        } catch (e) {
          console.warn('[AssistantStore] Failed to parse message metadata:', e);
        }
      }

      // If contentParts was restored from metadata, use it directly (already has correct order)
      // Only call normalizeContentParts if we need to ensure text exists
      if (base.contentParts && base.contentParts.length > 0) {
        // Never restore active thinking state from persisted history.
        // Active thinking is runtime-only and can get stuck after crashes/restarts.
        base.contentParts = base.contentParts.map((part) =>
          part.type === 'thinking' ? { ...part, isActive: false } : part
        );

        // Already have properly ordered contentParts - don't normalize, just ensure text is included
        const hasTextPart = base.contentParts.some(p => p.type === 'text');
        if (!hasTextPart && base.content) {
          // Keep tool-first chronology: append summary text after tool parts.
          base.contentParts = [...base.contentParts, { type: 'text', text: base.content }];
        }

        // Ensure inline tool calls have stable text offsets for future rebuilds
        if (base.inlineToolCalls && base.inlineToolCalls.length > 0) {
          let textOffset = 0;
          const offsets = new Map<string, number>();
          for (const part of base.contentParts) {
            if (part.type === 'text') {
              textOffset += part.text.length;
            } else if (part.type === 'tool') {
              offsets.set(part.toolCall.id, textOffset);
            }
          }

          base.inlineToolCalls = base.inlineToolCalls.map(tc => ({
            ...tc,
            meta: {
              ...(tc.meta || {}),
              textOffset:
                typeof (tc.meta as any)?.textOffset === 'number'
                  ? (tc.meta as any).textOffset
                  : (offsets.get(tc.id) ?? (base.content?.length ?? 0))
            }
          }));

          base.contentParts = base.contentParts.map(part => {
            if (part.type !== 'tool') return part;
            const existingOffset = (part.toolCall.meta as any)?.textOffset;
            const computedOffset = offsets.get(part.toolCall.id);
            if (typeof existingOffset === 'number') return part;
            if (typeof computedOffset !== 'number') return part;
            return {
              ...part,
              toolCall: {
                ...part.toolCall,
                meta: {
                  ...(part.toolCall.meta || {}),
                  textOffset: computedOffset
                }
              }
            };
          });
        }
      } else {
        // SELF-HEALING: Reconstruct contentParts if missing (fallback for old data)
        const parts: any[] = [];

        // 1. Restore thinking first (always at the start)
        if (base.thinking) {
          parts.push({
            type: 'thinking',
            thinking: base.thinking,
            startTime: base.timestamp,
            isActive: false,
            title: 'Thought'
          });
        }

        // 2. Interleave text and tool calls using textOffset
        if (base.inlineToolCalls && base.inlineToolCalls.length > 0 && base.content) {
          // Sort tool calls by textOffset to get proper interleaving
          const sortedCalls = [...base.inlineToolCalls].sort((a, b) => {
            const offsetA = (a.meta as any)?.textOffset ?? Infinity;
            const offsetB = (b.meta as any)?.textOffset ?? Infinity;
            return offsetA - offsetB;
          });

          let lastOffset = 0;
          for (const tc of sortedCalls) {
            const offset = (tc.meta as any)?.textOffset ?? base.content.length;

            // Add text segment before this tool
            if (offset > lastOffset) {
              const textSegment = base.content.slice(lastOffset, offset);
              if (textSegment) {
                parts.push({ type: 'text', text: textSegment });
              }
            }

            // Add tool call
            parts.push({ type: 'tool', toolCall: tc });
            lastOffset = offset;
          }

          // Add remaining text after last tool
          if (lastOffset < base.content.length) {
            const remainingText = base.content.slice(lastOffset);
            if (remainingText) {
              parts.push({ type: 'text', text: remainingText });
            }
          }
        } else if (base.content) {
          // No tool calls, just add text
          parts.push({ type: 'text', text: base.content });
        } else if (base.inlineToolCalls && base.inlineToolCalls.length > 0) {
          // Only tool calls, no text
          base.inlineToolCalls.forEach(tc => {
            parts.push({ type: 'tool', toolCall: tc });
          });
        }

        if (parts.length > 0) {
          base.contentParts = parts as ContentPart[];
        }
      }

      base.isThinking = false;
      base.isStreaming = false;

      return base;
    });

    this.messages = restoredMessages;
    this.enforceInMemoryBudget();

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

  setBrowserToolsEnabled(enabled: boolean): void {
    this.browserToolsEnabled = enabled;
    this.saveBrowserToolsEnabled();
  }

  toggleBrowserToolsEnabled(): void {
    this.setBrowserToolsEnabled(!this.browserToolsEnabled);
  }

  // Mode controls
  setMode(mode: AIMode): void {
    if (this.currentMode === mode) return;
    this.currentMode = mode;

    const convId = this.currentConversation?.id;
    if (!convId) return;

    // Persist mode so reload restores the same UX state (e.g. Plan CTA visibility).
    chatHistoryStore.updateMode(convId, mode).catch((err) => {
      console.warn('[AssistantStore] Failed to persist conversation mode:', err);
    });
  }

  // History management
  addToHistory(value: string, attachments: MessageAttachment[] = []): void {
    if (!value.trim()) return;
    // Don't add duplicate consecutive entries by content
    if (this.inputHistory[this.inputHistory.length - 1]?.content === value) return;
    this.inputHistory = [
      ...this.inputHistory,
      { content: value, attachments: [...attachments] },
    ];
    this.historyIndex = -1;
    this.draftValue = "";
    this.draftAttachments = [];
  }

  navigateHistory(
    direction: "up" | "down",
  ): { content: string; attachments: MessageAttachment[] } | null {
    if (this.inputHistory.length === 0) return null;

    if (direction === "up") {
      // First time pressing up, save the current draft
      if (this.historyIndex === -1) {
        this.draftValue = this.inputValue;
        this.draftAttachments = [...this.pendingAttachments];
        this.historyIndex = this.inputHistory.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex--;
      }
      return this.inputHistory[this.historyIndex] ?? null;
    } else {
      // Down
      if (this.historyIndex === -1) return null;

      if (this.historyIndex < this.inputHistory.length - 1) {
        this.historyIndex++;
        return this.inputHistory[this.historyIndex] ?? null;
      } else {
        // Returned to draft
        this.historyIndex = -1;
        return {
          content: this.draftValue,
          attachments: [...this.draftAttachments],
        };
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
    this.enforceInMemoryBudget();

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

  /**
   * Add a system message (used for conversation summaries)
   */
  addSystemMessage(content: string, isSummary = false): string {
    const id = crypto.randomUUID();
    const msg: AssistantMessage = {
      id,
      role: 'system',
      content,
      timestamp: Date.now(),
      isSummary
    };

    if (isSummary) {
      this.messages = [msg, ...this.messages];
    } else {
      this.messages = [...this.messages, msg];
    }
    this.enforceInMemoryBudget();

    if (this.currentConversation) {
      this.currentConversation.messages = this.messages;
    }

    return id;
  }

  /**
   * Create or update the conversation summary message
   */
  upsertSummaryMessage(content: string): string {
    const existing = this.messages.find(m => m.role === 'system' && m.isSummary);
    if (existing) {
      const updated = { ...existing, content, timestamp: Date.now(), isSummary: true };
      this.messages = this.messages.map(m => m.id === existing.id ? updated : m);
      if (this.currentConversation) {
        this.currentConversation.messages = this.messages;
      }
      return existing.id;
    }
    return this.addSystemMessage(content, true);
  }

  /**
   * Replace older messages with a summary + keep last N messages
   */
  summarizeConversation(summaryContent: string, keepLastMessages: number): void {
    const summaryId = this.upsertSummaryMessage(summaryContent);
    const summaryMsg = this.messages.find(m => m.id === summaryId);
    const nonSystem = this.messages.filter(m => m.role !== 'system');
    const keep = nonSystem.slice(-keepLastMessages);
    this.messages = summaryMsg ? [summaryMsg, ...keep] : keep;
    if (this.currentConversation) {
      this.currentConversation.messages = this.messages;
    }
  }

  addAssistantMessage(content: string, isStreaming = false): string {
    const id = crypto.randomUUID();
    const message: AssistantMessage = {
      id,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      isStreaming,
      streamState: isStreaming ? 'active' : 'completed',
    };
    this.messages = [...this.messages, message];
    this.enforceInMemoryBudget();

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
      const contentParts = this.normalizeContentParts(msg.contentParts, content);
      const streamState =
        isStreaming
          ? 'active'
          : msg.streamState === 'interrupted' || msg.streamState === 'cancelled' || msg.streamState === 'failed'
            ? msg.streamState
            : 'completed';
      return { ...msg, content, isStreaming, endTime, contentParts, streamState };
    });

    // Also update in currentConversation
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.currentConversation.messages.map(msg => {
          if (msg.id !== id) return msg;
          const endTime = !isStreaming && msg.isStreaming ? Date.now() : msg.endTime;
          const contentParts = this.normalizeContentParts(msg.contentParts, content);
          const streamState =
            isStreaming
              ? 'active'
              : msg.streamState === 'interrupted' || msg.streamState === 'cancelled' || msg.streamState === 'failed'
                ? msg.streamState
                : 'completed';
          return { ...msg, content, isStreaming, endTime, contentParts, streamState };
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
    this.enforceInMemoryBudget();

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
      const ensuredToolCall: ToolCall = {
        ...toolCall,
        meta: {
          ...(toolCall.meta || {}),
          textOffset:
            typeof (toolCall.meta as any)?.textOffset === 'number'
              ? (toolCall.meta as any).textOffset
              : (msg.content?.length ?? 0),
        },
      };
      const inlineToolCalls = [...(msg.inlineToolCalls || []), ensuredToolCall];
      const contentParts = [...(msg.contentParts || [])];
      contentParts.push({ type: "tool", toolCall: ensuredToolCall });
      return { ...msg, inlineToolCalls, contentParts };
    });

    // Also update in currentConversation
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.currentConversation.messages.map(msg => {
          if (msg.id !== messageId) return msg;
          const ensuredToolCall: ToolCall = {
            ...toolCall,
            meta: {
              ...(toolCall.meta || {}),
              textOffset:
                typeof (toolCall.meta as any)?.textOffset === 'number'
                  ? (toolCall.meta as any).textOffset
                  : (msg.content?.length ?? 0),
            },
          };
          const inlineToolCalls = [...(msg.inlineToolCalls || []), ensuredToolCall];
          const contentParts = [...(msg.contentParts || [])];
          contentParts.push({ type: "tool", toolCall: ensuredToolCall });
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
        tc.id === toolCallId ? {
          ...tc,
          ...updates,
          meta: updates.meta
            ? {
              ...(tc.meta || {}),
              ...updates.meta,
              textOffset:
                typeof (updates.meta as any)?.textOffset === 'number'
                  ? (updates.meta as any).textOffset
                  : (tc.meta as any)?.textOffset
            }
            : tc.meta
        } : tc,
      );

      const contentParts = (msg.contentParts || []).map(part => {
        if (part.type === "tool" && part.toolCall.id === toolCallId) {
          return {
            ...part,
            toolCall: {
              ...part.toolCall,
              ...updates,
              meta: updates.meta
                ? {
                  ...(part.toolCall.meta || {}),
                  ...updates.meta,
                  textOffset:
                    typeof (updates.meta as any)?.textOffset === 'number'
                      ? (updates.meta as any).textOffset
                      : (part.toolCall.meta as any)?.textOffset
                }
                : part.toolCall.meta
            },
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
            tc.id === toolCallId ? {
              ...tc,
              ...updates,
              meta: updates.meta
                ? {
                  ...(tc.meta || {}),
                  ...updates.meta,
                  textOffset:
                    typeof (updates.meta as any)?.textOffset === 'number'
                      ? (updates.meta as any).textOffset
                      : (tc.meta as any)?.textOffset
                }
                : tc.meta
            } : tc,
          );
          const contentParts = (msg.contentParts || []).map(part => {
            if (part.type === "tool" && part.toolCall.id === toolCallId) {
              return {
                ...part,
                toolCall: {
                  ...part.toolCall,
                  ...updates,
                  meta: updates.meta
                    ? {
                      ...(part.toolCall.meta || {}),
                      ...updates.meta,
                      textOffset:
                        typeof (updates.meta as any)?.textOffset === 'number'
                          ? (updates.meta as any).textOffset
                          : (part.toolCall.meta as any)?.textOffset
                    }
                    : part.toolCall.meta
                },
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
  private persistDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private async persistMessageToHistory(messageId: string, immediate = false): Promise<void> {
    // Debounce rapid persists during streaming (every text chunk triggers this)
    // Only the final state matters since saveMessage upserts by ID
    if (!immediate) {
      const existing = this.persistDebounceTimers.get(messageId);
      if (existing) clearTimeout(existing);
      this.persistDebounceTimers.set(messageId, setTimeout(() => {
        this.persistDebounceTimers.delete(messageId);
        this.persistMessageToHistory(messageId, true);
      }, 500));
      return;
    }

    const msg = this.messages.find(m => m.id === messageId);
    const convId = this.currentConversation?.id;
    if (!msg || !convId) return;

    try {
      try {
        await chatHistoryStore.createConversation(convId, this.currentMode);
      } catch (createErr) {
        console.debug('[AssistantStore] Conversation may already exist:', createErr);
      }

      // Sanitize tool calls to ensure clean JSON serialization
      // Remove undefined values, functions, and circular refs
      const sanitizeToolCalls = (calls?: ToolCall[]): ToolCall[] | undefined => {
        if (!calls || calls.length === 0) return undefined;
        return calls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments ?? {},
          status: tc.status,
          output: tc.output,
          error: tc.error,
          meta: tc.meta ? { ...tc.meta } : undefined,
          data: tc.data ? { ...tc.data } : undefined,
          startTime: tc.startTime,
          endTime: tc.endTime,
          requiresApproval: tc.requiresApproval,
          thoughtSignature: tc.thoughtSignature,
          streamingProgress: tc.streamingProgress ? { ...tc.streamingProgress } : undefined,
          reviewStatus: tc.reviewStatus,
        }));
      };

      // Sanitize contentParts - ensure tool call data within parts is also clean
      const sanitizeContentParts = (parts?: ContentPart[]): ContentPart[] | undefined => {
        if (!parts || parts.length === 0) return undefined;
        return parts.map(part => {
          if (part.type === 'tool') {
            const tc = part.toolCall;
            return {
              type: 'tool' as const,
              toolCall: {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments ?? {},
                status: tc.status,
                output: tc.output,
                error: tc.error,
                meta: tc.meta ? { ...tc.meta } : undefined,
                data: tc.data ? { ...tc.data } : undefined,
                startTime: tc.startTime,
                endTime: tc.endTime,
                requiresApproval: tc.requiresApproval,
                thoughtSignature: tc.thoughtSignature,
                streamingProgress: tc.streamingProgress ? { ...tc.streamingProgress } : undefined,
                reviewStatus: tc.reviewStatus,
              }
            };
          }
          return part;
        });
      };

      const metadata = JSON.stringify({
        attachments: msg.attachments,
        toolCalls: sanitizeToolCalls(msg.toolCalls),
        inlineToolCalls: sanitizeToolCalls(msg.inlineToolCalls),
        contentParts: sanitizeContentParts(msg.contentParts),
        thinking: msg.thinking,
        smartContextBlock: msg.smartContextBlock,
        contextMentions: msg.contextMentions,
        isSummary: msg.isSummary || undefined, // Bug fix: was missing!
        endTime: msg.endTime,
        streamState: msg.streamState,
        streamIssue: msg.streamIssue,
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

        return {
          ...msg,
          contentParts: newParts,
          content: fullContent,
          isStreaming,
          streamState: isStreaming ? 'active' : (msg.streamState ?? 'completed'),
        };
      }
      return msg;
    });
    this.enforceInMemoryBudget();
    if (this.currentConversation) {
      this.currentConversation.messages = this.messages;
    }

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
    if (this.currentConversation) {
      this.currentConversation.messages = this.messages;
    }

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
              title = lines[0]
                .replace(/^\s*[-*•]+\s*/, '')
                .replace(/^\s*#+\s*/, '')
                .replace(/\*\*(.*?)\*\*/g, '$1')
                .replace(/\*(.*?)\*/g, '$1')
                .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
                .trim()
                .slice(0, 60);
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
    if (this.currentConversation) {
      this.currentConversation.messages = this.messages;
    }

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
            isStreaming,
            streamState: isStreaming ? 'active' : (msg.streamState ?? 'completed'),
          };
        }

        if (lastTextIndex === -1) {
          // No existing text parts, append one at the end
          return {
            ...msg,
            contentParts: content ? [...parts, { type: 'text' as const, text: content }] : parts,
            content,
            isStreaming,
            streamState: isStreaming ? 'active' : (msg.streamState ?? 'completed'),
          };
        }

        const idx = parts.length - 1 - lastTextIndex;
        const newParts = parts.map((p, i) => (i === idx && p.type === 'text') ? { type: 'text' as const, text: content } : p);
        return {
          ...msg,
          contentParts: newParts,
          content,
          isStreaming,
          streamState: isStreaming ? 'active' : (msg.streamState ?? 'completed'),
        };
      }
      return msg;
    });
    if (this.currentConversation) {
      this.currentConversation.messages = this.messages;
    }
  }

  markAssistantMessageStreamState(
    messageId: string,
    streamState: 'interrupted' | 'cancelled' | 'failed' | 'completed',
    streamIssue?: string,
  ): void {
    const applyPatch = (msg: AssistantMessage): AssistantMessage =>
      msg.id === messageId
        ? {
            ...msg,
            isStreaming: false,
            endTime: msg.endTime ?? Date.now(),
            streamState,
            streamIssue: streamIssue ?? msg.streamIssue,
          }
        : msg;

    this.messages = this.messages.map(applyPatch);
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.currentConversation.messages.map(applyPatch),
      };
    }
    this.persistMessageToHistory(messageId, true);
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
    mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  }> {
    return getAttachmentPreviews(this.pendingAttachments) as Array<{
      id: string;
      type: MessageAttachment['type'];
      label: string;
      size?: string;
      dimensions?: string;
      isImage: boolean;
      thumbnailData?: string;
      mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
    }>;
  }
  /**
   * Get total context size for current attachments
   */
  getTotalContextSize(): number {
    return getTotalContextSize(this.pendingAttachments);
  }
  /**
   * Check if context size is within limits
   */
  isContextWithinLimits(): boolean {
    return isContextWithinLimits(this.pendingAttachments);
  }
  /**
   * Estimate token count from character count (uses accurate token counter)
   */
  estimateTokens(charCount: number, contentType: ContentType = 'mixed'): number {
    return estimateTokensFromChars(charCount, contentType);
  }
  /**
   * Get accurate token count for the entire conversation
   * Uses content-aware token counting (code vs prose vs mixed)
   */
  getConversationTokens(): number {
    return getConversationTokens(this.messages, this.inputValue, this.pendingAttachments);
  }
  /**
   * Get total conversation context size in characters (legacy, for compatibility)
   * Includes all messages + pending attachments + input
   */
  getConversationContextChars(): number {
    return getConversationContextChars(this.messages, this.pendingAttachments, this.inputValue);
  }
  /**
   * Get context usage info for UI display (uses accurate token counting)
   */
  getContextUsage(model = 'gemini-2.5-flash'): ContextUsage {
    return getContextUsage(model, this.messages, this.pendingAttachments, this.inputValue);
  }
  /**
   * Format token count for display (e.g., "1.2M", "500K", "1,234")
   */
  formatTokenCount(tokens: number): string {
    return formatTokenCount(tokens);
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
    if (this.agentLoopState !== 'completed' && this.agentLoopState !== 'failed') {
      this.agentLoopState = 'cancelled';
    }

    // Mark any streaming messages as complete
    this.messages = this.messages.map(msg =>
      msg.isStreaming
        ? {
            ...msg,
            isStreaming: false,
            streamState: msg.role === 'assistant' ? 'cancelled' : msg.streamState,
            streamIssue: msg.role === 'assistant' ? (msg.streamIssue ?? 'User cancelled streaming') : msg.streamIssue,
            endTime: msg.endTime ?? Date.now(),
          }
        : msg
    );
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.currentConversation.messages.map((msg) =>
          msg.isStreaming
            ? {
                ...msg,
                isStreaming: false,
                streamState: msg.role === 'assistant' ? 'cancelled' : msg.streamState,
                streamIssue:
                  msg.role === 'assistant'
                    ? (msg.streamIssue ?? 'User cancelled streaming')
                    : msg.streamIssue,
                endTime: msg.endTime ?? Date.now(),
              }
            : msg,
        ),
      };
    }

    // Cancel any running tool calls
    this.activeToolCalls = this.activeToolCalls.map(tc =>
      tc.status === 'running' || tc.status === 'pending'
        ? { ...tc, status: 'cancelled' as ToolCallStatus, endTime: Date.now() }
        : tc
    );

    // Cancel inline tool calls shown inside assistant messages.
    const cancelInlineToolCalls = (msg: AssistantMessage): AssistantMessage => {
      const inlineToolCalls = (msg.inlineToolCalls || []).map(tc =>
        tc.status === 'running' || tc.status === 'pending'
          ? { ...tc, status: 'cancelled' as ToolCallStatus, endTime: Date.now() }
          : tc
      );
      const contentParts = (msg.contentParts || []).map(part => {
        if (part.type === 'tool') {
          const tc = part.toolCall;
          if (tc.status === 'running' || tc.status === 'pending') {
            return {
              ...part,
              toolCall: {
                ...tc,
                status: 'cancelled' as ToolCallStatus,
                endTime: Date.now(),
              },
            };
          }
        }
        return part;
      });
      return { ...msg, inlineToolCalls, contentParts };
    };

    this.messages = this.messages.map(cancelInlineToolCalls);
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        messages: this.currentConversation.messages.map(cancelInlineToolCalls),
      };
    }

    // Force-close any active thinking blocks so UI never gets stuck on "Thinking..."
    for (const msg of this.messages) {
      if (msg.role === 'assistant') {
        this.finalizeThinking(msg.id);
      }
    }
  }

  setAgentLoopState(state: AgentLoopState, meta: Record<string, unknown> = {}): void {
    const previous = this.agentLoopState;
    const previousTerminal =
      previous === 'completed' || previous === 'failed' || previous === 'cancelled';
    const nextTerminal =
      state === 'completed' || state === 'failed' || state === 'cancelled';

    // Terminal states need special handling:
    // - Allow terminal -> running (new user turn starts).
    // - Ignore all other terminal -> * transitions as stale async updates.
    if (previousTerminal) {
      if (state !== 'running') {
        console.debug('[AssistantStore] Ignoring stale terminal loop transition', {
          from: previous,
          to: state,
          meta,
        });
        return;
      }
    }

    if (!isValidLoopTransition(previous, state)) {
      console.warn('[AssistantStore] Illegal loop state transition', { from: previous, to: state, meta });
      if (!(state === 'failed' || state === 'cancelled' || state === 'running')) {
        state = 'failed';
        meta = { ...meta, illegalTransition: { from: previous, to: state } };
      }
    }
    this.agentLoopState = state;
    this.agentLoopMeta = { ...meta, at: Date.now() };
    console.info('[AssistantLoop] state', {
      from: previous,
      to: state,
      meta,
    });
    agentTelemetryStore.record({
      type: 'agent.loop.state_transition',
      timestamp: Date.now(),
      from: previous,
      to: state,
      meta,
    });
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
  setInputValue(value: string, source: 'user' | 'history' = 'user'): void {
    this.inputValue = value;
    if (source === 'user' && this.historyIndex !== -1) {
      // User started typing while browsing history - reset navigation
      this.historyIndex = -1;
      this.draftValue = value;
      this.draftAttachments = [...this.pendingAttachments];
    }
  }

  setPendingAttachments(attachments: MessageAttachment[]): void {
    this.pendingAttachments = [...attachments];
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

  private loadBrowserToolsEnabled(): void {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(BROWSER_TOOLS_ENABLED_KEY);
      if (stored !== null) {
        this.browserToolsEnabled = stored === 'true';
      }
    } catch {
      // Ignore storage errors
    }
  }

  private saveBrowserToolsEnabled(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(BROWSER_TOOLS_ENABLED_KEY, String(this.browserToolsEnabled));
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
      const lastConvId = (id || localStorage.getItem(CURRENT_CONV_ID_KEY) || "").trim();
      if (lastConvId && lastConvId !== "undefined") {
        try {
          const conv = await invoke<Conversation>("chat_get_conversation", {
            conversationId: lastConvId,
          });
          if (conv) {
            this.loadConversation({
              id: conv.id,
              title: conv.title ?? "",
              createdAt: conv.createdAt || Date.now(),
              updatedAt: conv.updatedAt || conv.createdAt || Date.now(),
              isPinned: conv.isPinned ?? false,
              mode: conv.mode ?? "agent",
              messages: conv.messages,
            });
          }
        } catch (err) {
          const message = String(err ?? '');
          const isMissingConversation =
            message.includes('Conversation not found') ||
            message.includes('Query returned no rows');
          if (!isMissingConversation) {
            console.warn("[AssistantStore] Failed to restore last conversation:", err);
          }
          localStorage.removeItem(CURRENT_CONV_ID_KEY);
        }
      }
    } catch (err) {
      console.warn('[AssistantStore] Failed to restore last conversation:', err);
    }
  }

  private normalizeContentParts(
    parts: ContentPart[] | undefined,
    content: string,
  ): ContentPart[] | undefined {
    if (!content && (!parts || parts.length === 0)) return parts;

    // If parts already has text, preserve the existing order (critical for history restore)
    // Only aggregate text from all text parts and update the first one
    const hasText = parts?.some(p => p.type === 'text');
    if (hasText && parts && parts.length > 0) {
      // Update existing text parts to match the content (in case content differs)
      // but preserve the interleaved order
      return parts;
    }

    // No text parts exist - need to add one while preserving chronology.
    const normalized = [...(parts || [])];
    if (content) {
      // If tool/thinking parts already exist, append final text so it renders below tools.
      // This keeps "tool execution first, summary later" visual ordering.
      normalized.push({ type: 'text', text: content });
    }

    return normalized.length > 0 ? normalized : parts;
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

    const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const deletionTargets = [...filesToRevert.entries()]
      .filter(([, content]) => content === null)
      .map(([path]) => path);
    const sortedDeletionTargets = [...new Set(deletionTargets)].sort(
      (a, b) => normalizePath(a).length - normalizePath(b).length
    );
    const collapsedDeletionTargets: string[] = [];
    for (const path of sortedDeletionTargets) {
      const normalized = normalizePath(path);
      if (collapsedDeletionTargets.some((kept) => {
        const keptNorm = normalizePath(kept);
        return normalized === keptNorm || normalized.startsWith(keptNorm + '/');
      })) {
        continue;
      }
      collapsedDeletionTargets.push(path);
    }

    // 2. Perform physical revert
    try {
      // Pre-close open files and stop terminals inside deletion targets.
      // This dramatically improves reliability when deleting big trees (e.g. node_modules) on Windows.
      if (collapsedDeletionTargets.length > 0) {
        const targetsNormalized = collapsedDeletionTargets.map(normalizePath);
        for (const openFile of editorStore.openFiles) {
          const fileNorm = normalizePath(openFile.path);
          if (targetsNormalized.some((target) => fileNorm === target || fileNorm.startsWith(target + '/'))) {
            editorStore.closeFile(openFile.path, true);
          }
        }

        for (const target of collapsedDeletionTargets) {
          await terminalStore.stopSessionsInPath(target);
        }
      }

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
            // Use fileService for consistent writes
            const result = await fileService.write(path, content, { source: 'ai', force: true });
            if (!result.success) {
              console.error(`[Revert] Failed for ${path}:`, result.error);
            }
          }
        } catch (e) {
          console.error(`[Revert] Failed for ${path}:`, e);
        }
      }

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
      await projectStore.refreshTree();
    } catch (err) {
      console.error('[AssistantStore] Revert failed:', err);
      const { showToast } = await import('$shared/stores/toast.svelte');
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

    const { showToast } = await import('$shared/stores/toast.svelte');
    showToast({ message: 'Reverted conversation', type: 'info' });
  }
}

// Singleton instance
export const assistantStore = new AssistantStore();
chatHistoryStore.setActiveConversationDeletedHandler(() => {
  assistantStore.clearConversation();
});

// Export constants for use in components
export { MIN_PANEL_WIDTH, MAX_PANEL_WIDTH };
export type { AgentLoopState } from './assistant/loop-state';
export {
  CONTEXT_LIMITS,
  getModelContextLimits,
  IMAGE_LIMITS,
  MODE_CAPABILITIES,
  MODEL_CONTEXT_LIMITS,
} from './assistant/config';

// Export utility functions
export { generateChecksum, isLikelySecretPath, redactSecrets } from './assistant/utils';

