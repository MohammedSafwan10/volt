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
    import { UIIcon } from "$shared/components/ui";
    import {
        chatHistoryStore,
        type ConversationSummary,
        type DateGroup,
    } from "$features/assistant/stores/chat-history.svelte";
    import { assistantStore } from "$features/assistant/stores/assistant.svelte";
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

    function handleCloseConversationTab(e: MouseEvent, conv: ConversationSummary) {
        e.stopPropagation();
        assistantStore.closeConversationTab(conv.id);
        if (chatHistoryStore.activeConversationId === conv.id) {
            chatHistoryStore.activeConversationId = assistantStore.currentConversation?.id ?? null;
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
        const trimmedTitle = renameDialog.newTitle.trim();
        if (!trimmedTitle) {
            renameDialog = null;
            return;
        }
        await chatHistoryStore.updateTitle(
            renameDialog.conversation.id,
            trimmedTitle,
        );
        if (assistantStore.currentConversation?.id === renameDialog.conversation.id) {
            assistantStore.currentConversation = {
                ...assistantStore.currentConversation,
                title: trimmedTitle,
            };
        }
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

    async function handleClearAll() {
        if (
            confirm(
                "Are you sure you want to clear ALL chat history? This cannot be undone.",
            )
        ) {
            await chatHistoryStore.clearAll();
        }
    }

    async function handleDeleteSelected() {
        const count = chatHistoryStore.selectedIds.size;
        if (count === 0) return;

        if (confirm(`Delete ${count} selected conversation(s)?`)) {
            await chatHistoryStore.deleteMultiple(
                Array.from(chatHistoryStore.selectedIds),
            );
        }
    }

    function handleToggleSelection(e: MouseEvent, id: string) {
        e.stopPropagation();
        chatHistoryStore.toggleSelection(id);
    }

    function handleSearchInput(e: Event) {
        const input = e.target as HTMLInputElement;
        void chatHistoryStore.search(input.value);
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
            <div class="header-main">
                <h2>Chat History</h2>
                <div class="header-actions">
                    {#if chatHistoryStore.conversations.length > 0}
                        <button
                            class="icon-btn delete-all"
                            onclick={handleClearAll}
                            title="Clear All History"
                        >
                            <UIIcon name="trash" size={16} />
                        </button>
                    {/if}
                    <button
                        class="icon-btn close-btn"
                        onclick={() => chatHistoryStore.closeSidebar()}
                    >
                        <UIIcon name="close" size={18} />
                    </button>
                </div>
            </div>
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

        <!-- Toolbar -->
        <div class="sidebar-toolbar">
            <button class="new-chat-btn" onclick={handleNewChat}>
                <UIIcon name="plus" size={18} />
                <span>New Chat</span>
            </button>
            {#if chatHistoryStore.conversations.length > 0}
                <button
                    class="select-mode-btn"
                    class:active={chatHistoryStore.isSelectionMode}
                    onclick={() =>
                        chatHistoryStore.isSelectionMode
                            ? chatHistoryStore.clearSelection()
                            : (chatHistoryStore.isSelectionMode = true)}
                >
                    {chatHistoryStore.isSelectionMode ? "Cancel" : "Select"}
                </button>
            {/if}
        </div>

        <!-- Conversation List -->
        <div class="conversation-list">
            {#if chatHistoryStore.isLoading}
                <div class="loading">Loading...</div>
            {:else if chatHistoryStore.conversations.length === 0}
                <div class="empty-state">
                    <div class="empty-icon">
                        <UIIcon name="comment" size={48} />
                    </div>
                    <h3>Start a Conversation</h3>
                    <p>
                        Your chat history will appear here once you start
                        interacting with the assistant.
                    </p>
                    <button class="empty-action-btn" onclick={handleNewChat}>
                        <UIIcon name="plus" size={16} />
                        <span>Start New Chat</span>
                    </button>
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
                                <div
                                    class="conversation-item-wrapper"
                                    class:selected={chatHistoryStore.selectedIds.has(
                                        conv.id,
                                    )}
                                >
                                    {#if chatHistoryStore.isSelectionMode}
                                        <button
                                            class="selection-checkbox"
                                            onclick={(e) =>
                                                handleToggleSelection(
                                                    e,
                                                    conv.id,
                                                )}
                                        >
                                            {#if chatHistoryStore.selectedIds.has(conv.id)}
                                                <UIIcon
                                                    name="check"
                                                    size={14}
                                                />
                                            {/if}
                                        </button>
                                    {/if}

                                    <div
                                        class="conversation-item"
                                        class:active={chatHistoryStore.activeConversationId ===
                                            conv.id}
                                        role="group"
                                        oncontextmenu={(e) =>
                                            handleContextMenu(e, conv)}
                                    >
                                        <button
                                            class="conversation-item-main"
                                            type="button"
                                            onclick={() =>
                                                chatHistoryStore.isSelectionMode
                                                    ? chatHistoryStore.toggleSelection(
                                                          conv.id,
                                                      )
                                                    : handleSelectConversation(
                                                          conv,
                                                      )}
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
                                        {#if assistantStore.openConversationIds.includes(conv.id)}
                                            <button
                                                class="conv-close"
                                                type="button"
                                                title="Close tab"
                                                aria-label="Close {conv.title} tab"
                                                onclick={(e) => handleCloseConversationTab(e, conv)}
                                            >
                                                <UIIcon name="close" size={12} />
                                            </button>
                                        {/if}
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {/if}
                {/each}
            {/if}
        </div>

        <!-- Batch Action Bar -->
        {#if chatHistoryStore.isSelectionMode && chatHistoryStore.selectedIds.size > 0}
            <div class="batch-action-bar">
                <div class="selection-info">
                    {chatHistoryStore.selectedIds.size} selected
                </div>
                <div class="batch-actions">
                    <button
                        class="text-btn"
                        onclick={() => chatHistoryStore.selectAll()}
                    >
                        Select All
                    </button>
                    <button
                        class="danger-btn"
                        onclick={handleDeleteSelected}
                        title="Delete Selected"
                    >
                        <UIIcon name="trash" size={16} />
                        <span>Delete</span>
                    </button>
                </div>
            </div>
        {/if}
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
        width: 340px;
        height: 100vh;
        background: var(--color-bg-panel);
        border-left: 1px solid var(--color-border);
        z-index: 1000;
        display: flex;
        flex-direction: column;
        animation: slideIn 0.2s ease-out;
        box-shadow: -18px 0 42px rgba(0, 0, 0, 0.32);
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
        padding: 18px 18px 14px;
        border-bottom: 1px solid var(--color-border);
    }

    .header-main {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .header-main h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 700;
        color: var(--color-text);
        letter-spacing: 0.01em;
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .icon-btn {
        background: color-mix(in srgb, var(--color-surface0) 88%, transparent);
        border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent);
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 6px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
    }

    .icon-btn:hover {
        background: color-mix(in srgb, var(--color-hover) 86%, transparent);
        color: var(--color-text);
        border-color: color-mix(in srgb, var(--color-border) 70%, var(--color-accent) 12%);
    }

    .icon-btn.delete-all:hover {
        color: #f44336;
        background: rgba(244, 67, 54, 0.1);
    }

    .search-container {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--color-border);
        color: var(--color-text-secondary);
    }

    .search-container input {
        flex: 1;
        background: color-mix(in srgb, var(--color-surface0) 90%, transparent);
        border: 1px solid color-mix(in srgb, var(--color-border) 92%, transparent);
        border-radius: 10px;
        padding: 10px 12px;
        color: var(--color-text);
        font-size: 13px;
    }

    .search-container input::placeholder {
        color: var(--color-text-secondary);
    }

    .search-container input:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 12%, transparent);
    }

    .sidebar-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 16px 18px 12px;
    }

    .new-chat-btn {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 11px 14px;
        background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface0));
        color: var(--color-text);
        border: 1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
        border-radius: 12px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
        transition: all 0.15s;
    }

    .new-chat-btn:hover {
        background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface0));
        border-color: color-mix(in srgb, var(--color-accent) 34%, var(--color-border));
        transform: translateY(-1px);
    }

    .select-mode-btn {
        padding: 10px 12px;
        background: color-mix(in srgb, var(--color-surface0) 90%, transparent);
        border: 1px solid color-mix(in srgb, var(--color-border) 90%, transparent);
        color: var(--color-text-secondary);
        border-radius: 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
    }

    .select-mode-btn:hover {
        background: color-mix(in srgb, var(--color-hover) 86%, transparent);
        color: var(--color-text);
    }

    .select-mode-btn.active {
        background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface0));
        color: var(--color-text);
        border-color: color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
    }

    .conversation-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
        display: flex;
        flex-direction: column;
    }

    .empty-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 32px;
        text-align: center;
        color: var(--color-text-secondary);
    }

    .empty-icon {
        width: 80px;
        height: 80px;
        background: color-mix(in srgb, var(--color-surface0) 92%, transparent);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 20px;
        color: var(--color-text-disabled);
        border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
    }

    .empty-state h3 {
        margin: 0 0 8px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--color-text);
    }

    .empty-state p {
        margin: 0 0 24px 0;
        font-size: 13px;
        line-height: 1.5;
        max-width: 200px;
    }

    .empty-action-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 11px 18px;
        background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface0));
        color: var(--color-text);
        border: 1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
        border-radius: 12px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s, background 0.15s, border-color 0.15s;
    }

    .empty-action-btn:hover {
        transform: translateY(-2px);
        background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface0));
        border-color: color-mix(in srgb, var(--color-accent) 34%, var(--color-border));
    }

    .loading {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-secondary);
        font-size: 13px;
    }

    .conversation-item-wrapper {
        display: flex;
        align-items: center;
        position: relative;
    }

    .conversation-item-wrapper.selected {
        background: color-mix(in srgb, var(--color-accent) 8%, transparent);
    }

    .selection-checkbox {
        flex-shrink: 0;
        width: 18px;
        height: 18px;
        margin-left: 16px;
        border: 2px solid color-mix(in srgb, var(--color-border) 78%, var(--color-text-secondary) 22%);
        border-radius: 4px;
        background: transparent;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
    }

    .conversation-item-wrapper.selected .selection-checkbox {
        background: var(--color-accent);
        border-color: var(--color-accent);
    }

    .conversation-item {
        display: flex;
        align-items: center;
        gap: 12px;
        background: none;
        border: none;
        text-align: left;
        color: var(--color-text);
        transition: background 0.1s;
        min-width: 0;
        border-radius: 12px;
        margin: 0 10px;
    }

    .conversation-item-main {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
        padding: 10px 16px;
        background: none;
        border: none;
        cursor: pointer;
        color: inherit;
        text-align: left;
        border-radius: 12px;
    }

    .conversation-item:hover {
        background: color-mix(in srgb, var(--color-hover) 88%, transparent);
    }

    .conversation-item.active {
        background: color-mix(in srgb, var(--color-active) 78%, var(--color-surface0));
        box-shadow: inset 2px 0 0 var(--color-accent);
    }

    .conv-icon {
        flex-shrink: 0;
        color: var(--color-text-secondary);
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
        font-size: 11px;
        color: var(--color-text-secondary);
        margin-top: 2px;
    }

    .conv-time {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--color-text-disabled);
    }

    .conv-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 6px;
        color: var(--color-text-secondary);
        flex-shrink: 0;
        margin-right: 10px;
    }

    .conv-close:hover {
        background: color-mix(in srgb, var(--color-hover) 88%, transparent);
        color: var(--color-text);
    }

    /* Batch Action Bar */
    .batch-action-bar {
        position: sticky;
        bottom: 0;
        background: var(--color-bg-panel);
        border-top: 1px solid var(--color-border);
        padding: 12px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.2);
        animation: slideUp 0.15s ease-out;
    }

    @keyframes slideUp {
        from {
            transform: translateY(100%);
        }
        to {
            transform: translateY(0);
        }
    }

    .selection-info {
        font-size: 13px;
        font-weight: 500;
        color: var(--color-text);
    }

    .batch-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .text-btn {
        background: none;
        border: none;
        color: var(--color-text);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        padding: 4px 8px;
    }

    .danger-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: #f44336;
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
    }

    .danger-btn:hover {
        background: #d32f2f;
    }

    /* Context Menu */
    .context-menu {
        position: fixed;
        background: var(--color-surface0);
        border: 1px solid var(--color-border);
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
        color: var(--color-text);
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
    }

    .context-menu button:hover {
        background: color-mix(in srgb, var(--color-hover) 88%, transparent);
    }

    .context-menu button.danger {
        color: #f44336;
    }

    .context-menu button.danger:hover {
        background: rgba(244, 67, 54, 0.15);
    }

    .date-group {
        margin-bottom: 8px;
    }

    .group-label {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        font-size: 11px;
        font-weight: 600;
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
</style>
