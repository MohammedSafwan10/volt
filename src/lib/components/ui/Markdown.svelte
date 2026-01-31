<script lang="ts">
  /**
   * Markdown - Renders markdown content with syntax highlighting
   * Uses marked for parsing and custom styling for code blocks
   */
  import { marked } from "marked";
  import { browserStore } from "$lib/stores/browser.svelte";

  interface Props {
    content: string;
    class?: string;
  }

  let { content, class: className = "" }: Props = $props();

  // Configure marked for safe rendering
  // Note: breaks: false to avoid excessive <br> tags in lists
  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  // Custom renderer for code blocks with copy button support
  const renderer = new marked.Renderer();

  renderer.code = ({ text, lang }) => {
    const language = lang || "text";
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return `<div class="code-block" data-lang="${language}">
      <div class="code-header">
        <span class="code-lang">${language}</span>
        <button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block').querySelector('code').textContent)" title="Copy code">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>
      <pre><code class="language-${language}">${escaped}</code></pre>
    </div>`;
  };

  renderer.codespan = ({ text }) => {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<code class="inline-code">${escaped}</code>`;
  };

  // Custom link renderer - add data attribute for interception
  renderer.link = ({ href, title, text }) => {
    const titleAttr = title ? ` title="${title}"` : "";
    const isExternal =
      href.startsWith("http://") || href.startsWith("https://");
    if (isExternal) {
      return `<a href="${href}"${titleAttr} data-external-link="true">${text}</a>`;
    }
    return `<a href="${href}"${titleAttr}>${text}</a>`;
  };

  marked.use({ renderer });

  // Pre-process content to normalize whitespace before parsing
  function preProcessContent(raw: string): string {
    let out = raw;
    // Normalize line endings
    out = out.replace(/\r\n/g, "\n");
    // Remove trailing spaces on lines
    out = out.replace(/[ \t]+$/gm, "");
    // Collapse multiple blank lines into one
    out = out.replace(/\n\s*\n\s*\n+/g, "\n\n");
    // Remove blank lines after headers
    out = out.replace(/(^#{1,6}\s+.+)\n+/gm, "$1\n");
    // Remove blank lines before/after list items to keep them tight
    out = out.replace(/\n\n+([-*+]|\d+\.)\s/g, "\n$1 ");
    out = out.replace(/([-*+]|\d+\.)\s(.+)\n\n+/g, "$1 $2\n");
    // Remove leading/trailing whitespace
    out = out.trim();
    return out;
  }

  function postProcessHtml(raw: string): string {
    let out = raw;
    // Remove empty paragraphs
    out = out.replace(/<p>\s*<br\s*\/?\s*>\s*<\/p>/gi, "");
    out = out.replace(/<p>\s*(?:&nbsp;|\s)*<\/p>/gi, "");
    out = out.replace(/<p><\/p>/gi, "");
    // Collapse 2+ consecutive <br> into nothing (remove them)
    out = out.replace(/(?:<br\s*\/?\s*>\s*){2,}/gi, "");
    // Remove standalone <br> tags between block elements
    out = out.replace(
      /(<\/(?:p|div|ul|ol|h[1-6]|blockquote)>)\s*<br\s*\/?\s*>\s*(<(?:p|div|ul|ol|h[1-6]|blockquote))/gi,
      "$1$2",
    );
    // Remove <br> immediately after opening <li> or before closing </li>
    out = out.replace(/<li>\s*<br\s*\/?\s*>/gi, "<li>");
    out = out.replace(/<br\s*\/?\s*>\s*<\/li>/gi, "</li>");
    // Remove <br> between </li> and <li>
    out = out.replace(/<\/li>\s*<br\s*\/?\s*>\s*<li>/gi, "</li><li>");
    // Remove <br> after headers
    out = out.replace(/(<\/h[1-6]>)\s*<br\s*\/?\s*>/gi, "$1");
    return out;
  }

  const html = $derived.by(() =>
    postProcessHtml(marked.parse(preProcessContent(content)) as string),
  );

  // Handle link clicks - open in built-in browser
  function handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const link = target.closest(
      'a[data-external-link="true"]',
    ) as HTMLAnchorElement | null;

    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const url = link.href;

      // Open in built-in browser
      if (browserStore.isOpen) {
        browserStore.navigate(url);
      } else {
        browserStore.open(url);
      }
    }
  }
</script>

<div class="markdown {className}" onclick={handleClick} role="presentation">
  {@html html}
</div>

<style>
  .markdown {
    font-size: 13.5px;
    line-height: 1.65;
    color: var(--color-text);
    word-break: break-word;
  }

  /* Spacious spacing for all top-level elements like Windsurf */
  .markdown :global(> *) {
    margin-top: 12px !important;
    margin-bottom: 12px !important;
  }

  .markdown :global(> *:first-child) {
    margin-top: 0 !important;
  }

  .markdown :global(> *:last-child) {
    margin-bottom: 0 !important;
  }

  .markdown :global(p) {
    margin: 12px 0;
  }

  /* Professional headers like Windsurf */
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4) {
    margin: 24px 0 12px 0 !important;
    font-weight: 600;
    color: #ffffff;
    line-height: 1.3;
  }

  .markdown :global(h1) {
    font-size: 18px;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 4px;
  }
  .markdown :global(h2) {
    font-size: 16px;
  }
  .markdown :global(h3) {
    font-size: 14.5px;
  }
  .markdown :global(h4) {
    font-size: 13.5px;
    font-weight: 600;
  }

  /* Spacious lists */
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 12px 0 !important;
    padding-left: 24px;
  }

  .markdown :global(li) {
    margin: 6px 0;
    padding: 0;
  }

  .markdown :global(li p) {
    margin: 0;
    display: inline;
  }

  /* Links */
  .markdown :global(a) {
    color: var(--color-accent);
    text-decoration: none;
  }

  .markdown :global(a:hover) {
    text-decoration: underline;
  }

  /* Bold/Italic - Windsurf uses pure white for bold */
  .markdown :global(strong) {
    font-weight: 600;
    color: #ffffff;
  }

  /* Blockquotes - refined like Windsurf */
  .markdown :global(blockquote) {
    margin: 16px 0 !important;
    padding: 8px 16px;
    border-left: 3px solid var(--color-accent);
    background: rgba(var(--color-accent-rgb), 0.05);
    border-radius: 0 6px 6px 0;
    color: var(--color-text-secondary);
  }

  /* Inline code - polished like Windsurf */
  .markdown :global(.inline-code) {
    padding: 2px 5px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    font-family: var(--font-mono, "JetBrains Mono", monospace);
    font-size: 12.5px;
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  /* Code blocks - integrated and dark like Windsurf */
  .markdown :global(.code-block) {
    margin: 16px 0 !important;
    border-radius: 8px;
    background: #181818;
    border: 1px solid var(--color-border);
    overflow: hidden;
  }

  .markdown :global(.code-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: #252526;
    border-bottom: 1px solid var(--color-border);
  }

  .markdown :global(.code-lang) {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    text-transform: lowercase;
  }

  /* Markdown content within code block */
  .markdown :global(.code-block pre) {
    margin: 0;
    padding: 12px 16px;
    overflow-x: auto;
  }

  .markdown :global(.code-block code) {
    font-family: var(--font-mono, "JetBrains Mono", monospace);
    font-size: 12.5px;
    line-height: 1.6;
    color: #cccccc;
  }

  /* Tables */
  .markdown :global(table) {
    margin: 16px 0 !important;
    border-collapse: collapse;
    font-size: 13px;
    width: 100%;
  }

  .markdown :global(th),
  .markdown :global(td) {
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    text-align: left;
  }

  .markdown :global(th) {
    background: rgba(255, 255, 255, 0.03);
    font-weight: 600;
    color: #ffffff;
  }
</style>
