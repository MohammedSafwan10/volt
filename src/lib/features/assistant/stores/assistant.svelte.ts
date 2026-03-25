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
import { serializeMessageMetadata } from '../components/panel/conversation-persistence';
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
  findConversationIdByMessageId as resolveConversationIdByMessageId,
  sanitizeVisibleAssistantText,
  stripSystemReminderTags,
} from './assistant-message-routing';
import {
  resolveConversationFallbackOnClose,
  shouldCreateInitialConversation,
} from './assistant-tab-flow';
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

export interface SyntheticPromptMeta {
  kind: 'spec-phase' | 'spec-task' | 'spec-verify' | 'spec-review-fix';
  title: string;
  subtitle?: string;
}

// Tool call status
export type {
  StreamingProgress,
  ToolCall,
  ToolCallReviewStatus,
  ToolCallStatus,
} from '$features/assistant/types/tool-call';
import type {
  StreamingProgress,
  ToolCall,
  ToolCallReviewStatus,
  ToolCallStatus,
} from '$features/assistant/types/tool-call';

// Content part types for interleaved rendering
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
  // Ordered content parts for interleaved text + tool rendering
  contentParts?: ContentPart[];
  // System summary marker (for auto-summary)
  isSummary?: boolean;
  // Reference context block (hidden from UI, sent to provider)
  smartContextBlock?: string;
  // User-selected mentions from @ menu (shown as chips)
  contextMentions?: AttachedContext[];
  // Compact UI metadata for app-generated prompts that should not render like raw user prose.
  syntheticPrompt?: SyntheticPromptMeta;
  // Streaming lifecycle truthfulness for partial/failed streams
  streamState?: 'active' | 'completed' | 'interrupted' | 'cancelled' | 'failed';
  streamIssue?: string;
}

