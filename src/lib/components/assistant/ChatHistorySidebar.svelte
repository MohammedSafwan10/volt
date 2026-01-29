<script lang="ts">
    /**
     * ChatHistorySidebar - Slide-out sidebar for browsing chat history
     *
     * Features:
     * - Search conversations
     * - Date-grouped list (Pinned, Today, Yesterday, Last 7 days, etc.)
     * - New chat button
     * - Right-click context menu (Rename, Pin, Delete)
     * - Keyboard navigation
     */
    import { UIIcon } from "$lib/components/ui";
    import {
        chatHistoryStore,
        type ConversationSummary,
        type DateGroup,
    } from "$lib/stores/chat-history.svelte";
    import { assistantStore } from "$lib/stores/assistant.svelte";
    import { onMount } from "svelte";

    // Context menu state
    let contextMenu = $state<{
        x: number;
        y: number;
        conversation: ConversationSummary;
    } | null>(null);

    // Rename dialog state
    let renameDialog = $state<{
        conversation: ConversationSummary;
        newTitle: string;
    } | null>(null);

    // Load conversations on mount
    onMount(() => {
        chatHistoryStore.loadConversations();
    });

    // Close context menu when clicking outside
    function handleClickOutside(e: MouseEvent) {
        if (contextMenu) {
            contextMenu = null;
        }
    }

    function handleContextMenu(e: MouseEvent, conv: ConversationSummary) {
        e.preventDefault();
        contextMenu = {
            x: e.clientX,
            y: e.clientY,
            conversation: conv,
        };
    }

    async function handleSelectConversation(conv: ConversationSummary) {
        try {
            const fullConvo = await chatHistoryStore.getConversation(conv.id);
            // Load into assistant store
            assistantStore.loadConversation(fullConvo);
            chatHistoryStore.activeConversationId = conv.id;
            chatHistoryStore.closeSidebar();
        } catch (err) {
            console.error("[ChatHistory] Failed to load conversation:", err);
        }
    }

    function handleNewChat() {
        assistantStore.newConversation();
        chatHistoryStore.activeConversationId =
            assistantStore.currentConversation?.id ?? null;
        chatHistoryStore.closeSidebar();
    }

    async function handlePin() {
        if (!contextMenu) return;
        await chatHistoryStore.togglePin(contextMenu.conversation.id);
        contextMenu = null;
    }

    function handleRename() {
        if (!contextMenu) return;
        renameDialog = {
            conversation: contextMenu.conversation,
            newTitle: contextMenu.conversation.title,
        };
        contextMenu = null;
    }

    async function handleRenameSubmit() {
        if (!renameDialog) return;
        await chatHistoryStore.updateTitle(
            renameDialog.conversation.id,
            renameDialog.newTitle,
        );
        renameDialog = null;
    }

    async function handleDelete() {
        if (!contextMenu) return;
        const conv = contextMenu.conversation;
        contextMenu = null;

        // Confirm deletion
        if (confirm(`Delete "${conv.title}"?`)) {
            await chatHistoryStore.deleteConversation(conv.id);
        }
    }

    function handleSearchInput(e: Event) {
        const input = e.target as HTMLInputElement;
        chatHistoryStore.search(input.value);
    }

    const groupLabels: Record<DateGroup, string> = {
        pinned: "Pinned",
        today: "Today",
        yesterday: "Yesterday",
        last7days: "Last 7 days",
        last30days: "Last 30 days",
        older: "Older",
    };

    const groupOrder: DateGroup[] = [
        "pinned",
        "today",
        "yesterday",
        "last7days",
        "last30days",
        "older",
    ];

    // Format timestamp to 12-hour time format with proper date context
    function formatDateTime(timestamp: number): string {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        // Format time in 12-hour format
        const hours = date.getHours();
        const minutes = date.getMinutes().toString().padStart(2, "0");
        const ampm = hours >= 12 ? "PM" : "AM";
        const hour12 = hours % 12 || 12;
        const timeStr = `${hour12}:${minutes} ${ampm}`;

        // Today: just show time
        if (diffDays === 0 && date.getDate() === now.getDate()) {
            return timeStr;
        }

        // Yesterday: show "Yesterday, time"
        if (diffDays <= 1 && date.getDate() === now.getDate() - 1) {
            return `Yesterday, ${timeStr}`;
        }

        // This year: show "Jan 15, 2:30 PM"
        const months = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        ];
        if (date.getFullYear() === now.getFullYear()) {
            return `${months[date.getMonth()]} ${date.getDate()}, ${timeStr}`;
        }

        // Different year: show "Jan 15, 2024"
        return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    }
