<script lang="ts">
  import { onDestroy } from "svelte";
  import { Streamdown } from "svelte-streamdown";
  import { browserStore } from "$features/browser/stores/browser.svelte";
  import {
    ASSISTANT_STREAMDOWN_THEME,
    normalizeAssistantMarkdown,
    STREAMDOWN_ALLOWED_IMAGE_PREFIXES,
    STREAMDOWN_ALLOWED_LINK_PREFIXES,
    STREAMDOWN_DEFAULT_ORIGIN,
    shouldOpenInBuiltInBrowser,
  } from "./assistant-streamdown";

  interface Props {
    content: string;
    streaming?: boolean;
  }

  let { content, streaming = false }: Props = $props();
  let renderedContent = $state(content);
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const normalizedContent = normalizeAssistantMarkdown(content);
    if (!streaming) {
      renderedContent = normalizedContent;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      return;
    }

    if (renderedContent === normalizedContent || flushTimer) return;
    flushTimer = setTimeout(() => {
      renderedContent = normalizedContent;
      flushTimer = null;
    }, 120);
  });

  onDestroy(() => {
    if (flushTimer) {
      clearTimeout(flushTimer);
    }
  });

  function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const link = target.closest("a[href]") as HTMLAnchorElement | null;
    if (!link || !shouldOpenInBuiltInBrowser(link.href)) return;

    event.preventDefault();
    event.stopPropagation();

    if (browserStore.isOpen) {
      browserStore.navigate(link.href);
    } else {
      browserStore.open(link.href);
    }
  }
</script>

<div
  class="assistant-streamdown"
  onclick={handleClick}
  role="presentation"
>
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
