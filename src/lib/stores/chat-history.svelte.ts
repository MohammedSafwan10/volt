/**
 * Chat History Store
 * 
 * Manages persistent chat history using SQLite via Tauri commands.
 * Provides conversation list, search, and CRUD operations.
 */

import { invoke } from '@tauri-apps/api/core';

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
    role: 'user' | 'assistant' | 'tool';
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
    // State
    conversations = $state<ConversationSummary[]>([]);
    isLoading = $state(false);
    searchQuery = $state('');
    sidebarOpen = $state(false);

    // Current active conversation ID (synced with assistant store)
    activeConversationId = $state<string | null>(null);

    /**
     * Load all conversations from the database
     */
    async loadConversations(): Promise<void> {
        this.isLoading = true;
        try {
            const convos = await invoke<ConversationSummary[]>('chat_list_conversations');
            this.conversations = convos;
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
        this.isLoading = true;
        try {
            const convos = await invoke<ConversationSummary[]>('chat_search_conversations', { query });
            this.conversations = convos;
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
        this.conversations = [convo, ...this.conversations];
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

        // Refresh conversation list to update timestamps and titles
        await this.loadConversations();
    }

    /**
     * Update conversation title
     */
    async updateTitle(conversationId: string, title: string): Promise<void> {
        await invoke('chat_update_title', { conversationId, title });

        // Update local state
        this.conversations = this.conversations.map(c =>
            c.id === conversationId ? { ...c, title } : c
        );
    }

    /**
     * Toggle pin status
     */
    async togglePin(conversationId: string): Promise<boolean> {
        const isPinned = await invoke<boolean>('chat_toggle_pin', { conversationId });

        // Update local state and re-sort
        this.conversations = this.conversations.map(c =>
            c.id === conversationId ? { ...c, isPinned } : c
        );

        // Re-sort: pinned first, then by updatedAt
        this.conversations = [...this.conversations].sort((a, b) => {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
            return b.updatedAt - a.updatedAt;
        });

        return isPinned;
    }

    /**
     * Delete a conversation
     */
    async deleteConversation(conversationId: string): Promise<void> {
        await invoke('chat_delete_conversation', { conversationId });

        // Remove from local state
        this.conversations = this.conversations.filter(c => c.id !== conversationId);

        // If we deleted the active conversation, clear it
        if (this.activeConversationId === conversationId) {
            this.activeConversationId = null;
        }
    }

    /**
     * Clear all chat history (dangerous!)
     */
    async clearAll(): Promise<void> {
        await invoke('chat_clear_all');
        this.conversations = [];
        this.activeConversationId = null;
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
    }

    openSidebar(): void {
        this.sidebarOpen = true;
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
