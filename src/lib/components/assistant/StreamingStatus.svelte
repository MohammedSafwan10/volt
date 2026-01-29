<script lang="ts">
    import { UIIcon } from "$lib/components/ui";
    import { onDestroy } from "svelte";
    import { fly, fade } from "svelte/transition";

    interface Props {
        isStreaming: boolean;
        isThinking: boolean;
        activeToolNames?: string[];
    }

    let { isStreaming, isThinking, activeToolNames = [] }: Props = $props();

    const toolDisplayNames: Record<string, string> = {
        workspace_search: "Searching workspace",
        list_dir: "Listing directory",
        read_file: "Reading file",
        write_file: "Writing to file",
        apply_edit: "Applying edits",
        run_command: "Running command",
        terminal_write: "Executing command",
        get_diagnostics: "Checking diagnostics",
        search_symbols: "Searching symbols",
    };

    const thinkingMessages = [
        "Thinking",
        "Analyzing requirements",
        "Synthesizing knowledge",
        "Deducing logical steps",
        "Reasoning about logic",
        "Processing codebase",
        "Evaluating solutions",
    ];

    const toolMessages = [
        "Running tools",
        "Executing actions",
        "Processing results",
        "Managing tasks",
        "Integrating data",
        "Reading workspace",
    ];

    const generatingMessages = [
        "Generating",
        "Formulating",
        "Constructing",
        "Finalizing",
        "Streaming",
        "Polishing content",
        "Crafting response",
    ];

    let currentMsgIndex = $state(0);
    let timer: any;

    function getMessages() {
        if (isThinking) return thinkingMessages;
        if (activeToolNames.length > 0) {
            const specificMsgs = activeToolNames
                .map((name) => toolDisplayNames[name])
                .filter(Boolean) as string[];
            return specificMsgs.length > 0
                ? [...specificMsgs, ...toolMessages]
                : toolMessages;
        }
        return generatingMessages;
    }

    function getIcon() {
        if (isThinking) return "chevron-right" as const;
        if (activeToolNames.length > 0) return "spinner" as const;
        return "pencil" as const;
    }

    $effect(() => {
        // Reset message cycle when core state changes to show most relevant msg first
        if (isThinking || activeToolNames.length > 0 || isStreaming) {
            currentMsgIndex = 0;
        }
    });

    $effect(() => {
        if (isStreaming) {
            if (!timer) {
                timer = setInterval(() => {
                    const msgs = getMessages();
                    currentMsgIndex = (currentMsgIndex + 1) % msgs.length;
                }, 3000);
            }
        } else {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }
    });

    onDestroy(() => {
        if (timer) clearInterval(timer);
    });

    const currentMessages = $derived(getMessages());
    const displayMsg = $derived(
        currentMessages[currentMsgIndex % currentMessages.length],
    );
</script>

{#if isStreaming}
    <div class="streaming-status-container" in:fade={{ duration: 200 }}>
        <div class="streaming-status">
            <div
                class="icon-wrapper"
                class:spinning={activeToolNames.length > 0}
            >
                <UIIcon name={getIcon()} size={12} />
            </div>

            <div class="status-content">
                {#key displayMsg}
                    <span
                        class="status-text"
                        in:fly={{ y: 8, duration: 400, opacity: 0 }}
                        out:fly={{ y: -8, duration: 400, opacity: 0 }}
                    >
                        {displayMsg}
                    </span>
                {/key}
            </div>

            <div class="loading-dots">
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
            </div>
        </div>
    </div>
{/if}

<style>
    .streaming-status-container {
        margin-top: 8px;
        display: flex;
        align-items: center;
    }

    .streaming-status {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--color-text-secondary);
        font-size: 11px;
        font-weight: 500;
        user-select: none;
        height: 24px;
        overflow: hidden;
        padding: 0 10px;
        background: rgba(var(--color-primary-rgb), 0.08);
        border-radius: 20px;
        border: 1px solid rgba(var(--color-primary-rgb), 0.1);
        backdrop-filter: blur(8px);
    }

    .status-content {
        position: relative;
        height: 100%;
        display: flex;
        align-items: center;
        min-width: 80px; /* Prevent dots jumping */
    }

    .icon-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-primary);
    }

    .icon-wrapper.spinning {
        animation: spin 2s linear infinite;
    }

    @keyframes spin {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(360deg);
        }
    }

    .status-text {
        position: absolute;
        left: 0;
        white-space: nowrap;
        font-family: inherit;
    }

    .loading-dots {
        display: flex;
        gap: 2px;
        margin-left: 2px;
    }

    .dot {
        width: 3px;
        height: 3px;
        background: currentColor;
        border-radius: 50%;
        animation: pulse 1.5s ease-in-out infinite;
    }

    .dot:nth-child(2) {
        animation-delay: 0.2s;
    }
    .dot:nth-child(3) {
        animation-delay: 0.4s;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 0.3;
            transform: scale(0.8);
        }
        50% {
            opacity: 1;
            transform: scale(1.2);
        }
    }
</style>