</script>

<svelte:window onclick={handleClickOutside} />

{#if chatHistoryStore.sidebarOpen}
    <!-- Backdrop -->
    <button
        class="sidebar-backdrop"
        onclick={() => chatHistoryStore.closeSidebar()}
        aria-label="Close chat history"
    ></button>

    <!-- Sidebar -->
    <aside class="chat-history-sidebar">
        <!-- Header -->
        <header class="sidebar-header">
            <h2>Chat History</h2>
            <button
                class="close-btn"
                onclick={() => chatHistoryStore.closeSidebar()}
            >
                <UIIcon name="close" size={18} />
            </button>
        </header>

        <!-- Search -->
        <div class="search-container">
            <UIIcon name="search" size={16} />
            <input
                type="text"
                placeholder="Search conversations..."
                value={chatHistoryStore.searchQuery}
                oninput={handleSearchInput}
            />
        </div>

        <!-- New Chat Button -->
        <button class="new-chat-btn" onclick={handleNewChat}>
            <UIIcon name="plus" size={18} />
            <span>New Chat</span>
        </button>

        <!-- Conversation List -->
        <div class="conversation-list">
            {#if chatHistoryStore.isLoading}
                <div class="loading">Loading...</div>
            {:else if chatHistoryStore.conversations.length === 0}
                <div class="empty-state">
                    <UIIcon name="comment" size={32} />
                    <p>No conversations yet</p>
                </div>
            {:else}
                {#each groupOrder as group}
                    {@const conversations =
                        chatHistoryStore.groupedConversations[group]}
                    {#if conversations.length > 0}
                        <div class="date-group">
                            <div class="group-label">
                                {#if group === "pinned"}
                                    <UIIcon name="pin" size={14} />
                                {/if}
                                {groupLabels[group]}
                            </div>
                            {#each conversations as conv (conv.id)}
                                <button
                                    class="conversation-item"
                                    class:active={chatHistoryStore.activeConversationId ===
                                        conv.id}
                                    onclick={() =>
                                        handleSelectConversation(conv)}
                                    oncontextmenu={(e) =>
                                        handleContextMenu(e, conv)}
                                >
                                    <div class="conv-icon">
                                        <UIIcon name="comment" size={16} />
                                    </div>
                                    <div class="conv-content">
                                        <div class="conv-title">
                                            {conv.title}
                                        </div>
                                        <div class="conv-meta">
                                            {conv.messageCount} messages
                                        </div>
                                    </div>
                                    <div class="conv-time">
                                        {formatDateTime(conv.updatedAt)}
                                    </div>
                                </button>
                            {/each}
                        </div>
                    {/if}
                {/each}
            {/if}
        </div>
    </aside>

    <!-- Context Menu -->
    {#if contextMenu}
        <div
            class="context-menu"
            style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
        >
            <button onclick={handlePin}>
                <UIIcon name="pin" size={16} />
                {contextMenu.conversation.isPinned ? "Unpin" : "Pin"}
            </button>
            <button onclick={handleRename}>
                <UIIcon name="pencil" size={16} />
                Rename
            </button>
            <button class="danger" onclick={handleDelete}>
                <UIIcon name="trash" size={16} />
                Delete
            </button>
        </div>
    {/if}

    <!-- Rename Dialog -->
    {#if renameDialog}
        <div class="dialog-backdrop">
            <div class="rename-dialog">
                <h3>Rename Conversation</h3>
                <input
                    type="text"
                    bind:value={renameDialog.newTitle}
                    onkeydown={(e) => e.key === "Enter" && handleRenameSubmit()}
                />
                <div class="dialog-actions">
                    <button class="cancel" onclick={() => (renameDialog = null)}
                        >Cancel</button
                    >
                    <button class="confirm" onclick={handleRenameSubmit}
                        >Rename</button
                    >
                </div>
            </div>
        </div>
    {/if}
{/if}

<style>
    .sidebar-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 999;
        border: none;
        cursor: default;
    }

    .chat-history-sidebar {
        position: fixed;
        top: 0;
        right: 0;
        width: 320px;
        height: 100vh;
        background: var(--bg-secondary, #1e1e1e);
        border-left: 1px solid var(--border-color, #333);
        z-index: 1000;
        display: flex;
        flex-direction: column;
        animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
        from {
            transform: translateX(100%);
        }
        to {
            transform: translateX(0);
        }
    }

    .sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px;
        border-bottom: 1px solid var(--border-color, #333);
    }

    .sidebar-header h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
    }

    .close-btn {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .close-btn:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
    }

    .search-container {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color, #333);
    }

    .search-container input {
        flex: 1;
        background: var(--bg-tertiary, #2a2a2a);
        border: 1px solid var(--border-color, #444);
        border-radius: 6px;
        padding: 8px 12px;
        color: var(--text-primary, #fff);
        font-size: 13px;
    }

    .search-container input:focus {
        outline: none;
        border-color: var(--accent-color, #007acc);
    }

    .new-chat-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 12px 16px;
        padding: 10px 16px;
        background: var(--accent-color, #007acc);
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: background 0.15s;
    }

    .new-chat-btn:hover {
        background: var(--accent-color-hover, #0066b8);
    }

    .conversation-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
    }

    .loading,
    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 48px 16px;
        color: var(--text-secondary, #888);
        gap: 12px;
    }

    .date-group {
        margin-bottom: 8px;
    }

    .group-label {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .conversation-item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 10px 16px;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        color: var(--text-primary, #fff);
        transition: background 0.1s;
    }

    .conversation-item:hover {
        background: var(--bg-hover, #2a2a2a);
    }

    .conversation-item.active {
        background: var(--bg-active, #333);
        border-left: 3px solid var(--accent-color, #007acc);
        padding-left: 13px;
    }

    .conv-icon {
        flex-shrink: 0;
        color: var(--text-secondary, #888);
    }

    .conv-content {
        flex: 1;
        min-width: 0;
    }

    .conv-title {
        font-size: 14px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .conv-meta {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-top: 2px;
    }

    .conv-time {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--text-tertiary, #666);
    }

    /* Context Menu */
    .context-menu {
        position: fixed;
        background: var(--bg-secondary, #252526);
        border: 1px solid var(--border-color, #444);
        border-radius: 8px;
        padding: 4px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        z-index: 1001;
        min-width: 140px;
    }

    .context-menu button {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 8px 12px;
        background: none;
        border: none;
        color: var(--text-primary, #fff);
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
    }

    .context-menu button:hover {
        background: var(--bg-hover, #333);
    }

    .context-menu button.danger {
        color: #f44336;
    }

    .context-menu button.danger:hover {
        background: rgba(244, 67, 54, 0.15);
    }

    /* Rename Dialog */
    .dialog-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1002;
    }

    .rename-dialog {
        background: var(--bg-secondary, #252526);
        border: 1px solid var(--border-color, #444);
        border-radius: 12px;
        padding: 20px;
        width: 340px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    .rename-dialog h3 {
        margin: 0 0 16px;
        font-size: 16px;
        font-weight: 600;
    }

    .rename-dialog input {
        width: 100%;
        padding: 10px 12px;
        background: var(--bg-tertiary, #1e1e1e);
        border: 1px solid var(--border-color, #444);
        border-radius: 6px;
        color: var(--text-primary, #fff);
        font-size: 14px;
        box-sizing: border-box;
    }

    .rename-dialog input:focus {
        outline: none;
        border-color: var(--accent-color, #007acc);
    }

    .dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 16px;
    }

    .dialog-actions button {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 14px;
        cursor: pointer;
        border: none;
    }

    .dialog-actions .cancel {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
    }

    .dialog-actions .confirm {
        background: var(--accent-color, #007acc);
        color: white;
    }

    .dialog-actions .confirm:hover {
        background: var(--accent-color-hover, #0066b8);
    }
</style>