interface AddUserMessageOptions {
  syntheticPrompt?: SyntheticPromptMeta;
  suppressAutoTitle?: boolean;
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

interface ConversationRuntimeState {
  messages: AssistantMessage[];
  currentMode: AIMode;
  inputValue: string;
  attachedContext: AttachedContext[];
  inputHistory: Array<{ content: string; attachments: MessageAttachment[] }>;
  historyIndex: number;
  draftValue: string;
  draftAttachments: MessageAttachment[];
  pendingAttachments: MessageAttachment[];
  isStreaming: boolean;
  abortController: AbortController | null;
  agentLoopState: AgentLoopState;
  agentLoopMeta: Record<string, unknown>;
}

interface ConversationScopedStatePatch {
  messages?: AssistantMessage[];
  currentMode?: AIMode;
  inputValue?: string;
  attachedContext?: AttachedContext[];
  inputHistory?: Array<{ content: string; attachments: MessageAttachment[] }>;
  historyIndex?: number;
  draftValue?: string;
  draftAttachments?: MessageAttachment[];
  pendingAttachments?: MessageAttachment[];
  isStreaming?: boolean;
  abortController?: AbortController | null;
  agentLoopState?: AgentLoopState;
  agentLoopMeta?: Record<string, unknown>;
}

interface ConversationSummaryLike {
  id: string;
  createdAt: number;
  updatedAt?: number;
  title?: string;
  isPinned?: boolean;
  mode?: string;
}

function normalizeConversationTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function truncateConversationTitle(raw: string, maxLength = 42): string {
  const normalized = normalizeConversationTitle(raw);
  if (normalized.length <= maxLength) return normalized;
  const sliced = normalized.slice(0, maxLength - 1);
  const boundary = sliced.lastIndexOf(' ');
  const compact = boundary >= 14 ? sliced.slice(0, boundary) : sliced;
  return `${compact.trimEnd()}…`;
}

function deriveConversationTitleFromUserText(raw: string): string {
  const normalized = normalizeConversationTitle(raw);
  if (!normalized) return 'New Chat';
  return truncateConversationTitle(normalized, 46);
}

function inferSyntheticPromptMeta(content: string): SyntheticPromptMeta | undefined {
  const normalized = normalizeConversationTitle(content);
  if (!normalized) return undefined;

  let match = normalized.match(/^Execute spec task (TASK-[A-Za-z0-9.-]+):\s*(.+)$/i);
  if (match) {
    return { kind: 'spec-task', title: `${match[1]} · Build`, subtitle: match[2] };
  }

  match = normalized.match(/^Retry spec task (TASK-[A-Za-z0-9.-]+):\s*(.+)$/i);
  if (match) {
    return { kind: 'spec-task', title: `${match[1]} · Retry`, subtitle: match[2] };
  }

  match = normalized.match(/^Verify spec task (TASK-[A-Za-z0-9.-]+):\s*(.+)$/i);
  if (match) {
    return { kind: 'spec-verify', title: `${match[1]} · Verify`, subtitle: match[2] };
  }

  match = normalized.match(/^Apply the verifier findings for spec task (TASK-[A-Za-z0-9.-]+):\s*(.+)$/i);
  if (match) {
    return { kind: 'spec-review-fix', title: `${match[1]} · Fix Review`, subtitle: match[2] };
  }

  match = normalized.match(/^Generate design for spec \"(.+)\"$/i);
  if (match) {
    return { kind: 'spec-phase', title: 'Spec · Design', subtitle: match[1] };
  }

  match = normalized.match(/^Generate tasks for spec \"(.+)\"$/i);
  if (match) {
    return { kind: 'spec-phase', title: 'Spec · Tasks', subtitle: match[1] };
  }

  match = normalized.match(/^Draft(?:ed)? requirements(?: for)? \"(.+)\"$/i);
  if (match) {
    return { kind: 'spec-phase', title: 'Spec · Requirements Draft', subtitle: match[1] };
  }

  return undefined;
}

function isAssistantDebugEnabled(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('volt.assistant.debug') === 'true';
  } catch {
    return false;
  }
}

function debugAssistantSession(event: string, details: Record<string, unknown> = {}): void {
  if (!isAssistantDebugEnabled()) return;
  console.info('[AssistantSession]', { event, ...details, at: Date.now() });
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

// DOM element attachment (legacy/retired, shown as chip only when present in history)
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
const CURRENT_CONV_ID_KEY = 'volt.assistant.currentConversationId';
const OPEN_TAB_IDS_KEY = 'volt.assistant.openTabIds';
const AUTO_APPROVE_ALL_KEY = 'volt.assistant.autoApproveAllTools';
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
  openConversationIds = $state<string[]>([]);
  autoApproveAllTools = $state(false);

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
  chatScrollRevision = $state(0);

  private runStates = $state<Record<string, { isStreaming: boolean; agentLoopState: AgentLoopState; updatedAt: number; lastError?: string | null }>>({});
  private conversationRuntimeState = $state<Record<string, ConversationRuntimeState>>({});

  constructor() {
    this.loadPanelWidth();
    this.loadPanelOpen();
    this.loadOpenConversationIds();
    this.loadCurrentConversationId();
    this.loadAutoApproveAllTools();
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
      title: 'New Chat',
      messages: []
    };
    this.ensureConversationTab(this.currentConversation.id);
    this.ensureConversationRuntime(this.currentConversation.id, 'agent');
  }

  /**
   * Start a fresh conversation (clears current and creates new ID)
   * Called by UI when user clicks "New Chat"
   */
  newConversation(): void {
    if (this.currentConversation?.id) {
      this.commitActiveViewToRuntime(this.currentConversation.id);
    }
    // Clear current state
    this.messages = [];
    this.pendingAttachments = [];
    this.inputValue = "";
    this.inputHistory = [];
    this.historyIndex = -1;
    this.draftValue = "";
    this.draftAttachments = [];
    this.currentMode = 'agent';

    // Initialize fresh conversation
    const newId = crypto.randomUUID();
    this.currentConversation = {
      id: newId,
      createdAt: Date.now(),
      title: 'New Chat',
      messages: []
    };
    this.ensureConversationTab(newId);
    this.ensureConversationRuntime(newId, 'agent');
    this.syncRuntimeToActiveView(newId);
    this.saveCurrentConversationId();
    this.saveOpenConversationIds();

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
    if (this.currentConversation?.id) {
      this.commitActiveViewToRuntime(this.currentConversation.id);
    }

    // Clear current state
    this.pendingAttachments = [];
    this.inputValue = "";
    this.historyIndex = -1;
    this.draftValue = "";
    this.draftAttachments = [];

    // Restore mode
    this.currentMode = (conversation.mode as AIMode) || 'agent';

    // Convert persisted messages to AssistantMessage format
    const restoredMessages: AssistantMessage[] = conversation.messages.map(msg => {
      const base: AssistantMessage = {
        id: msg.id,
        role: msg.role as MessageRole,
        content: sanitizeVisibleAssistantText(msg.content),
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
          if (meta.syntheticPrompt) base.syntheticPrompt = meta.syntheticPrompt;
          if (meta.streamState) base.streamState = meta.streamState;
          if (meta.streamIssue) base.streamIssue = meta.streamIssue;
        } catch (e) {
          console.warn('[AssistantStore] Failed to parse message metadata:', e);
        }
      }

      if (base.role === 'user' && !base.syntheticPrompt) {
        base.syntheticPrompt = inferSyntheticPromptMeta(base.content);
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
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      isPinned: conversation.isPinned,
      mode: conversation.mode,
      messages: restoredMessages
    };
    this.conversationRuntimeState = {
      ...this.conversationRuntimeState,
      [conversation.id]: {
        messages: restoredMessages,
        currentMode: (conversation.mode as AIMode) || 'agent',
        inputValue: '',
        attachedContext: [],
        inputHistory: [],
        historyIndex: -1,
        draftValue: '',
        draftAttachments: [],
        pendingAttachments: [],
        isStreaming: false,
        abortController: null,
        agentLoopState: 'completed',
        agentLoopMeta: {},
      },
    };
    this.ensureConversationTab(conversation.id);
    this.saveOpenConversationIds();
    this.markConversationRunState(conversation.id, {
      isStreaming: false,
      agentLoopState: 'completed',
    });
  }

  private ensureConversationTab(conversationId: string): void {
    if (!conversationId) return;
    if (this.openConversationIds.includes(conversationId)) return;
    this.openConversationIds = [...this.openConversationIds, conversationId];
  }

  private createDefaultRuntimeState(mode: AIMode = 'agent'): ConversationRuntimeState {
    return {
      messages: [],
      currentMode: mode,
      inputValue: '',
      attachedContext: [],
      inputHistory: [],
      historyIndex: -1,
      draftValue: '',
      draftAttachments: [],
      pendingAttachments: [],
      isStreaming: false,
      abortController: null,
      agentLoopState: 'completed',
      agentLoopMeta: {},
    };
  }

  private ensureConversationRuntime(conversationId: string, mode: AIMode = 'agent'): ConversationRuntimeState {
    const existing = this.conversationRuntimeState[conversationId];
    if (existing) return existing;
    const runtime = this.createDefaultRuntimeState(mode);
    this.conversationRuntimeState = {
      ...this.conversationRuntimeState,
      [conversationId]: runtime,
    };
    return runtime;
  }

  private updateConversationRuntime(
    conversationId: string,
    updater: (runtime: ConversationRuntimeState) => ConversationRuntimeState,
  ): ConversationRuntimeState {
    const current = this.ensureConversationRuntime(conversationId);
    const next = updater(current);
    this.conversationRuntimeState = {
      ...this.conversationRuntimeState,
      [conversationId]: next,
    };
    return next;
  }

  private buildConversationRecord(
    conversationId: string,
    summary?: ConversationSummaryLike,
  ): Conversation {
    const runtime = this.ensureConversationRuntime(
      conversationId,
      (summary?.mode as AIMode) || 'agent',
    );
    return {
      id: conversationId,
      createdAt: summary?.createdAt ?? Date.now(),
      title: summary?.title ?? 'New Chat',
      updatedAt: summary?.updatedAt ?? Date.now(),
      isPinned: summary?.isPinned ?? false,
      mode: summary?.mode ?? runtime.currentMode,
      messages: runtime.messages,
    };
  }

  switchToConversation(conversationId: string, summary?: ConversationSummaryLike): boolean {
    if (!conversationId) return false;
    if (this.currentConversation?.id === conversationId) {
      this.syncRuntimeToActiveView(conversationId);
      this.saveCurrentConversationId();
      return true;
    }

    if (this.currentConversation?.id) {
      this.commitActiveViewToRuntime(this.currentConversation.id);
    }

    const runtime = this.conversationRuntimeState[conversationId];
    if (!runtime) return false;

    this.currentConversation = this.buildConversationRecord(conversationId, summary);
    this.ensureConversationTab(conversationId);
    this.syncRuntimeToActiveView(conversationId);
    this.saveCurrentConversationId();
    return true;
  }

  private syncRuntimeToActiveView(conversationId: string): void {
    if (this.currentConversation?.id !== conversationId) return;
    const runtime = this.ensureConversationRuntime(conversationId);
    this.messages = runtime.messages;
    this.currentMode = runtime.currentMode;
    this.inputValue = runtime.inputValue;
    this.attachedContext = [...runtime.attachedContext];
    this.inputHistory = [...runtime.inputHistory];
    this.historyIndex = runtime.historyIndex;
    this.draftValue = runtime.draftValue;
    this.draftAttachments = [...runtime.draftAttachments];
    this.pendingAttachments = [...runtime.pendingAttachments];
    this.isStreaming = runtime.isStreaming;
    this.abortController = runtime.abortController;
    this.agentLoopState = runtime.agentLoopState;
    this.agentLoopMeta = { ...runtime.agentLoopMeta };
    debugAssistantSession('sync_runtime_to_active_view', {
      conversationId,
      messageCount: runtime.messages.length,
      isStreaming: runtime.isStreaming,
      agentLoopState: runtime.agentLoopState,
    });
  }

  private applyConversationStatePatch(
    conversationId: string,
    patch: ConversationScopedStatePatch,
  ): ConversationRuntimeState {
    const nextRuntime = this.updateConversationRuntime(conversationId, (runtime) => ({
      ...runtime,
      ...patch,
    }));

    if (this.currentConversation?.id === conversationId) {
      this.syncRuntimeToActiveView(conversationId);
      this.currentConversation = {
        ...this.currentConversation,
        mode: nextRuntime.currentMode,
        messages: nextRuntime.messages,
        updatedAt: Date.now(),
      };
      if (patch.messages) {
        this.bumpChatScrollRevision();
      }
    }

    return nextRuntime;
  }

  private bumpChatScrollRevision(): void {
    this.chatScrollRevision += 1;
  }

  private updateConversationMessages(
    conversationId: string,
    updater: (messages: AssistantMessage[]) => AssistantMessage[],
  ): AssistantMessage[] {
    const runtime = this.ensureConversationRuntime(conversationId);
    const nextMessages = updater(runtime.messages);
    this.applyConversationStatePatch(conversationId, { messages: nextMessages });
    return nextMessages;
  }

  private patchMessageArray(
    messages: AssistantMessage[],
    messageId: string,
    patcher: (message: AssistantMessage) => AssistantMessage,
  ): AssistantMessage[] {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return messages;
    const current = messages[index];
    const next = patcher(current);
    if (next === current) return messages;
    const cloned = messages.slice();
    cloned[index] = next;
    return cloned;
  }

  private patchConversationMessage(
    conversationId: string,
    messageId: string,
    patcher: (message: AssistantMessage) => AssistantMessage,
  ): AssistantMessage[] {
    return this.updateConversationMessages(conversationId, (messages) =>
      this.patchMessageArray(messages, messageId, patcher),
    );
  }

  private patchActiveMessages(
    messageId: string,
    patcher: (message: AssistantMessage) => AssistantMessage,
  ): void {
    const nextMessages = this.patchMessageArray(this.messages, messageId, patcher);
    if (nextMessages === this.messages) return;
    this.messages = nextMessages;
    this.bumpChatScrollRevision();
  }

  private commitActiveViewToRuntime(conversationId: string): void {
    this.conversationRuntimeState = {
      ...this.conversationRuntimeState,
      [conversationId]: {
        messages: this.messages,
        currentMode: this.currentMode,
        inputValue: this.inputValue,
        attachedContext: [...this.attachedContext],
        inputHistory: [...this.inputHistory],
        historyIndex: this.historyIndex,
        draftValue: this.draftValue,
        draftAttachments: [...this.draftAttachments],
        pendingAttachments: [...this.pendingAttachments],
        isStreaming: this.isStreaming,
        abortController: this.abortController,
        agentLoopState: this.agentLoopState,
        agentLoopMeta: { ...this.agentLoopMeta },
      },
    };
    debugAssistantSession('commit_active_view_to_runtime', {
      conversationId,
      messageCount: this.messages.length,
      isStreaming: this.isStreaming,
      agentLoopState: this.agentLoopState,
    });
  }

  private syncActiveComposerState(
    patch: Partial<
      Pick<
        ConversationRuntimeState,
        | 'inputValue'
        | 'attachedContext'
        | 'inputHistory'
        | 'historyIndex'
        | 'draftValue'
        | 'draftAttachments'
        | 'pendingAttachments'
        | 'currentMode'
      >
    >,
  ): void {
    const conversationId = this.currentConversation?.id;
    if (!conversationId) return;
    this.updateConversationRuntime(conversationId, (runtime) => ({
      ...runtime,
      ...patch,
    }));
  }

  getConversationMessages(conversationId: string): AssistantMessage[] {
    if (!conversationId) return [];
    return this.currentConversation?.id === conversationId
      ? this.messages
      : (this.conversationRuntimeState[conversationId]?.messages ?? []);
  }

  private findConversationIdByMessageId(messageId: string): string | null {
    return resolveConversationIdByMessageId(
      messageId,
      this.currentConversation?.id ?? null,
      this.messages,
      this.conversationRuntimeState,
    );
  }

  private getMessageForPersistence(messageId: string): {
    conversationId: string;
    message: AssistantMessage;
    mode: AIMode;
  } | null {
    const conversationId = this.findConversationIdByMessageId(messageId);
    if (!conversationId) return null;
    const messages = this.getConversationMessages(conversationId);
    const message = messages.find((entry) => entry.id === messageId);
    if (!message) return null;
    const mode = (this.currentConversation?.id === conversationId
      ? this.currentConversation.mode
      : this.conversationRuntimeState[conversationId]?.currentMode) as AIMode | undefined;
    return { conversationId, message, mode: mode || 'agent' };
  }

  private removeConversationTab(conversationId: string): void {
    this.openConversationIds = this.openConversationIds.filter((id) => id !== conversationId);
    const { [conversationId]: _, ...rest } = this.runStates;
    this.runStates = rest;
  }

  hasOpenConversationTab(conversationId: string | null | undefined): boolean {
    if (!conversationId) return false;
    return this.openConversationIds.includes(conversationId);
  }

  getOpenConversationTabs(): Array<{
    id: string;
    title: string;
    fullTitle: string;
    isActive: boolean;
    isRunning: boolean;
    hasError: boolean;
    updatedAt: number;
  }> {
    return this.openConversationIds.map((id) => {
      const isActive = this.currentConversation?.id === id;
      const liveConversation = isActive ? this.currentConversation : null;
      const historyConversation = chatHistoryStore.conversations.find((conv) => conv.id === id);
      const runState = this.runStates[id];
      const fullTitle = liveConversation?.title?.trim() || historyConversation?.title?.trim() || 'New Chat';
      return {
        id,
        title: truncateConversationTitle(fullTitle, 28),
        fullTitle,
        isActive,
        isRunning: this.isConversationBusy(id),
        hasError: runState?.agentLoopState === 'failed',
        updatedAt: runState?.updatedAt ?? historyConversation?.updatedAt ?? liveConversation?.updatedAt ?? liveConversation?.createdAt ?? 0,
      };
    });
  }

  markConversationRunState(
    conversationId: string,
    patch: Partial<{ isStreaming: boolean; agentLoopState: AgentLoopState; updatedAt: number; lastError?: string | null }>,
  ): void {
    if (!conversationId) return;
    const previous = this.runStates[conversationId] ?? {
      isStreaming: false,
      agentLoopState: 'completed' as AgentLoopState,
      updatedAt: Date.now(),
      lastError: null,
    };
    this.runStates = {
      ...this.runStates,
      [conversationId]: {
        ...previous,
        ...patch,
        updatedAt: patch.updatedAt ?? Date.now(),
      },
    };
  }

  setConversationTitle(title: string, conversationId?: string): void {
    const targetId = conversationId ?? this.currentConversation?.id;
    if (!targetId) return;

    const nextTitle = normalizeConversationTitle(title) || 'New Chat';
    if (this.currentConversation?.id === targetId) {
      this.currentConversation = {
        ...this.currentConversation,
        title: nextTitle,
        updatedAt: Date.now(),
      };
    }
  }

  private hasConversationWorkInFlight(conversationId: string): boolean {
    const runtime = this.conversationRuntimeState[conversationId];
    const messages = this.getConversationMessages(conversationId);
    const hasStreamingMessage = messages.some(
      (message) => message.isStreaming || message.streamState === 'active',
    );
    const hasPendingTools = messages.some((message) =>
      (message.inlineToolCalls ?? []).some(
        (toolCall) => toolCall.status === 'running' || toolCall.status === 'pending',
      ),
    );

    return Boolean(runtime?.isStreaming) || Boolean(runtime?.abortController) || hasStreamingMessage || hasPendingTools;
  }

  isConversationBusy(conversationId: string | null | undefined): boolean {
    if (!conversationId) return this.isStreaming;
    const runState = this.runStates[conversationId];
    const loopLooksActive =
      Boolean(runState?.isStreaming) ||
      runState?.agentLoopState === 'running' ||
      runState?.agentLoopState === 'waiting_tool' ||
      runState?.agentLoopState === 'waiting_approval' ||
      runState?.agentLoopState === 'completing';
    if (!loopLooksActive) return false;
    return this.hasConversationWorkInFlight(conversationId);
  }

  healStaleConversationRunState(conversationId: string | null | undefined): boolean {
    if (!conversationId) return false;
    const runState = this.runStates[conversationId];
    if (!runState) return false;
    const loopLooksActive =
      Boolean(runState.isStreaming) ||
      runState.agentLoopState === 'running' ||
      runState.agentLoopState === 'waiting_tool' ||
      runState.agentLoopState === 'waiting_approval' ||
      runState.agentLoopState === 'completing';
    if (!loopLooksActive || this.hasConversationWorkInFlight(conversationId)) {
      return false;
    }

    this.completeStreamingForConversation(conversationId, 'completed');
    return true;
  }

  closeConversationTab(conversationId: string): void {
    if (!conversationId) return;
    const isCurrent = this.currentConversation?.id === conversationId;
    const isRunning = this.runStates[conversationId]?.isStreaming;
    if (isRunning) {
      this.stopStreamingForConversation(conversationId);
    }
    if (isCurrent) {
      this.commitActiveViewToRuntime(conversationId);
    }

    this.removeConversationTab(conversationId);
    const { [conversationId]: __removedRuntime, ...remainingRuntime } = this.conversationRuntimeState;
    this.conversationRuntimeState = remainingRuntime;
    if (this.currentConversation?.id !== conversationId) {
      this.saveOpenConversationIds();
      return;
    }

    const fallbackDecision = resolveConversationFallbackOnClose({
      closingConversationId: conversationId,
      openConversationIds: this.openConversationIds,
      historyConversationIds: chatHistoryStore.conversations.map((conv) => conv.id),
    });
    const switchToNewConversation = () => {
      this.newConversation();
      this.saveOpenConversationIds();
    };

    if (fallbackDecision.action === 'switch_open') {
      const fallbackId = fallbackDecision.conversationId;
      const fallbackRuntime = this.conversationRuntimeState[fallbackId];
      if (fallbackRuntime) {
        const fallbackSummary = chatHistoryStore.conversations.find((conv) => conv.id === fallbackId);
        this.switchToConversation(fallbackId, fallbackSummary);
        chatHistoryStore.activeConversationId = fallbackId;
      } else {
        const fallbackSummary = chatHistoryStore.conversations.find((conv) => conv.id === fallbackId);
        if (fallbackSummary) {
          void chatHistoryStore.getConversation(fallbackId)
            .then((fullConversation) => {
              this.loadConversation(fullConversation);
              chatHistoryStore.activeConversationId = fallbackId;
            })
            .catch(() => {
              switchToNewConversation();
            });
        } else {
          switchToNewConversation();
        }
      }
    } else if (fallbackDecision.action === 'switch_history') {
      const historyFallbackId = fallbackDecision.conversationId;
      const fallbackSummary = chatHistoryStore.conversations.find((conv) => conv.id === historyFallbackId);
      if (fallbackSummary) {
        void chatHistoryStore.getConversation(historyFallbackId)
          .then((fullConversation) => {
            this.loadConversation(fullConversation);
            chatHistoryStore.activeConversationId = historyFallbackId;
          })
          .catch(() => {
            switchToNewConversation();
          });
      } else {
        switchToNewConversation();
      }
    } else {
      switchToNewConversation();
    }

    this.saveOpenConversationIds();
  }

  private saveOpenConversationIds(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(OPEN_TAB_IDS_KEY, JSON.stringify(this.openConversationIds));
    } catch {
      // Ignore storage errors
    }
  }

  private loadOpenConversationIds(): void {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(OPEN_TAB_IDS_KEY);
      if (!stored) return;
      const ids = JSON.parse(stored);
      if (Array.isArray(ids)) {
        this.openConversationIds = ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      }
    } catch {
      // Ignore storage errors
    }
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
    return !this.autoApproveAllTools && doesToolRequireApproval(toolName);
  }

  setAutoApproveAllTools(enabled: boolean): void {
    this.autoApproveAllTools = enabled;
    this.saveAutoApproveAllTools();
  }

  toggleAutoApproveAllTools(): void {
    this.setAutoApproveAllTools(!this.autoApproveAllTools);
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
    if (this.currentMode === mode) return;
    this.currentMode = mode;

    const convId = this.currentConversation?.id;
    if (!convId) return;
    this.syncActiveComposerState({ currentMode: mode });
    if (this.currentConversation) {
      this.currentConversation = {
        ...this.currentConversation,
        mode,
      };
    }

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
    this.syncActiveComposerState({
      inputHistory: [...this.inputHistory],
      historyIndex: this.historyIndex,
      draftValue: this.draftValue,
      draftAttachments: [...this.draftAttachments],
    });
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
      this.syncActiveComposerState({
        historyIndex: this.historyIndex,
        draftValue: this.draftValue,
        draftAttachments: [...this.draftAttachments],
      });
      return this.inputHistory[this.historyIndex] ?? null;
    } else {
      // Down
      if (this.historyIndex === -1) return null;

      if (this.historyIndex < this.inputHistory.length - 1) {
        this.historyIndex++;
        this.syncActiveComposerState({ historyIndex: this.historyIndex });
        return this.inputHistory[this.historyIndex] ?? null;
      } else {
        // Returned to draft
        this.historyIndex = -1;
        this.syncActiveComposerState({ historyIndex: this.historyIndex });
        return {
          content: this.draftValue,
          attachments: [...this.draftAttachments],
        };
      }
    }
  }

