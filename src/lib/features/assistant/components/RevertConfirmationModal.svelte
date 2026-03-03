<script lang="ts">
    import { UIIcon } from "$shared/components/ui";
    import { fade, fly } from "svelte/transition";
    import { quintOut } from "svelte/easing";

    interface PropRevertFile {
        path: string;
        name: string;
        addedLines?: number;
        removedLines?: number;
        isNewFile?: boolean;
        isDeletion?: boolean;
        isRename?: boolean;
    }

    interface Props {
        open: boolean;
        files: PropRevertFile[];
        onConfirm: () => void;
        onCancel: () => void;
    }

    let { open, files, onConfirm, onCancel }: Props = $props();

    function handleBackdropClick(e: MouseEvent): void {
        if (e.target === e.currentTarget) onCancel();
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter") onConfirm();
    }
</script>

{#if open}
    <div
        class="backdrop"
        role="presentation"
        onclick={handleBackdropClick}
        onkeydown={handleKeydown}
        tabindex="-1"
        transition:fade={{ duration: 200 }}
    >
        <div
            class="modal"
            role="dialog"
            aria-modal="true"
            transition:fly={{ y: 20, duration: 400, easing: quintOut }}
        >
            <div class="header">
                <h2 class="title">Confirm Undo</h2>
                <button class="close-btn" onclick={onCancel} aria-label="Close">
                    <UIIcon name="close" size={16} />
                </button>
            </div>

            <div class="content">
                <p class="description">
                    Confirming this undo action will make the following changes:
                </p>

                <div class="file-list">
                    {#each files as file}
                        <div class="file-item">
                            <div class="file-icon">
                                {#if file.isNewFile}
                                    <UIIcon
                                        name="file-plus"
                                        size={14}
                                        class="text-green"
                                    />
                                {:else if file.isDeletion}
                                    <UIIcon
                                        name="trash"
                                        size={14}
                                        class="text-error"
                                    />
                                {:else if file.isRename}
                                    <UIIcon
                                        name="replace"
                                        size={14}
                                        class="text-accent"
                                    />
                                {:else}
                                    <UIIcon name="pencil" size={14} />
                                {/if}
                            </div>
                            <span class="file-name">{file.name}</span>
                            <div class="diff-stats">
                                {#if file.addedLines !== undefined && file.addedLines > 0}
                                    <span class="added">+{file.addedLines}</span
                                    >
                                {/if}
                                {#if file.removedLines !== undefined && file.removedLines > 0}
                                    <span class="removed"
                                        >-{file.removedLines}</span
                                    >
                                {/if}
                                {#if file.isNewFile}
                                    <span class="tag new">NEW</span>
                                {:else if file.isDeletion}
                                    <span class="tag deleted">DELETED</span>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            </div>

            <div class="footer">
                <button class="btn cancel" onclick={onCancel}>Cancel</button>
                <button class="btn confirm" onclick={onConfirm}>Confirm</button>
            </div>
        </div>
    </div>
{/if}

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
    }

    .modal {
        width: 100%;
        max-width: 480px;
        background: var(--color-bg-elevated);
        border: 1px solid var(--color-border);
        border-radius: 12px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid var(--color-border);
    }

    .title {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--color-text);
    }

    .close-btn {
        background: none;
        border: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        display: flex;
        transition: all 0.2s;
    }

    .close-btn:hover {
        background: var(--color-hover);
        color: var(--color-text);
    }

    .content {
        padding: 20px;
        max-height: 400px;
        overflow-y: auto;
    }

    .description {
        margin: 0 0 16px 0;
        font-size: 14px;
        color: var(--color-text-secondary);
        line-height: 1.5;
    }

    .file-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .file-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
        background: rgba(var(--color-text-rgb), 0.03);
        border-radius: 8px;
        border: 1px solid transparent;
    }

    .file-icon {
        display: flex;
        color: var(--color-text-secondary);
    }

    .file-name {
        flex: 1;
        font-size: 13px;
        font-family: var(--font-mono, "JetBrains Mono", monospace);
        color: var(--color-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .diff-stats {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        font-weight: 600;
    }

    .added {
        color: #50fa7b;
    }

    .removed {
        color: #ff5555;
    }

    .tag {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 9px;
        text-transform: uppercase;
    }

    .tag.new {
        background: rgba(80, 250, 123, 0.1);
        color: #50fa7b;
    }

    .tag.deleted {
        background: rgba(255, 85, 85, 0.1);
        color: #ff5555;
    }

    .footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        padding: 16px 20px;
        background: rgba(0, 0, 0, 0.1);
        border-top: 1px solid var(--color-border);
    }

    .btn {
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        border: 1px solid transparent;
    }

    .btn.cancel {
        background: transparent;
        color: var(--color-text-secondary);
    }

    .btn.cancel:hover {
        background: var(--color-hover);
        color: var(--color-text);
    }

    .btn.confirm {
        background: var(--color-primary);
        color: white;
        box-shadow: 0 4px 12px rgba(var(--color-primary-rgb), 0.3);
    }

    .btn.confirm:hover {
        filter: brightness(1.1);
        transform: translateY(-1px);
    }

    .btn.confirm:active {
        transform: translateY(0);
    }

    :global(.text-green) {
        color: #50fa7b !important;
    }
    :global(.text-error) {
        color: #ff5555 !important;
    }
    :global(.text-accent) {
        color: var(--color-accent) !important;
    }
</style>
