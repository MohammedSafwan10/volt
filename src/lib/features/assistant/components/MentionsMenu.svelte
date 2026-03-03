<script lang="ts">
    /**
     * MentionsMenu - @ mentions popup for chat input
     * Shows categorized context items: Files, Directories, Terminals, etc.
     */
    import { UIIcon, type UIIconName } from "$shared/components/ui";
    import { projectStore } from "$shared/stores/project.svelte";
    import { terminalStore } from "$features/terminal/stores/terminal.svelte";
    import { chatHistoryStore } from "$features/assistant/stores/chat-history.svelte";
    import { mcpStore } from "$features/mcp/stores/mcp.svelte";
    import { searchFiles, indexUpdateTick } from "$core/services/file-index";

    interface MentionCategory {
        id: string;
        label: string;
        icon: UIIconName;
        prefix: string;
    }

    export interface MentionItem {
        id: string;
        label: string;
        sublabel?: string;
        icon: UIIconName;
        category: string;
        data?: unknown;
    }

    interface Props {
        query: string;
        onSelect: (item: MentionItem) => void;
        onClose: () => void;
    }

    let { query, onSelect, onClose }: Props = $props();

    // Categories matching Cursor's design
    const categories: MentionCategory[] = [
        { id: "code", label: "Code Context Items", icon: "code", prefix: "" },
        { id: "file", label: "Files", icon: "file", prefix: "file:" },
        {
            id: "directory",
            label: "Directories",
            icon: "folder",
            prefix: "directory:",
        },
        { id: "mcp", label: "MCP servers", icon: "plug", prefix: "mcp:" },
        {
            id: "conversation",
            label: "Conversations",
            icon: "comment",
            prefix: "conversation:",
        },
        {
            id: "terminal",
            label: "Terminal",
            icon: "terminal",
            prefix: "terminal:",
        },
    ];

    let selectedIndex = $state(0);
    let menuRef: HTMLDivElement | undefined = $state();

    // Parse query to extract category prefix
    const parsedQuery = $derived.by(() => {
        const q = query.toLowerCase();
        for (const cat of categories) {
            if (cat.prefix && q.startsWith(cat.prefix)) {
                return {
                    category: cat.id,
                    search: q.slice(cat.prefix.length),
                };
            }
        }
        return { category: null, search: q };
    });

    // Get files from project index using searchFiles
    const fileItems = $derived.by((): MentionItem[] => {
        // Track indexUpdateTick to re-run when index changes
        $indexUpdateTick;

        const search = parsedQuery.search;
        // Use project file index for real-time search
        const results = searchFiles(search, [], 15);
        return results.map((f) => ({
            id: f.path,
            label: f.name,
            sublabel: f.relativePath.replace(f.name, "").replace(/[/\\]$/, ""),
            icon: getFileIcon(f.path),
            category: "file",
            data: f,
        }));
    });

    // Get directories from project tree
    const directoryItems = $derived.by((): MentionItem[] => {
        $indexUpdateTick;
        const search = parsedQuery.search.toLowerCase();

        // Search the global file index for directories
        const results = searchFiles(search, [], 50).filter((f) => f.isDir);

        // Prioritize root-level directories
        results.sort((a, b) => {
            const aDepth = a.relativePath.split("/").length;
            const bDepth = b.relativePath.split("/").length;
            return aDepth - bDepth;
        });

        return results.slice(0, 15).map((d) => ({
            id: d.path,
            label: d.name,
            sublabel:
                d.relativePath === d.name
                    ? "Project Root"
                    : d.relativePath.replace(d.name, "").replace(/[/\\]$/, ""),
            icon: "folder" as UIIconName,
            category: "directory",
            data: d,
        }));
    });

    const terminalItems = $derived.by((): MentionItem[] => {
        return terminalStore.sessions.map((s) => ({
            id: s.id,
            label:
                terminalStore.getSessionLabel(s.id) ||
                `Terminal ${s.id.slice(0, 8)}`,
            sublabel: "",
            icon: "terminal" as UIIconName,
            category: "terminal",
            data: s,
        }));
    });

    const conversationItems = $derived.by((): MentionItem[] => {
        const search = parsedQuery.search.toLowerCase();
        return chatHistoryStore.conversations
            .filter(
                (c) =>
                    !search || (c.title || "").toLowerCase().includes(search),
            )
            .slice(0, 10)
            .map((c) => ({
                id: c.id,
                label: c.title || "Untitled",
                sublabel: chatHistoryStore.formatRelativeTime(c.updatedAt),
                icon: "comment" as UIIconName,
                category: "conversation",
                data: c,
            }));
    });

    const mcpItems = $derived.by((): MentionItem[] => {
        const search = parsedQuery.search.toLowerCase();
        return mcpStore.serverList
            .filter((s) => !search || s.name.toLowerCase().includes(search))
            .map((s) => ({
                id: s.id,
                label: s.name,
                sublabel: s.status,
                icon: "plug" as UIIconName,
                category: "mcp",
                data: s,
            }));
    });

    // Combine and filter items - deduplicate by id
    const allItems = $derived.by((): MentionItem[] => {
        const search = parsedQuery.search.toLowerCase();
        const cat = parsedQuery.category;

        // If no category filter is explicitly active, ALWAYS show category picker.
        // This prevents the "file dump" and forces users to pick a context type first as requested.
        if (!cat) {
            return categories
                .filter(
                    (c) => !search || c.label.toLowerCase().includes(search),
                )
                .map((c) => ({
                    id: `cat-${c.id}`,
                    label: c.label,
                    icon: c.icon,
                    category: "category",
                    data: c,
                }));
        }

        let items: MentionItem[] = [];

        // Get items based on ACTIVE category filter (e.g. after clicking "Files" or typing "file:")
        if (cat === "file") items = [...items, ...fileItems];
        if (cat === "directory") items = [...items, ...directoryItems];
        if (cat === "terminal") items = [...items, ...terminalItems];
        if (cat === "conversation") items = [...items, ...conversationItems];
        if (cat === "mcp") items = [...items, ...mcpItems];

        // Deduplicate by id to avoid each_key_duplicate errors
        const seen = new Set<string>();
        const unique = items.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });

        return unique.slice(0, 20);
    });

    function getFileIcon(path: string): UIIconName {
        const ext = path.split(".").pop()?.toLowerCase() || "";
        const iconMap: Record<string, UIIconName> = {
            ts: "typescript",
            tsx: "typescript",
            js: "javascript",
            jsx: "javascript",
            svelte: "svelte",
            rs: "rust",
            py: "python",
            json: "json",
            md: "markdown",
            css: "css",
            html: "html",
            dart: "dart",
            xml: "xml",
            yaml: "yaml",
            yml: "yaml",
            toml: "rust",
        };
        return iconMap[ext] || "file";
    }

    // Handle keyboard events - only intercept specific navigation keys
    function handleKeydown(e: KeyboardEvent): void {
        // Only handle specific navigation keys when menu is visible
        const navKeys = ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"];
        if (!navKeys.includes(e.key)) return;

        if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            selectedIndex = (selectedIndex + 1) % Math.max(1, allItems.length);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            selectedIndex =
                (selectedIndex - 1 + allItems.length) %
                Math.max(1, allItems.length);
        } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const selected = allItems[selectedIndex];
            if (selected) {
                onSelect(selected);
            }
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            onClose();
        } else if (e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const selected = allItems[selectedIndex];
            if (selected) {
                onSelect(selected);
            }
        }
    }

    // Use $effect to add capture-phase listener for reliable interception
    $effect(() => {
        window.addEventListener("keydown", handleKeydown, { capture: true });
        return () => {
            window.removeEventListener("keydown", handleKeydown, {
                capture: true,
            });
        };
    });

    // Reset selection when items change
    $effect(() => {
        if (selectedIndex >= allItems.length) {
            selectedIndex = Math.max(0, allItems.length - 1);
        }
    });

    // Scroll selected item into view
    $effect(() => {
        if (menuRef) {
            const selected = menuRef.querySelector(".mention-item.selected");
            selected?.scrollIntoView({ block: "nearest" });
        }
    });
