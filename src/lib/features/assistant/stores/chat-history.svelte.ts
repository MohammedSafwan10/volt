/**
 * Chat History Store
 * 
 * Manages persistent chat history using SQLite via Tauri commands.
 * Provides conversation list, search, and CRUD operations.
 */

import { invoke } from '@tauri-apps/api/core';
import { sanitizeVisibleAssistantText } from './assistant-message-routing';

// ============================================================================
// Types
// ============================================================================

export interface ConversationSummary {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    firstUserMessage: string | null;
    isPinned: boolean;
    mode: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    timestamp: number;
    metadata?: string; // JSON-encoded extra data
}

export interface Conversation {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    isPinned: boolean;
    mode: string;
    messages: ChatMessage[];
}

// Date grouping for UI
export type DateGroup = 'pinned' | 'today' | 'yesterday' | 'last7days' | 'last30days' | 'older';

export interface GroupedConversations {
    pinned: ConversationSummary[];
    today: ConversationSummary[];
    yesterday: ConversationSummary[];
    last7days: ConversationSummary[];
    last30days: ConversationSummary[];
    older: ConversationSummary[];
}

// ============================================================================
// Store
// ============================================================================

class ChatHistoryStore {
    private sanitizeVisibleHistoryText(content: string): string {
        return sanitizeVisibleAssistantText(content);
    }

    // State
    conversations = $state<ConversationSummary[]>([]);
    private allConversations = $state<ConversationSummary[]>([]);
    isLoading = $state(false);
    searchQuery = $state('');
    sidebarOpen = $state(false);

    // Current active conversation ID (synced with assistant store)
    activeConversationId = $state<string | null>(null);

    // Selection state for batch operations
    selectedIds = $state<Set<string>>(new Set());
    isSelectionMode = $state(false);
    private onActiveConversationDeleted: (() => void) | null = null;

    setActiveConversationDeletedHandler(handler: (() => void) | null): void {
        this.onActiveConversationDeleted = handler;
    }

