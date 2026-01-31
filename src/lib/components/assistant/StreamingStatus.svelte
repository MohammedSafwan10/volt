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
</script>

{#if isStreaming}
    <div class="streaming-status-container" in:fade={{ duration: 200 }}>
        <div class="streaming-status">
            {#if activeToolNames.length > 0}
                <div class="icon-wrapper spinning">
                    <UIIcon name="spinner" size={12} class="animate-spin" />
                </div>
            {/if}

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
        font-weight: 400;
        user-select: none;
        height: 24px;
        overflow: hidden;
        padding-left: 4px;
    }

    .icon-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-secondary);
        opacity: 0.7;
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
