/**
 * Assistant Store - Manages AI assistant panel state
 * Handles conversation, modes, and streaming state
 */

import type { AIMode } from './ai.svelte';

// Message roles
export type MessageRole = 'user' | 'assistant' | 'tool';

// Tool call status
export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// Tool call representation
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  output?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
  requiresApproval?: boolean;
}

// Chat message
export interface AssistantMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
}

// Attached context
export interface AttachedContext {
  type: 'file' | 'selection';
  path?: string;
  content: string;
  label: string;
}

// Panel width storage key
const PANEL_WIDTH_KEY = 'volt.assistant.panelWidth';
const DEFAULT_PANEL_WIDTH = 400;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 800;

class AssistantStore {
  // Panel state
  panelOpen = $state(false);
  panelWidth = $state(DEFAULT_PANEL_WIDTH);

  // Mode state
  currentMode = $state<AIMode>('ask');

  // Conversation state
  messages = $state<AssistantMessage[]>([]);
  
  // Input state
  inputValue = $state('');
  attachedContext = $state<AttachedContext[]>([]);

  // Streaming state
  isStreaming = $state(false);
  abortController = $state<AbortController | null>(null);

  // Current tool calls being displayed
  activeToolCalls = $state<ToolCall[]>([]);

  constructor() {
    this.loadPanelWidth();
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

  cycleMode(): void {
    const modes: AIMode[] = ['ask', 'plan', 'agent'];
    const currentIndex = modes.indexOf(this.currentMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    this.currentMode = modes[nextIndex];
  }

  // Message management
  addUserMessage(content: string, context?: AttachedContext[]): string {
    const id = crypto.randomUUID();
    const message: AssistantMessage = {
      id,
      role: 'user',
      content,
      timestamp: Date.now()
    };
    
    // Include context in message if provided
    if (context && context.length > 0) {
      message.content = this.formatMessageWithContext(content, context);
    }

    this.messages = [...this.messages, message];
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
    this.messages = this.messages.map(msg =>
      msg.id === id ? { ...msg, content, isStreaming } : msg
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

  // Context management
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
