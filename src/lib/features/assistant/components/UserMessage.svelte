<script lang="ts">
  import { onDestroy } from "svelte";
  import { UIIcon } from "$shared/components/ui";
  import type {
    AssistantMessage,
    ImageAttachment,
    FileAttachment,
    FolderAttachment,
    SelectionAttachment,
  } from "$features/assistant/stores/assistant.svelte";
  import { showToast } from "$shared/stores/toast.svelte";

  interface Props {
    message: AssistantMessage;
    expanded?: boolean;
    onToggleExpand?: () => void;
    onImageClick?: (img: ImageAttachment) => void;
    onRevert?: (id: string) => void;
  }

  let {
    message,
    expanded = false,
    onToggleExpand,
    onImageClick,
    onRevert,
  }: Props = $props();

  let copyStatus = $state<"idle" | "copied">("idle");
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;

  const images = $derived(
    (message.attachments ?? []).filter(
      (a) => a.type === "image",
    ) as ImageAttachment[],
  );

  const files = $derived(
    (message.attachments ?? []).filter(
      (a) => a.type === "file",
    ) as FileAttachment[],
  );

  const folders = $derived(
    (message.attachments ?? []).filter(
      (a) => a.type === "folder",
    ) as FolderAttachment[],
  );

  const selections = $derived(
    (message.attachments ?? []).filter(
      (a) => a.type === "selection",
    ) as SelectionAttachment[],
  );

  const visibleContent = $derived(
    message.content
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  const isLong = $derived(visibleContent.length > 500);
  const syntheticPrompt = $derived(message.syntheticPrompt ?? null);
  const compactSyntheticSummary = $derived.by(() => {
    if (!syntheticPrompt) return "";
    if (syntheticPrompt.subtitle) return syntheticPrompt.subtitle;
    const firstLine = visibleContent.split(/\r?\n/).find((line) => line.trim().length > 0);
    return firstLine?.trim() ?? "";
  });

  function getSyntheticKindLabel(
    kind: "spec-phase" | "spec-task" | "spec-verify" | "spec-review-fix",
  ): string {
    if (kind === "spec-task") return "Task Run";
    if (kind === "spec-verify") return "Verify";
    if (kind === "spec-review-fix") return "Review Fix";
    return "Spec Step";
  }

  onDestroy(() => {
    if (copyTimeout) {
      clearTimeout(copyTimeout);
    }
  });

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function handleCopyMessage(): Promise<void> {
    const text = message.content?.trim() || "";
    if (!text) {
      showToast({ message: "Nothing to copy", type: "warning" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      copyStatus = "copied";
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        copyStatus = "idle";
      }, 1500);
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : "Failed to copy",
        type: "error",
      });
    }
  }
</script>

