<script lang="ts">
  import { onDestroy } from "svelte";
  import { Streamdown } from "svelte-streamdown";
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

  const STREAM_FLUSH_JUMP_THRESHOLD = 320;

  let { content, streaming = false }: Props = $props();
  let renderedContent = $state("");
  let queuedContent = "";
  let flushFrame: number | null = null;

  function cancelPendingFlush(): void {
    if (flushFrame !== null) {
      cancelAnimationFrame(flushFrame);
      flushFrame = null;
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

  $effect(() => {
    const normalizedContent = normalizeAssistantMarkdown(content);
    const isStreaming = streaming;

    if (!isStreaming) {
      flushContent(normalizedContent);
      return;
    }

    if (normalizedContent === renderedContent) {
      cancelPendingFlush();
      return;
    }

    const deltaLength = Math.abs(normalizedContent.length - renderedContent.length);
    const shouldFlushImmediately =
      renderedContent.length === 0 ||
      deltaLength >= STREAM_FLUSH_JUMP_THRESHOLD ||
      normalizedContent.endsWith("\n") ||
      normalizedContent.endsWith("```");

    if (shouldFlushImmediately) {
      flushContent(normalizedContent);
      return;
    }

    scheduleContentFlush(normalizedContent);
  });

  onDestroy(() => {
    cancelPendingFlush();
  });
</script>

<div class="assistant-streamdown">
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
</style>
