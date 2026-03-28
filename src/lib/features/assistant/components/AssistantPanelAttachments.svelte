<script lang="ts">
  import { fly, scale } from "svelte/transition";

  import { UIIcon } from "$shared/components/ui";
  import type { AttachedContext } from "$features/assistant/stores/assistant.svelte";

  interface AttachmentPreview {
    id: string;
    type: string;
    label: string;
    isImage?: boolean;
    thumbnailData?: string;
    mimeType?: "image/png" | "image/jpeg" | "image/webp";
    dimensions?: string;
    size?: string;
  }

  interface Props {
    attachmentPreviews: AttachmentPreview[];
    attachedContext: AttachedContext[];
    onPreviewImage: (preview: AttachmentPreview) => void;
    onRemoveAttachment: (id: string) => void;
    onRemoveContext: (index: number) => void;
  }

  let {
    attachmentPreviews,
    attachedContext,
    onPreviewImage,
    onRemoveAttachment,
    onRemoveContext,
  }: Props = $props();
</script>

{#if attachmentPreviews.length > 0}
  <div
    class="attachment-previews"
    role="list"
    aria-label="Attachments to send"
  >
    {#each attachmentPreviews as preview (preview.id)}
      <div
        class="attachment-preview"
        class:is-image={preview.isImage}
        in:fly={{ y: 5, duration: 200 }}
        out:scale={{ duration: 150, start: 0.95 }}
        role="listitem"
      >
        {#if preview.isImage && preview.thumbnailData}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <img
            src="data:{preview.mimeType ?? 'image/png'};base64,{preview.thumbnailData}"
            alt={preview.label}
            class="attachment-thumbnail"
            onclick={() => onPreviewImage(preview)}
            style="cursor: pointer;"
          />
        {:else}
          <UIIcon
            name={preview.type === "file"
              ? "file"
              : preview.type === "selection"
                ? "code"
                : preview.type === "folder"
                  ? "folder"
                  : "image"}
            size={14}
          />
        {/if}
        <div class="attachment-info">
          <span class="attachment-label">{preview.label}</span>
          {#if preview.size || preview.dimensions}
            <span class="attachment-meta">
              {preview.dimensions ?? ""}{preview.dimensions && preview.size ? " · " : ""}{preview.size ?? ""}
            </span>
          {/if}
        </div>
        <button
          class="attachment-remove"
          onclick={() => onRemoveAttachment(preview.id)}
          title="Remove"
          aria-label="Remove {preview.label}"
          type="button"
        >
          <UIIcon name="close" size={10} />
        </button>
      </div>
    {/each}
  </div>
{/if}

{#if attachedContext.length > 0 && attachmentPreviews.length === 0}
  <div class="attached-context" role="list" aria-label="Attached context">
    {#each attachedContext as ctx, i (i)}
      <div
        class="context-chip"
        role="listitem"
        in:fly={{ y: 5, duration: 200 }}
        out:scale={{ duration: 150, start: 0.95 }}
      >
        <UIIcon name={ctx.type === "file" ? "file" : "code"} size={12} />
        <span class="context-label">{ctx.label}</span>
        <button
          class="context-remove"
          onclick={() => onRemoveContext(i)}
          title="Remove"
          aria-label="Remove {ctx.label}"
          type="button"
        >
          <UIIcon name="close" size={10} />
        </button>
      </div>
    {/each}
  </div>
{/if}