<div class="message-row user">
  <div class="user-bubble">
    {#if images.length > 0}
      <div
        class="message-images"
        class:single={images.length === 1}
        class:multiple={images.length > 1}
      >
        {#each images as img (img.id)}
          <button
            class="message-image-btn"
            onclick={() => onImageClick?.(img)}
            title="Click to view full image"
            type="button"
          >
            <img
              src="data:{img.mimeType};base64,{img.data}"
              alt={img.filename}
              class="message-image-thumb"
            />
          </button>
        {/each}
      </div>
    {/if}

    {#if files.length > 0 || folders.length > 0 || selections.length > 0 || (message.contextMentions && message.contextMentions.length > 0)}
      <div class="message-elements">
        {#each files as f (f.id)}
          <div class="element-chip">
            <UIIcon name="file" size={12} />
            <span class="element-label">{f.label}</span>
          </div>
        {/each}

        {#each folders as f (f.id)}
          <div class="element-chip">
            <UIIcon name="folder" size={12} />
            <span class="element-label">{f.label}</span>
          </div>
        {/each}

        {#each selections as s (s.id)}
          <div class="element-chip">
            <UIIcon name="code" size={12} />
            <span class="element-label">{s.label}</span>
          </div>
        {/each}

        {#if message.contextMentions}
          {#each message.contextMentions as ctx}
            <div class="element-chip context-mention-chip">
              <UIIcon name={ctx.type === "file" ? "file" : "code"} size={12} />
              <span class="element-label">{ctx.label}</span>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    {#if syntheticPrompt}
      <div class="synthetic-prompt-card">
        <div class="synthetic-prompt-header">
          <span class="synthetic-prompt-kind">{getSyntheticKindLabel(syntheticPrompt.kind)}</span>
          <span class="synthetic-prompt-title">{syntheticPrompt.title}</span>
        </div>
        {#if compactSyntheticSummary}
          <div class="synthetic-prompt-summary">{compactSyntheticSummary}</div>
        {/if}
        {#if visibleContent.trim()}
          <button class="expand-msg-btn" onclick={onToggleExpand} type="button">
            {expanded ? "Hide prompt" : "View prompt"}
          </button>
          {#if expanded}
            <div class="bubble-text synthetic-prompt-body">{visibleContent}</div>
          {/if}
        {/if}
      </div>
    {:else if visibleContent.trim()}
      <div class="bubble-text">
        {#if isLong && !expanded}
          {visibleContent.slice(0, 500)}...
        {:else}
          {visibleContent}
        {/if}
      </div>

      {#if isLong}
        <button class="expand-msg-btn" onclick={onToggleExpand} type="button">
          {expanded ? "Show less" : "Read more"}
        </button>
      {/if}
    {/if}

    <div class="message-meta">
      <span class="meta-time">{formatTime(message.timestamp)}</span>
      <div class="meta-actions">
        <button
          class="copy-btn"
          onclick={handleCopyMessage}
          title="Copy message"
          type="button"
          aria-label="Copy message"
        >
          <UIIcon name={copyStatus === "copied" ? "check" : "copy"} size={14} />
        </button>
        {#if onRevert && !syntheticPrompt}
          <button
            class="revert-btn"
            onclick={() => onRevert(message.id)}
            title="Revert to this message (undoes all subsequent AI changes)"
            type="button"
            aria-label="Revert"
          >
            <UIIcon name="undo" size={14} />
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .message-row {
    display: flex;
    gap: 10px;
    animation: slideIn 0.2s ease;
    justify-content: flex-end;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .user-bubble {
    max-width: 85%;
    padding: 8px 12px;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.5;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .bubble-text {
    white-space: pre-wrap;
    word-break: break-word;
    letter-spacing: -0.01em;
  }

  .synthetic-prompt-card {
    display: grid;
    gap: 6px;
  }

  .synthetic-prompt-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .synthetic-prompt-kind {
    flex: 0 0 auto;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
    background: color-mix(in srgb, var(--color-bg-secondary) 88%, transparent);
    color: var(--color-text-secondary);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .synthetic-prompt-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: var(--color-text);
  }

  .synthetic-prompt-summary {
    color: var(--color-text-secondary);
    font-size: 12px;
    line-height: 1.45;
  }

  .synthetic-prompt-body {
    margin-top: 2px;
    padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
  }

  .message-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
    gap: 10px;
  }

  .meta-time {
    font-size: 10px;
    color: var(--color-text-secondary);
    opacity: 0.6;
  }

  .meta-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    opacity: 0.9;
    transition: opacity 0.15s ease;
  }

  .copy-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 2px;
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0.9;
    margin-right: -4px;
    margin-bottom: -2px;
  }

  .revert-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 2px;
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0.9;
    margin-right: -4px;
    margin-bottom: -2px;
  }

  .copy-btn:hover,
  .revert-btn:hover {
    opacity: 1 !important;
    background: rgba(0, 0, 0, 0.2);
  }

  .message-images {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }

  .message-images.single {
    max-width: 200px;
  }
  .message-images.multiple {
    max-width: 100%;
  }

  .message-image-btn {
    display: block;
    padding: 0;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    transition:
      transform 0.15s ease,
      box-shadow 0.15s ease;
    background: transparent;
  }

  .message-image-btn:hover {
    transform: scale(1.02);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .message-image-thumb {
    display: block;
    max-width: 180px;
    max-height: 120px;
    width: auto;
    height: auto;
    object-fit: cover;
    border-radius: 6px;
  }

  .message-images.multiple .message-image-thumb {
    max-width: 80px;
    max-height: 80px;
  }

  .expand-msg-btn {
    display: inline-block;
    margin-top: 6px;
    background: transparent;
    border: none;
    padding: 0;
    font-size: 11px;
    font-weight: 600;
    color: inherit;
    opacity: 0.8;
    cursor: pointer;
    text-decoration: underline;
  }

  .expand-msg-btn:hover {
    opacity: 1;
  }

  .message-elements {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }

  .element-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: rgba(var(--color-text-rgb), 0.08);
    border: 1px solid rgba(var(--color-text-rgb), 0.05);
    border-radius: 6px;
    font-size: 11px;
    transition: all 0.15s ease;
  }

  .element-chip:hover {
    background: rgba(var(--color-text-rgb), 0.12);
    border-color: rgba(var(--color-text-rgb), 0.1);
  }

  .context-mention-chip {
    background: rgba(var(--color-primary-rgb), 0.1);
    border-color: rgba(var(--color-primary-rgb), 0.2);
    color: var(--color-primary);
  }

  .element-chip :global(.ui-icon) {
    opacity: 0.8;
  }

  .element-label {
    font-family: "JetBrains Mono", monospace;
    font-weight: 500;
  }

</style>