</script>

<div class="mentions-menu" bind:this={menuRef} role="listbox">
    {#each allItems as item, i (item.id)}
        <button
            class="mention-item"
            class:selected={i === selectedIndex}
            role="option"
            aria-selected={i === selectedIndex}
            onclick={() => onSelect(item)}
            onmouseenter={() => (selectedIndex = i)}
            type="button"
        >
            <UIIcon name={item.icon} size={16} />
            <span class="mention-label">{item.label}</span>
            {#if item.sublabel}
                <span class="mention-sublabel">{item.sublabel}</span>
            {/if}
            {#if item.category === "category"}
                <span class="mention-arrow">→</span>
            {/if}
        </button>
    {/each}
    {#if allItems.length === 0}
        <div class="mention-empty">No results found</div>
    {/if}
</div>

<style>
    .mentions-menu {
        position: absolute;
        bottom: 100%;
        left: 0;
        right: 0;
        margin-bottom: 4px;
        max-height: 320px;
        overflow-y: auto;
        background: #0f0f0f;
        border: 1px solid #1a1a1a;
        border-radius: 10px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.8);
        padding: 6px 0;
        z-index: 1100;
        animation: menuIn 0.12s cubic-bezier(0, 0, 0.2, 1);
    }

    @keyframes menuIn {
        from {
            opacity: 0;
            transform: translateY(8px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    .mention-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: calc(100% - 12px);
        margin: 2px 6px;
        padding: 8px 12px;
        font-size: 14px;
        font-weight: 500;
        color: #e5e5e5;
        text-align: left;
        border-radius: 6px;
        transition: background 0.1s ease;
    }

    .mention-item:hover,
    .mention-item.selected {
        background: rgba(59, 130, 246, 0.15);
    }

    .mention-item.selected {
        color: #3b82f6;
    }

    .mention-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mention-sublabel {
        font-size: 12px;
        color: #737373;
        flex-shrink: 0;
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mention-arrow {
        color: #525252;
        margin-left: auto;
    }

    .mention-empty {
        padding: 16px;
        text-align: center;
        color: #525252;
        font-size: 13px;
    }

    /* Scrollbar styling */
    .mentions-menu::-webkit-scrollbar {
        width: 6px;
    }

    .mentions-menu::-webkit-scrollbar-track {
        background: transparent;
    }

    .mentions-menu::-webkit-scrollbar-thumb {
        background: #2e2e2e;
        border-radius: 3px;
    }

    .mentions-menu::-webkit-scrollbar-thumb:hover {
        background: #3f3f3f;
    }
</style>