  cycleMode(): void {
    const modes: AIMode[] = ['ask', 'plan', 'spec', 'agent'];
    const currentIndex = modes.indexOf(this.currentMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    this.currentMode = modes[nextIndex];
  }

  getConversationRunState(
    conversationId: string,
  ): { isStreaming: boolean; agentLoopState: AgentLoopState; updatedAt: number; lastError?: string | null } | null {
    return this.runStates[conversationId] ?? null;
  }

  // Message management
  addUserMessage(
    content: string,
    context?: AttachedContext[],
    smartContextBlock?: string,
    options: AddUserMessageOptions = {},
  ): string {
    // Sanitize user input to remove excessive repetition
    const sanitizedContent = sanitizeUserInput(content);
    const { visibleContent, hiddenReminderBlock } = stripSystemReminderTags(sanitizedContent);

    const id = crypto.randomUUID();
    const message: AssistantMessage = {
      id,
      role: 'user',
      content: visibleContent,
      timestamp: Date.now(),
      attachments: [...this.pendingAttachments], // Include pending attachments
      smartContextBlock,
      syntheticPrompt: options.syntheticPrompt,
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

    if (hiddenReminderBlock) {
      message.smartContextBlock = (message.smartContextBlock ? `${message.smartContextBlock}\n\n` : '') + `<system-reminder>\n${hiddenReminderBlock}\n</system-reminder>`;
    }

    const conversationId = this.currentConversation?.id;
    if (conversationId) {
      this.updateConversationMessages(conversationId, (messages) => [...messages, message]);
      if (this.currentConversation) {
        const nextTitle =
          options.suppressAutoTitle
            ? this.currentConversation.title || 'New Chat'
            : this.currentConversation.title && this.currentConversation.title !== 'New Chat'
            ? this.currentConversation.title
            : deriveConversationTitleFromUserText(visibleContent);
        this.currentConversation = {
          ...this.currentConversation,
          title: nextTitle,
          messages: this.messages,
        };
      }
      this.enforceInMemoryBudget();
    } else {
      this.messages = [...this.messages, message];
      this.bumpChatScrollRevision();
      this.enforceInMemoryBudget();
    }

    // Clear pending attachments after adding to message
    this.setPendingAttachments([]);

    this.saveCurrentConversationId();
    if (conversationId) {
      this.markConversationRunState(conversationId, {
        updatedAt: Date.now(),
      });
    }
    this.persistMessageToHistory(id, true);

    return id;
  }

  updateUserMessageSmartContext(
    messageId: string,
    smartContextBlock: string,
  ): void {
    const conversationId = this.currentConversation?.id;
    const patchMessage = (msg: AssistantMessage): AssistantMessage => ({
      ...msg,
      smartContextBlock,
      timestamp: msg.timestamp,
    });

    if (conversationId) {
      this.patchConversationMessage(conversationId, messageId, patchMessage);
    } else {
      this.patchActiveMessages(messageId, patchMessage);
    }

    void this.persistMessageToHistory(messageId, true);
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
    this.bumpChatScrollRevision();
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
      this.bumpChatScrollRevision();
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
    this.bumpChatScrollRevision();
    if (this.currentConversation) {
      this.currentConversation.messages = this.messages;
    }
  }

  addAssistantMessage(content: string, isStreaming = false): string {
    const id = crypto.randomUUID();
    const conversationId = this.currentConversation?.id;
    const message: AssistantMessage = {
      id,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      isStreaming,
      streamState: isStreaming ? 'active' : 'completed',
    };
    if (conversationId) {
      this.updateConversationMessages(conversationId, (messages) => [...messages, message]);
      if (this.currentConversation?.id === conversationId) {
        this.enforceInMemoryBudget();
      }
    } else {
      this.messages = [...this.messages, message];
      this.bumpChatScrollRevision();
      this.enforceInMemoryBudget();
    }

    this.saveCurrentConversationId();
    if (conversationId) {
      this.markConversationRunState(conversationId, {
        isStreaming,
        agentLoopState: isStreaming ? 'running' : 'completed',
      });
      debugAssistantSession('add_assistant_message', {
        conversationId,
        messageId: id,
        isStreaming,
      });
    }

    return id;
  }

  updateAssistantMessage(id: string, content: string, isStreaming = false): void {
    const conversationId = this.currentConversation?.id;
    const updateMessage = (msg: AssistantMessage): AssistantMessage => {
      const endTime = !isStreaming && msg.isStreaming ? Date.now() : msg.endTime;
      const contentParts = this.normalizeContentParts(msg.contentParts, content);
      const streamState =
        isStreaming
          ? 'active'
          : msg.streamState === 'interrupted' || msg.streamState === 'cancelled' || msg.streamState === 'failed'
            ? msg.streamState
            : 'completed';
      return { ...msg, content, isStreaming, endTime, contentParts, streamState };
    };

    if (conversationId) {
      this.patchConversationMessage(conversationId, id, updateMessage);
    } else {
      this.patchActiveMessages(id, updateMessage);
    }

    // Also update in currentConversation
    if (this.currentConversation && conversationId) {
      debugAssistantSession('update_assistant_message', {
        conversationId,
        messageId: id,
        isStreaming,
        contentLength: content.length,
      });
    }

    // Persist to database immediately
    this.persistMessageToHistory(id);
  }

  updateAssistantThinking(id: string, thinking: string, isThinking = true): void {
    const safeThinking = thinking.length > MAX_THINKING_CHARS
      ? thinking.slice(-MAX_THINKING_CHARS)
      : thinking;
    const conversationId =
      this.findConversationIdByMessageId(id) ??
      this.currentConversation?.id ??
      null;
    const updateMessage = (msg: AssistantMessage): AssistantMessage => ({
      ...msg,
      thinking: safeThinking,
      isThinking,
    });

    if (conversationId) {
      this.patchConversationMessage(conversationId, id, updateMessage);
    } else {
      this.patchActiveMessages(id, updateMessage);
    }

    // Persist to database immediately
    this.persistMessageToHistory(id);
  }

  addToolMessage(toolCall: ToolCall): string {
    const id = crypto.randomUUID();
    const conversationId = this.currentConversation?.id;
    const message: AssistantMessage = {
      id,
      role: 'tool',
      content: toolCall.output ?? '',
      timestamp: Date.now(),
      toolCalls: [toolCall]
    };
    if (conversationId) {
      this.updateConversationMessages(conversationId, (messages) => [...messages, message]);
      if (this.currentConversation?.id === conversationId) {
        this.enforceInMemoryBudget();
      }
    } else {
      this.messages = [...this.messages, message];
      this.bumpChatScrollRevision();
      this.enforceInMemoryBudget();
    }

    if (conversationId) {
      debugAssistantSession('add_tool_message', {
        conversationId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
    }

    this.saveCurrentConversationId();
    this.persistMessageToHistory(id);
    return id;
  }

  /**
   * Add a tool call to a specific assistant message (for inline display)
   */
  addToolCallToMessage(messageId: string, toolCall: ToolCall): void {
    const conversationId = this.currentConversation?.id;
    const addToolCall = (msg: AssistantMessage): AssistantMessage => {
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
      const existingInline = (msg.inlineToolCalls || []).some(
        (tc) => tc.id === ensuredToolCall.id,
      );
      const existingPart = (msg.contentParts || []).some(
        (part) => part.type === "tool" && part.toolCall.id === ensuredToolCall.id,
      );
      if (existingInline && existingPart) {
        return msg;
      }

      const inlineToolCalls = existingInline
        ? [...(msg.inlineToolCalls || [])]
        : [...(msg.inlineToolCalls || []), ensuredToolCall];
      const contentParts = [...(msg.contentParts || [])];
      if (!existingPart) {
        contentParts.push({ type: "tool", toolCall: ensuredToolCall });
      }
      return { ...msg, inlineToolCalls, contentParts };
    };

    if (conversationId) {
      this.patchConversationMessage(conversationId, messageId, addToolCall);
    } else {
      this.patchActiveMessages(messageId, addToolCall);
    }

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }

  /**
   * Update a tool call within a message
   */
  updateToolCallInMessage(messageId: string, toolCallId: string, updates: Partial<ToolCall>): void {
    const conversationId = this.findConversationIdByMessageId(messageId);
    const patchToolCall = (msg: AssistantMessage): AssistantMessage => {
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
    };

    if (conversationId) {
      this.patchConversationMessage(conversationId, messageId, patchToolCall);
    } else {
      this.patchActiveMessages(messageId, patchToolCall);
    }

    if (conversationId) {
      debugAssistantSession('update_tool_call_in_message', {
        conversationId,
        messageId,
        toolCallId,
        status: updates.status,
      });
    }

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }

  /**
   * Helper to persist a specific message to history database
   */
  private persistDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private cancelPendingPersists(messageIds: string[]): void {
    for (const messageId of messageIds) {
      const timer = this.persistDebounceTimers.get(messageId);
      if (!timer) continue;
      clearTimeout(timer);
      this.persistDebounceTimers.delete(messageId);
    }
  }

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

    const persisted = this.getMessageForPersistence(messageId);
    if (!persisted) return;
    const { message: msg, conversationId: convId, mode } = persisted;

    try {
      await chatHistoryStore.createConversation(convId, mode);

      await chatHistoryStore.saveMessage(convId, {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        metadata: serializeMessageMetadata(msg)
      });
    } catch (err) {
      console.error('[AssistantStore] Failed to persist message to history:', err);
    }
  }

  appendTextToMessage(messageId: string, text: string, isStreaming: boolean): void {
    const conversationId = this.currentConversation?.id;
    const appendText = (msg: AssistantMessage): AssistantMessage => {
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
    };
    if (conversationId) {
      this.patchConversationMessage(conversationId, messageId, appendText);
      if (this.currentConversation?.id === conversationId) {
        this.enforceInMemoryBudget();
      }
    } else {
      this.patchActiveMessages(messageId, appendText);
      this.enforceInMemoryBudget();
    }
    if (conversationId) {
      debugAssistantSession('append_text_to_message', {
        conversationId,
        messageId,
        chunkLength: text.length,
        isStreaming,
      });
    }

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }




  /**
   * Add or update thinking content in a message (for inline thinking like Cursor)
   * Creates a new thinking part if the last part isn't thinking, or appends to it
   */
  appendThinkingToMessage(messageId: string, thinking: string): void {
    const conversationId = this.currentConversation?.id;
    const appendThinking = (msg: AssistantMessage): AssistantMessage => {
      const parts = msg.contentParts ?? [];
      const lastPart = parts[parts.length - 1];

      let newParts: ContentPart[];
      if (lastPart && lastPart.type === 'thinking' && lastPart.isActive) {
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
        newParts = [...parts, {
          type: 'thinking' as const,
          thinking,
          startTime: Date.now(),
          isActive: true
        }];
      }

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
    };
    if (conversationId) {
      this.patchConversationMessage(conversationId, messageId, appendThinking);
    } else {
      this.patchActiveMessages(messageId, appendThinking);
    }

    // Persist to database immediately
    this.persistMessageToHistory(messageId);
  }

  /**
   * End the current thinking part (set endTime and title)
   * Called when thinking ends or when a tool/text part is about to be added
   */
  endThinkingPart(messageId: string): void {
    const conversationId = this.currentConversation?.id;
    const endThinking = (msg: AssistantMessage): AssistantMessage => {
      const parts = msg.contentParts ?? [];

      const newParts = parts.map(part => {
        if (part.type === 'thinking' && part.isActive) {
          const thinking = part.thinking;
          let title = '';

          const lines = thinking.split('\n').filter(l => l.trim());
          if (lines.length > 0) {
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
    };
    if (conversationId) {
      this.patchConversationMessage(conversationId, messageId, endThinking);
    } else {
      this.patchActiveMessages(messageId, endThinking);
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
    const conversationId =
      this.findConversationIdByMessageId(messageId) ??
      this.currentConversation?.id ??
      null;

    const updateMessage = (msg: AssistantMessage): AssistantMessage => {
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
    };

    if (conversationId) {
      this.patchConversationMessage(conversationId, messageId, updateMessage);
    } else {
      this.patchActiveMessages(messageId, updateMessage);
    }
  }

  markAssistantMessageStreamState(
    messageId: string,
    streamState: 'interrupted' | 'cancelled' | 'failed' | 'completed',
    streamIssue?: string,
  ): void {
    const conversationId =
      this.findConversationIdByMessageId(messageId) ??
      this.currentConversation?.id ??
      null;

    const applyPatch = (msg: AssistantMessage): AssistantMessage => ({
      ...msg,
      isStreaming: false,
      endTime: msg.endTime ?? Date.now(),
      streamState,
      streamIssue: streamIssue ?? msg.streamIssue,
    });

    if (conversationId) {
      this.patchConversationMessage(conversationId, messageId, applyPatch);
      this.markConversationRunState(conversationId, {
        isStreaming: false,
        agentLoopState: streamState === 'failed' ? 'failed' : streamState === 'cancelled' ? 'cancelled' : 'completed',
        lastError: streamState === 'failed' ? (streamIssue ?? this.runStates[conversationId]?.lastError ?? null) : null,
      });
      debugAssistantSession('mark_stream_state', {
        conversationId,
        messageId,
        streamState,
        streamIssue,
      });
    } else {
      this.patchActiveMessages(messageId, applyPatch);
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
      this.syncActiveComposerState({
        attachedContext: [...this.attachedContext],
      });
    }
  }

  removeContext(index: number): void {
    this.attachedContext = this.attachedContext.filter((_, i) => i !== index);
    this.syncActiveComposerState({
      attachedContext: [...this.attachedContext],
    });
  }

  clearContext(): void {
    this.attachedContext = [];
    this.syncActiveComposerState({ attachedContext: [] });
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

    this.setPendingAttachments([...this.pendingAttachments, attachment]);
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

    this.setPendingAttachments([...this.pendingAttachments, attachment]);
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

    this.setPendingAttachments([...this.pendingAttachments, attachment]);
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

    this.setPendingAttachments([...this.pendingAttachments, attachment]);
    return { success: true };
  }

  /**
   * Add a DOM element attachment from legacy/retired flows (shown as chip, context hidden)
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
    this.setPendingAttachments(this.pendingAttachments.filter(a => a.type !== 'element'));

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

    this.setPendingAttachments([...this.pendingAttachments, attachment]);
    return { success: true };
  }

  /**
   * Remove a pending attachment by ID
   */
  removeAttachment(id: string): void {
    this.setPendingAttachments(this.pendingAttachments.filter(a => a.id !== id));
  }

  /**
   * Clear all pending attachments
   */
  clearAttachments(): void {
    this.setPendingAttachments([]);
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
    if (this.currentConversation?.id) {
      this.updateConversationRuntime(this.currentConversation.id, (runtime) => ({
        ...runtime,
        isStreaming: true,
        abortController: controller,
      }));
      this.markConversationRunState(this.currentConversation.id, {
        isStreaming: true,
        agentLoopState: 'running',
        lastError: null,
      });
      debugAssistantSession('start_streaming', {
        conversationId: this.currentConversation.id,
      });
    }
    return controller;
  }

  stopStreamingForConversation(conversationId: string): void {
    const runtime = this.conversationRuntimeState[conversationId];
    if (!runtime) return;

    runtime.abortController?.abort();

    const nextLoopState: AgentLoopState =
      runtime.agentLoopState !== 'completed' && runtime.agentLoopState !== 'failed'
        ? 'cancelled'
        : runtime.agentLoopState;

    const cancelStreamingMessage = (msg: AssistantMessage): AssistantMessage =>
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
        : msg;

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

    const nextMessages = runtime.messages
      .map(cancelStreamingMessage)
      .map(cancelInlineToolCalls);
    this.applyConversationStatePatch(conversationId, {
      messages: nextMessages,
      isStreaming: false,
      abortController: null,
      agentLoopState: nextLoopState,
    });

    for (const msg of nextMessages) {
      if (msg.role === 'assistant') {
        this.finalizeThinking(msg.id);
      }
    }

    this.markConversationRunState(conversationId, {
      isStreaming: false,
      agentLoopState: nextLoopState,
    });
    debugAssistantSession('stop_streaming_for_conversation', {
      conversationId,
      agentLoopState: nextLoopState,
    });
  }

  stopStreaming(): void {
    const conversationId = this.currentConversation?.id ?? null;
    if (!conversationId) return;
    this.stopStreamingForConversation(conversationId);
  }

  completeStreamingForConversation(
    conversationId: string,
    outcome: 'completed' | 'failed',
    lastError?: string,
  ): void {
    const runtime = this.conversationRuntimeState[conversationId];
    if (!runtime) return;

    this.applyConversationStatePatch(conversationId, {
      isStreaming: false,
      abortController: null,
      agentLoopState: outcome === 'failed' ? 'failed' : 'completed',
    });

    this.markConversationRunState(conversationId, {
      isStreaming: false,
      agentLoopState: outcome === 'failed' ? 'failed' : 'completed',
      lastError: outcome === 'failed' ? (lastError ?? null) : null,
    });

    if (this.currentConversation?.id === conversationId) {
      this.isStreaming = false;
      this.abortController = null;
      this.agentLoopState = outcome === 'failed' ? 'failed' : 'completed';
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
    if (this.currentConversation?.id) {
      this.updateConversationRuntime(this.currentConversation.id, (runtime) => ({
        ...runtime,
        isStreaming: state === 'running' || state === 'waiting_tool' || state === 'waiting_approval' || state === 'completing',
        agentLoopState: state,
        agentLoopMeta: { ...meta, at: Date.now() },
      }));
      this.markConversationRunState(this.currentConversation.id, {
        isStreaming: state === 'running' || state === 'waiting_tool' || state === 'waiting_approval' || state === 'completing',
        agentLoopState: state,
        lastError: state === 'failed' ? String(meta?.error ?? meta?.message ?? this.runStates[this.currentConversation.id]?.lastError ?? '') || null : null,
      });
      debugAssistantSession('set_agent_loop_state', {
        conversationId: this.currentConversation.id,
        state,
      });
    }
    if (isAssistantDebugEnabled()) {
      console.info('[AssistantLoop] state', {
        from: previous,
        to: state,
        meta,
      });
    }
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
    const previousConversationId = this.currentConversation?.id ?? null;
    this.messages = [];
    this.inputValue = '';
    this.attachedContext = [];
    this.pendingAttachments = [];
    this.currentMode = 'agent';
    this.currentConversation = null;
    if (previousConversationId) {
      this.removeConversationTab(previousConversationId);
      this.saveOpenConversationIds();
    }
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
    this.syncActiveComposerState({
      inputValue: this.inputValue,
      historyIndex: this.historyIndex,
      draftValue: this.draftValue,
      draftAttachments: [...this.draftAttachments],
    });
  }

  setPendingAttachments(attachments: MessageAttachment[]): void {
    this.pendingAttachments = [...attachments];
    this.syncActiveComposerState({
      pendingAttachments: [...this.pendingAttachments],
    });
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
      } else if (this.openConversationIds.length > 0) {
        void this.restoreLastConversation(this.openConversationIds[this.openConversationIds.length - 1]);
      } else if (shouldCreateInitialConversation({
        currentConversationId: this.currentConversation?.id ?? null,
        storedConversationId: null,
        openConversationIds: this.openConversationIds,
      })) {
        this.initConversation();
      }
    } catch {
      // Ignore storage errors
      if (shouldCreateInitialConversation({
        currentConversationId: this.currentConversation?.id ?? null,
        storedConversationId: null,
        openConversationIds: this.openConversationIds,
      })) {
        this.initConversation();
      }
    }
  }

  private saveCurrentConversationId(): void {
    if (typeof window === 'undefined') return;
    try {
      if (this.currentConversation) {
        localStorage.setItem(CURRENT_CONV_ID_KEY, this.currentConversation.id);
      }
      this.saveOpenConversationIds();
    } catch {
      // Ignore storage errors
    }
  }

  private loadAutoApproveAllTools(): void {
    if (typeof window === 'undefined') return;
    try {
      this.autoApproveAllTools = localStorage.getItem(AUTO_APPROVE_ALL_KEY) === 'true';
    } catch {
      this.autoApproveAllTools = false;
    }
  }

  private saveAutoApproveAllTools(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(AUTO_APPROVE_ALL_KEY, this.autoApproveAllTools ? 'true' : 'false');
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
            chatHistoryStore.activeConversationId = conv.id;
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
          if (!this.currentConversation) {
            this.initConversation();
          }
        }
      } else if (!this.currentConversation) {
        this.initConversation();
      }
    } catch (err) {
      console.warn('[AssistantStore] Failed to restore last conversation:', err);
      if (!this.currentConversation) {
        this.initConversation();
      }
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
    isDirectory: boolean;
    isDeletion: boolean;
    isRename: boolean;
    addedLines: number;
    removedLines: number;
  }>> {
    const index = this.messages.findIndex(m => m.id === messageId);
    if (index === -1) return [];

    const filesToRevert = new Map<string, { before: string | null; isNew: boolean; isDirectory: boolean }>();
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
          const { absolutePath, beforeContent, isNewFile, isDirectory } = tc.meta.fileEdit as any;
          if (!filesToRevert.has(absolutePath)) {
            filesToRevert.set(absolutePath, {
              before: isNewFile ? null : beforeContent,
              isNew: isNewFile === true,
              isDirectory: isDirectory === true,
            });
          }
        }

        if (tc.meta.fileDeleted) {
          const { absolutePath, beforeContent, isDirectory } = tc.meta.fileDeleted as any;
          if (!isDirectory && beforeContent !== null && !filesToRevert.has(absolutePath)) {
            filesToRevert.set(absolutePath, { before: beforeContent, isNew: false, isDirectory: false });
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

    for (const [path, { before, isNew, isDirectory }] of filesToRevert.entries()) {
      const name = path.split(/[/\\]/).pop() || path;
      let addedLines = 0;
      let removedLines = 0;

      if (isNew) {
        if (!isDirectory) {
          // Find current line count to show as removal
          try {
            const currentContent = await readFile(path);
            removedLines = currentContent ? currentContent.split('\n').length : 0;
          } catch { }
        }
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
        name: isDirectory && isNew ? `${name}/` : name,
        isNewFile: isNew,
        isDirectory,
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
        isDirectory: false,
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
    const filesToRevert = new Map<string, { content: string | null; isDirectory: boolean }>(); // null means delete
    const filesToRenameBack = [] as Array<{ newPath: string; oldPath: string }>;
    const messagesToTruncate = this.messages.slice(index);

    // Iterate from latest to messageId (backward for correct undo order)
    for (let i = this.messages.length - 1; i > index; i--) {
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
          const { absolutePath, beforeContent, isNewFile, isDirectory } = tc.meta.fileEdit as any;
          // Chronologically first "beforeContent" (encountered last in backward loop) wins.
          // If isNewFile is true, we want to delete the file on revert.
          filesToRevert.set(absolutePath, {
            content: isNewFile === true ? null : beforeContent,
            isDirectory: isDirectory === true,
          });
        }

        // Handle file deletion
        if (tc.meta.fileDeleted) {
          const { absolutePath, beforeContent, isDirectory } = tc.meta.fileDeleted as any;
          if (!isDirectory && beforeContent !== null) {
            filesToRevert.set(absolutePath, { content: beforeContent, isDirectory: false });
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
      .filter(([, entry]) => entry.content === null)
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
      for (const [path, entry] of filesToRevert) {
        try {
          if (entry.content === null) {
            await invoke('delete_path', { path });
          } else {
            // Use fileService for consistent writes
            const result = await fileService.write(path, entry.content, { source: 'ai', force: true });
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
      for (const [path, entry] of filesToRevert) {
        if (entry.content === null) {
          // It was a new file/folder produced by the AI, so we just deleted it. Close tab if open.
          editorStore.closeFile(path, true);
        } else if (!entry.isDirectory) {
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
    const truncatedMessages = this.messages.slice(0, index);
    const removedMessageIds = messagesToTruncate.map((message) => message.id);
    this.cancelPendingPersists(removedMessageIds);

    let restoredInputValue = '';
    let restoredContext: AttachedContext[] = [];
    let restoredAttachments: MessageAttachment[] = [];
    if (userMsg.role === 'user') {
      restoredInputValue = userMsg.content;
      restoredContext = userMsg.contextMentions ? [...userMsg.contextMentions] : [];
      restoredAttachments = userMsg.attachments ? [...userMsg.attachments] : [];
    }

    // 4. Truncate in-memory history and reset composer/runtime state
    const currentConversationId = this.currentConversation?.id ?? null;
    if (currentConversationId) {
      this.applyConversationStatePatch(currentConversationId, {
        messages: truncatedMessages,
        inputValue: restoredInputValue,
        attachedContext: restoredContext,
        pendingAttachments: restoredAttachments,
        draftValue: restoredInputValue,
        draftAttachments: [...restoredAttachments],
        historyIndex: -1,
        isStreaming: false,
        abortController: null,
        agentLoopState: 'completed',
        agentLoopMeta: {},
      });
      this.markConversationRunState(currentConversationId, {
        isStreaming: false,
        agentLoopState: 'completed',
        lastError: null,
      });
    } else {
      this.messages = truncatedMessages;
      this.bumpChatScrollRevision();
      this.inputValue = restoredInputValue;
      this.attachedContext = restoredContext;
      this.pendingAttachments = restoredAttachments;
      this.draftValue = restoredInputValue;
      this.draftAttachments = [...restoredAttachments];
      this.historyIndex = -1;
      this.isStreaming = false;
      this.abortController = null;
      this.agentLoopState = 'completed';
      this.agentLoopMeta = {};
    }

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
export { AssistantStore };
export const assistantStore = new AssistantStore();
chatHistoryStore.setActiveConversationDeletedHandler(() => {
  const activeId = assistantStore.currentConversation?.id;
  if (activeId) {
    assistantStore.closeConversationTab(activeId);
    return;
  }
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