    /**
     * Load all conversations from the database
     */
    async loadConversations(): Promise<void> {
        this.isLoading = true;
        try {
            const convos = await invoke<ConversationSummary[]>('chat_list_conversations');
            this.allConversations = convos.map((convo) => ({
                ...convo,
                title: this.sanitizeVisibleHistoryText(convo.title),
                firstUserMessage: convo.firstUserMessage ? this.sanitizeVisibleHistoryText(convo.firstUserMessage) : null,
            }));
            this.applyVisibleConversations();
        } catch (err) {
            console.error('[ChatHistory] Failed to load conversations:', err);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Search conversations by content
     */
    async search(query: string): Promise<void> {
        this.searchQuery = query;
        if (!query.trim()) {
            this.applyVisibleConversations();
            return;
        }

        this.isLoading = true;
        try {
            const convos = await invoke<ConversationSummary[]>('chat_search_conversations', { query });
            this.conversations = convos.map((convo) => ({
                ...convo,
                title: this.sanitizeVisibleHistoryText(convo.title),
                firstUserMessage: convo.firstUserMessage ? this.sanitizeVisibleHistoryText(convo.firstUserMessage) : null,
            }));
        } catch (err) {
            console.error('[ChatHistory] Search failed:', err);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Create a new conversation
     */
    async createConversation(id: string, mode: string): Promise<ConversationSummary> {
        const convo = await invoke<ConversationSummary>('chat_create_conversation', { id, mode });
        this.upsertConversationSummary(convo);
        this.activeConversationId = id;
        return convo;
    }

    /**
     * Load a full conversation with messages
     */
    async getConversation(id: string): Promise<Conversation> {
        return await invoke<Conversation>('chat_get_conversation', { conversationId: id });
    }

    /**
     * Save a message to a conversation
     */
    async saveMessage(conversationId: string, message: ChatMessage): Promise<void> {
        await invoke('chat_save_message', { conversationId, message });

        const visibleContent = this.sanitizeVisibleHistoryText(message.content);

        const existing = this.conversations.find(c => c.id === conversationId);
        const nextTitle =
            existing?.title && existing.title !== 'New Chat'
                ? existing.title
                : (message.role === 'user'
                    ? (visibleContent.length > 50 ? `${visibleContent.slice(0, 50)}...` : visibleContent)
                    : existing?.title || 'New Chat');

        const updatedSummary: ConversationSummary = existing
            ? {
                ...existing,
                title: nextTitle,
                updatedAt: Date.now(),
                messageCount: Math.max(existing.messageCount, 0) + 1,
                firstUserMessage: existing.firstUserMessage ?? (message.role === 'user' ? visibleContent : null),
            }
            : {
                id: conversationId,
                title: nextTitle,
                createdAt: message.timestamp,
                updatedAt: Date.now(),
                messageCount: 1,
                firstUserMessage: message.role === 'user' ? visibleContent : null,
                isPinned: false,
                mode: 'agent',
            };

        this.upsertConversationSummary(updatedSummary);
    }

    /**
     * Update conversation title
     */
    async updateTitle(conversationId: string, title: string): Promise<void> {
        const trimmedTitle = title.trim();
        if (!trimmedTitle) return;

        await invoke('chat_update_title', { conversationId, title: trimmedTitle });

        // Update local state
        this.upsertConversationSummary({
            ...(this.allConversations.find(c => c.id === conversationId) ?? this.conversations.find(c => c.id === conversationId) ?? {
                id: conversationId,
                title: trimmedTitle,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messageCount: 0,
                firstUserMessage: null,
                isPinned: false,
                mode: 'agent',
            }),
            title: trimmedTitle,
        });
    }

    /**
     * Update conversation mode (ask/plan/agent)
     */
    async updateMode(conversationId: string, mode: string): Promise<void> {
        await invoke('chat_update_mode', { conversationId, mode });

        const existing = this.allConversations.find(c => c.id === conversationId) ?? this.conversations.find(c => c.id === conversationId);
        if (existing) {
            this.upsertConversationSummary({ ...existing, mode, updatedAt: Date.now() });
        }
    }

    /**
     * Toggle pin status
     */
    async togglePin(conversationId: string): Promise<boolean> {
        const isPinned = await invoke<boolean>('chat_toggle_pin', { conversationId });

        // Update local state and re-sort
        const existing = this.allConversations.find(c => c.id === conversationId) ?? this.conversations.find(c => c.id === conversationId);
        if (existing) {
            this.upsertConversationSummary({ ...existing, isPinned });
        }

        return isPinned;
    }

    /**
     * Delete a conversation
     */
    async deleteConversation(conversationId: string): Promise<void> {
        await invoke('chat_delete_conversation', { conversationId });

        // Check if we're deleting the active conversation BEFORE clearing state
        const deletingActive = this.activeConversationId === conversationId;

        // Remove from local state
        this.allConversations = this.allConversations.filter(c => c.id !== conversationId);
        this.applyVisibleConversations();
        this.selectedIds.delete(conversationId);

        // If we deleted the active conversation, clear it from both stores
        if (deletingActive) {
            this.activeConversationId = null;
            this.onActiveConversationDeleted?.();
        }

        if (this.selectedIds.size === 0) {
            this.isSelectionMode = false;
        }
    }

    /**
     * Delete multiple conversations at once
     */
    async deleteMultiple(ids: string[]): Promise<void> {
        this.isLoading = true;
        try {
            // Check if we're deleting the active conversation BEFORE clearing state
            const deletingActive = ids.includes(this.activeConversationId || '');

            // Sequential deletion for safety with SQLite, or we could add a backend command for batch
            for (const id of ids) {
                await invoke('chat_delete_conversation', { conversationId: id });
            }

            // Update local state
            this.allConversations = this.allConversations.filter(c => !ids.includes(c.id));
            this.applyVisibleConversations();
            ids.forEach(id => this.selectedIds.delete(id));

            if (deletingActive) {
                this.activeConversationId = null;
                this.onActiveConversationDeleted?.();
            }

            if (this.selectedIds.size === 0) {
                this.isSelectionMode = false;
            }
        } catch (err) {
            console.error('[ChatHistory] Batch delete failed:', err);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Clear all chat history (dangerous!)
     */
    async clearAll(): Promise<void> {
        this.isLoading = true;
        try {
            await invoke('chat_clear_all');
            this.allConversations = [];
            this.conversations = [];
            this.activeConversationId = null;
            this.selectedIds.clear();
            this.isSelectionMode = false;
            this.onActiveConversationDeleted?.();
        } catch (err) {
            console.error('[ChatHistory] Clear all failed:', err);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Selection Helpers
     */
    toggleSelection(id: string): void {
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
        } else {
            this.selectedIds.add(id);
        }
        // Force reactivity for the Set
        this.selectedIds = new Set(this.selectedIds);

        if (this.selectedIds.size > 0) {
            this.isSelectionMode = true;
        } else {
            this.isSelectionMode = false;
        }
    }

    clearSelection(): void {
        this.selectedIds = new Set();
        this.isSelectionMode = false;
    }

    selectAll(): void {
        this.selectedIds = new Set(this.conversations.map(c => c.id));
        this.isSelectionMode = true;
    }

    /**
     * Group conversations by date for UI display
     */
    get groupedConversations(): GroupedConversations {
        const now = Date.now();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStart = today.getTime();

        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStart = yesterday.getTime();

        const last7days = new Date(today);
        last7days.setDate(last7days.getDate() - 7);
        const last7daysStart = last7days.getTime();

        const last30days = new Date(today);
        last30days.setDate(last30days.getDate() - 30);
        const last30daysStart = last30days.getTime();

        const groups: GroupedConversations = {
            pinned: [],
            today: [],
            yesterday: [],
            last7days: [],
            last30days: [],
            older: []
        };

        for (const conv of this.conversations) {
            if (conv.isPinned) {
                groups.pinned.push(conv);
            } else if (conv.updatedAt >= todayStart) {
                groups.today.push(conv);
            } else if (conv.updatedAt >= yesterdayStart) {
                groups.yesterday.push(conv);
            } else if (conv.updatedAt >= last7daysStart) {
                groups.last7days.push(conv);
            } else if (conv.updatedAt >= last30daysStart) {
                groups.last30days.push(conv);
            } else {
                groups.older.push(conv);
            }
        }

        return groups;
    }

    /**
     * Toggle sidebar visibility
     */
    toggleSidebar(): void {
        this.sidebarOpen = !this.sidebarOpen;
        // Refresh list when opening
        if (this.sidebarOpen) {
            this.loadConversations();
        }
    }

    openSidebar(): void {
        this.sidebarOpen = true;
        // Refresh list when opening
        this.loadConversations();
    }

    private applyVisibleConversations(): void {
        if (!this.searchQuery.trim()) {
            this.conversations = [...this.allConversations].sort((a, b) => {
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;
                return b.updatedAt - a.updatedAt;
            });
            return;
        }

        const query = this.searchQuery.trim().toLowerCase();
        this.conversations = this.allConversations
            .filter((c) =>
                c.title.toLowerCase().includes(query) ||
                c.firstUserMessage?.toLowerCase().includes(query),
            )
            .sort((a, b) => {
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;
                return b.updatedAt - a.updatedAt;
            });
    }

    private upsertConversationSummary(summary: ConversationSummary): void {
        this.allConversations = [
            summary,
            ...this.allConversations.filter((c) => c.id !== summary.id),
        ];
        this.applyVisibleConversations();
    }

    closeSidebar(): void {
        this.sidebarOpen = false;
    }

    /**
     * Format relative time for display
     */
    formatRelativeTime(timestamp: number): string {
        const now = Date.now();
        const diff = now - timestamp;

        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return 'now';
        if (minutes < 60) return `${minutes}m`;
        if (hours < 24) return `${hours}h`;
        if (days < 7) return `${days}d`;

        // Show date for older
        const date = new Date(timestamp);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
}

export const chatHistoryStore = new ChatHistoryStore();
