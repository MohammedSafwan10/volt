<script lang="ts">
  import { onDestroy } from "svelte";
  import { Streamdown } from "svelte-streamdown";
  import {
    chooseAssistantStreamingFlushMode,
    shouldRenderAssistantStreamingAsPlainText,
    STREAMING_PLAIN_TEXT_FLUSH_INTERVAL_MS,
  } from "./assistant-streaming-render-mode";
  import {
    ASSISTANT_STREAMDOWN_THEME,
    normalizeAssistantMarkdown,
    STREAMDOWN_ALLOWED_IMAGE_PREFIXES,
    STREAMDOWN_ALLOWED_LINK_PREFIXES,
    STREAMDOWN_DEFAULT_ORIGIN,
  } from "./assistant-streamdown";

  interface Props {
    content: string;
    streaming?: boolean;
  }

  let { content, streaming = false }: Props = $props();
  let renderedContent = $state("");
  let queuedContent = "";
  let flushFrame: number | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let renderPlainTextWhileStreaming = $state(false);

  function cancelPendingFlush(): void {
    if (flushFrame !== null) {
      cancelAnimationFrame(flushFrame);
      flushFrame = null;
    }
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function flushContent(nextContent: string): void {
    cancelPendingFlush();
    queuedContent = nextContent;
    renderedContent = nextContent;
  }

  function scheduleContentFlush(nextContent: string): void {
    queuedContent = nextContent;
    if (flushFrame !== null) return;
    flushFrame = requestAnimationFrame(() => {
      flushFrame = null;
      renderedContent = queuedContent;
    });
  }

  function scheduleThrottledFlush(nextContent: string): void {
    queuedContent = nextContent;
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      renderedContent = queuedContent;
    }, STREAMING_PLAIN_TEXT_FLUSH_INTERVAL_MS);
  }

  $effect(() => {
    const normalizedContent = normalizeAssistantMarkdown(content);
    const isStreaming = streaming;
    const plainTextMode = shouldRenderAssistantStreamingAsPlainText({
      contentLength: normalizedContent.length,
      streaming: isStreaming,
    });
    renderPlainTextWhileStreaming = plainTextMode;

    if (!isStreaming) {
      flushContent(normalizedContent);
      return;
    }

    if (normalizedContent === renderedContent) {
      cancelPendingFlush();
      return;
    }

    const flushMode = chooseAssistantStreamingFlushMode({
      renderedLength: renderedContent.length,
      nextLength: normalizedContent.length,
      streaming: isStreaming,
      plainTextMode,
      nextContentEndsWithNewline: normalizedContent.endsWith("\n"),
      nextContentEndsWithFence: normalizedContent.endsWith("```"),
    });

    if (flushMode === "immediate") {
      flushContent(normalizedContent);
      return;
    }

    if (flushMode === "throttled") {
      scheduleThrottledFlush(normalizedContent);
      return;
    }

    scheduleContentFlush(normalizedContent);
  });

  onDestroy(() => {
    cancelPendingFlush();
  });
</script>

<div class="assistant-streamdown">
  {#if renderPlainTextWhileStreaming}
    <div class="assistant-streaming-plain">{renderedContent}</div>
  {:else}
    <Streamdown
      class="assistant-streamdown-content"
      content={renderedContent}
      static={!streaming}
      parseIncompleteMarkdown={streaming}
      defaultOrigin={STREAMDOWN_DEFAULT_ORIGIN}
      allowedLinkPrefixes={STREAMDOWN_ALLOWED_LINK_PREFIXES}
      allowedImagePrefixes={STREAMDOWN_ALLOWED_IMAGE_PREFIXES}
      theme={ASSISTANT_STREAMDOWN_THEME}
      renderHtml={false}
      animation={{ enabled: false }}
      controls={{ code: false, mermaid: false, table: false }}
    />
  {/if}
</div>

<style>
  .assistant-streamdown {
    font-size: 13.5px;
    line-height: 1.65;
    color: var(--color-text);
    word-break: break-word;
  }

  .assistant-streamdown :global(.assistant-streamdown-content > :first-child) {
    margin-top: 0 !important;
  }

  .assistant-streamdown :global(.assistant-streamdown-content > :last-child) {
    margin-bottom: 0 !important;
  }

  .assistant-streamdown :global(a) {
    cursor: pointer;
  }

  .assistant-streamdown :global(pre) {
    overflow-x: auto;
  }

  .assistant-streamdown :global(code) {
    font-family: var(--font-mono, "JetBrains Mono", monospace);
  }

  .assistant-streamdown :global([data-streamdown-code]) {
    box-shadow: none;
  }

  .assistant-streamdown :global([data-streamdown-code] pre code) {
    color: var(--color-text);
  }

  .assistant-streamdown :global([data-streamdown-table] tbody tr:nth-child(even)) {
    background: rgba(255, 255, 255, 0.02);
  }

  .assistant-streamdown :global([data-streamdown-table] tbody tr:hover) {
    background: rgba(255, 255, 255, 0.04);
  }

  .assistant-streamdown :global(img) {
    max-width: 100%;
    height: auto;
  }

  .assistant-streaming-plain {
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
