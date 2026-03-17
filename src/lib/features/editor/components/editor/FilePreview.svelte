<script lang="ts">
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Markdown, UIIcon } from "$shared/components/ui";
import { projectStore } from "$shared/stores/project.svelte";
import { showToast } from "$shared/stores/toast.svelte";

  interface Props {
    filepath: string;
    content: string;
  }

  let { filepath, content }: Props = $props();

  let mode = $state<"preview" | "source">("preview");
  let fileUrl = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let loadTimeout: ReturnType<typeof setTimeout> | null = null;
  let attemptedBlobFallback = $state(false);

  const ext = $derived.by(() => {
    const name = filepath.split(/[/\\]/).pop() ?? filepath;
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
  });
  const isMarkdown = $derived(ext === "md" || ext === "mdx");
  const isPdf = $derived(ext === "pdf");
  const isImage = $derived(
    ext === "png" ||
      ext === "jpg" ||
      ext === "jpeg" ||
      ext === "gif" ||
      ext === "webp" ||
      ext === "bmp" ||
      ext === "ico" ||
      ext === "avif" ||
      ext === "tif" ||
      ext === "tiff",
  );
  const isAudio = $derived(
    ext === "mp3" ||
      ext === "wav" ||
      ext === "ogg" ||
      ext === "oga" ||
      ext === "flac" ||
      ext === "aac" ||
      ext === "m4a",
  );
  const isVideo = $derived(
    ext === "mp4" ||
      ext === "mpeg" ||
      ext === "mpg" ||
      ext === "webm" ||
      ext === "mov" ||
      ext === "avi" ||
      ext === "m4v" ||
      ext === "ogv",
  );

  $effect(() => {
    if (isPdf || isImage || isAudio || isVideo) {
      loadError = null;
      loading = true;
      attemptedBlobFallback = false;
      if (loadTimeout) {
        clearTimeout(loadTimeout);
        loadTimeout = null;
      }
      try {
        fileUrl = convertFileSrc(filepath);
        // Some local media/codec combinations don't emit ready events reliably.
        // Fallback to avoid permanent loading overlays.
        loadTimeout = setTimeout(() => {
          loading = false;
          loadTimeout = null;
        }, 5000);
      } catch (err) {
        fileUrl = null;
        loadError = err instanceof Error ? err.message : String(err);
        loading = false;
        if (loadTimeout) {
          clearTimeout(loadTimeout);
          loadTimeout = null;
        }
      }
    } else {
      fileUrl = null;
      loadError = null;
      loading = false;
      if (loadTimeout) {
        clearTimeout(loadTimeout);
        loadTimeout = null;
      }
    }
  });

  // Revoke object URLs created by blob fallback to avoid memory leaks.
  $effect(() => {
    const activeUrl = fileUrl;
    return () => {
      if (activeUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(activeUrl);
      }
    };
  });

  async function openExternally(): Promise<void> {
    try {
      await invoke("open_path_scoped", {
        path: filepath,
        baseDir: projectStore.rootPath ?? null,
      });
    } catch (err) {
      showToast({
        message: `Failed to open externally: ${err instanceof Error ? err.message : String(err)}`,
        type: "error",
      });
    }
  }

  function handleMediaLoaded(): void {
    loading = false;
    if (loadTimeout) {
      clearTimeout(loadTimeout);
      loadTimeout = null;
    }
  }

  async function handleMediaError(): Promise<void> {
    // Fallback for webview/media-source incompatibilities:
    // try reading bytes directly and serving as blob URL once.
    if (
      (isImage || isPdf || isAudio || isVideo) &&
      fileUrl &&
      !fileUrl.startsWith("blob:") &&
      !attemptedBlobFallback
    ) {
      attemptedBlobFallback = true;
      try {
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(filepath);
        const blob = new Blob([bytes], { type: mediaMime || undefined });
        fileUrl = URL.createObjectURL(blob);
        loadError = null;
        loading = true;
        if (loadTimeout) clearTimeout(loadTimeout);
        loadTimeout = setTimeout(() => {
          loading = false;
          loadTimeout = null;
        }, 5000);
        return;
      } catch {
        // fall through to standard error
      }
    }

    loading = false;
    if (loadTimeout) {
      clearTimeout(loadTimeout);
      loadTimeout = null;
    }
    loadError = `Failed to render preview for ${filepath.split(/[/\\]/).pop() ?? filepath}`;
  }

  const filename = $derived(filepath.split(/[/\\]/).pop() ?? filepath);

  const mediaMime = $derived.by(() => {
    if (isImage) {
      if (ext === "png") return "image/png";
      if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
      if (ext === "gif") return "image/gif";
      if (ext === "webp") return "image/webp";
      if (ext === "bmp") return "image/bmp";
      if (ext === "ico") return "image/x-icon";
      if (ext === "avif") return "image/avif";
      if (ext === "tif" || ext === "tiff") return "image/tiff";
      return "image/*";
    }
    if (isPdf) {
      return "application/pdf";
    }
    if (isAudio) {
      if (ext === "mp3") return "audio/mpeg";
      if (ext === "wav") return "audio/wav";
      if (ext === "ogg" || ext === "oga") return "audio/ogg";
      if (ext === "flac") return "audio/flac";
      if (ext === "aac") return "audio/aac";
      if (ext === "m4a") return "audio/mp4";
      return "audio/*";
    }
    if (isVideo) {
      if (ext === "mp4" || ext === "m4v") return "video/mp4";
      if (ext === "webm") return "video/webm";
      if (ext === "ogv") return "video/ogg";
      if (ext === "mpeg" || ext === "mpg") return "video/mpeg";
      if (ext === "mov") return "video/quicktime";
      if (ext === "avi") return "video/x-msvideo";
      return "video/*";
    }
    return "";
  });
