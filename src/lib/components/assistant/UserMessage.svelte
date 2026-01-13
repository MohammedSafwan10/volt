<script lang="ts">
  import { UIIcon } from "$lib/components/ui";
  import type { AssistantMessage, ImageAttachment, ElementAttachment } from "$lib/stores/assistant.svelte";

  interface Props {
    message: AssistantMessage;
    expanded?: boolean;
    onToggleExpand?: () => void;
    onImageClick?: (img: ImageAttachment) => void;
  }

  let { message, expanded = false, onToggleExpand, onImageClick }: Props = $props();

  const images = $derived(
    (message.attachments ?? []).filter((a) => a.type === "image") as ImageAttachment[]
  );

  const elements = $derived(
    (message.attachments ?? []).filter((a) => a.type === "element") as ElementAttachment[]
  );

  const isLong = $derived(message.content.length > 500);

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<div class="message-row user">
  <div class="user-bubble">
    {#if images.length > 0}
      <div class="message-images" class:single={images.length === 1} class:multiple={images.length > 1}>
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

    {#if elements.length > 0}
      <div class="message-elements">
        {#each elements as el (el.id)}
          <div class="element-chip">
            <UIIcon name="target" size={12} />
            <span class="element-label">{el.label}</span>
            <span class="element-size">{Math.round(el.rect.width)}×{Math.round(el.rect.height)}</span>
          </div>
        {/each}
      </div>
    {/if}
    
    {#if message.content.trim()}
      <div class="bubble-text">
        {#if isLong && !expanded}
          {message.content.slice(0, 500)}...
        {:else}
          {message.content}
        {/if}
      </div>

      {#if isLong}
        <button class="expand-msg-btn" onclick={onToggleExpand} type="button">
          {expanded ? "Show less" : "Read more"}
        </button>
      {/if}
    {/if}
    
    <span class="bubble-time">{formatTime(message.timestamp)}</span>
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
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .user-bubble {
    max-width: 80%;
    padding: 10px 14px;
    background: var(--color-accent);
    color: var(--color-bg);
    border-radius: 16px 16px 4px 16px;
    font-size: 13px;
    line-height: 1.5;
  }

  .bubble-text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .bubble-time {
    display: block;
    font-size: 10px;
    opacity: 0.7;
    margin-top: 4px;
    text-align: right;
  }

  .message-images {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }

  .message-images.single { max-width: 200px; }
  .message-images.multiple { max-width: 100%; }

  .message-image-btn {
    display: block;
    padding: 0;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
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

  .expand-msg-btn:hover { opacity: 1; }

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
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    font-size: 11px;
  }

  .element-chip :global(.ui-icon) {
    opacity: 0.8;
  }

  .element-label {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 500;
  }

  .element-size {
    opacity: 0.7;
    font-size: 10px;
  }
</style>