</script>

<div class="preview-root">
  <div class="preview-toolbar">
    <div class="preview-actions">
      {#if isMarkdown}
        <button class="mode-btn" class:active={mode === "preview"} type="button" onclick={() => (mode = "preview")}>Preview</button>
        <button class="mode-btn" class:active={mode === "source"} type="button" onclick={() => (mode = "source")}>Source</button>
      {/if}
      <button class="mode-btn" type="button" onclick={openExternally}>Open Externally</button>
    </div>
  </div>

  <div class="preview-body">
    {#if isMarkdown}
      {#if mode === "preview"}
        <div class="markdown-wrap">
          <Markdown content={content} profile="document" />
        </div>
      {:else}
        <pre class="source">{content}</pre>
      {/if}
    {:else if isPdf}
      {#if loadError}
        <div class="state error">Failed to load PDF: {loadError}</div>
      {:else if fileUrl}
        <div class="media-shell">
          <iframe
            class="pdf-frame"
            src={fileUrl}
            title="PDF Preview"
            onload={handleMediaLoaded}
            onerror={handleMediaError}
          ></iframe>
          {#if loading}
            <div class="media-loading">Loading PDF…</div>
          {/if}
        </div>
      {/if}
    {:else if isImage}
      {#if loadError}
        <div class="state error">Failed to load image: {loadError}</div>
      {:else if fileUrl}
        <div class="image-wrap media-shell">
          <img
            src={fileUrl}
            alt={filepath}
            onload={handleMediaLoaded}
            onerror={handleMediaError}
          />
          {#if loading}
            <div class="media-loading">Loading image…</div>
          {/if}
        </div>
      {/if}
    {:else if isAudio}
      {#if loadError}
        <div class="state error">Failed to load audio: {loadError}</div>
      {:else if fileUrl}
        <div class="media-shell audio-shell">
          <div class="media-card">
            <div class="media-card-header">
              <div class="media-meta">
                <UIIcon name="play" size={16} />
                <span class="media-name">{filename}</span>
                <span class="media-type">{ext.toUpperCase()}</span>
              </div>
            </div>
            <audio
              controls
              preload="metadata"
              src={fileUrl}
              onloadedmetadata={handleMediaLoaded}
              oncanplay={handleMediaLoaded}
              onerror={handleMediaError}
            >
              <source src={fileUrl} type={mediaMime} />
              Your system/webview cannot play this audio format.
            </audio>
          </div>
          {#if loading}
            <div class="media-loading">Loading audio…</div>
          {/if}
        </div>
      {/if}
    {:else if isVideo}
      {#if loadError}
        <div class="state error">Failed to load video: {loadError}</div>
      {:else if fileUrl}
        <div class="media-shell video-shell">
          <div class="media-card">
            <div class="media-card-header">
              <div class="media-meta">
                <UIIcon name="play" size={16} />
                <span class="media-name">{filename}</span>
                <span class="media-type">{ext.toUpperCase()}</span>
              </div>
            </div>
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              controls
              preload="metadata"
              src={fileUrl}
              onloadedmetadata={handleMediaLoaded}
              oncanplay={handleMediaLoaded}
              onerror={handleMediaError}
            >
              <source src={fileUrl} type={mediaMime} />
              Your system/webview cannot play this video format.
            </video>
          </div>
          {#if loading}
            <div class="media-loading">Loading video…</div>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="state">
        Preview is not available for this file type.
      </div>
    {/if}
  </div>
</div>

<style>
  .preview-root {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--color-bg-panel);
  }
  .preview-toolbar {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--color-border, #2a3342);
  }
  .preview-actions {
    display: inline-flex;
    gap: 8px;
  }
  .mode-btn {
    border: 1px solid var(--color-border, #2a3342);
    background: transparent;
    color: var(--color-text-muted, #9aa4b2);
    padding: 5px 9px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  .mode-btn.active {
    color: var(--color-text, #d6deeb);
    border-color: var(--color-accent, #0ea5e9);
    background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  }
  .preview-body {
    min-height: 0;
    flex: 1;
    overflow: auto;
  }
  .markdown-wrap {
    padding: 18px;
    max-width: 900px;
    margin: 0 auto;
  }
  .source {
    margin: 0;
    padding: 16px;
    color: var(--color-text, #d6deeb);
    white-space: pre-wrap;
    background: transparent;
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      Monaco,
      Consolas,
      "Liberation Mono",
      "Courier New",
      monospace;
  }
  .pdf-frame {
    width: 100%;
    height: 100%;
    border: 0;
    background: var(--color-bg);
  }
  .image-wrap {
    padding: 20px;
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }
  .image-wrap img {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.25);
  }
  .state {
    padding: 22px;
    color: var(--color-text-muted, #9aa4b2);
  }
  .state.error {
    color: var(--color-error);
  }
  .audio-shell {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 160px;
    padding: 24px 28px;
  }
  .audio-shell audio {
    width: 100%;
  }
  .video-shell {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 260px;
    padding: 20px 28px;
  }
  .video-shell video {
    width: 100%;
    max-height: calc(100vh - 220px);
    background: #000;
    border-radius: 8px;
  }
  .media-shell {
    position: relative;
    min-height: 100%;
    background:
      radial-gradient(circle at 15% 10%, color-mix(in srgb, var(--color-accent) 20%, transparent), transparent 35%),
      radial-gradient(circle at 85% 90%, color-mix(in srgb, var(--color-success) 16%, transparent), transparent 45%),
      var(--color-bg-panel);
  }
  .media-card {
    width: min(860px, 100%);
    border: 1px solid color-mix(in srgb, var(--color-border, #2a3342) 90%, transparent);
    background: color-mix(in srgb, var(--color-bg-panel) 72%, #121927);
    border-radius: 12px;
    padding: 14px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.28);
  }
  .media-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .media-meta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .media-name {
    font-size: 13px;
    color: var(--color-text, #d6deeb);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: min(60vw, 580px);
  }
  .media-type {
    font-size: 11px;
    color: var(--color-text-muted, #9aa4b2);
    border: 1px solid var(--color-border, #2a3342);
    border-radius: 999px;
    padding: 2px 8px;
  }
  .media-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    background: color-mix(in srgb, var(--color-bg-panel) 88%, transparent);
    pointer-events: none;
  }
</style>
