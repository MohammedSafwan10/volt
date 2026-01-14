<script lang="ts">
  /**
   * Markdown - Renders markdown content with syntax highlighting
   * Uses marked for parsing and custom styling for code blocks
   */
  import { marked } from 'marked';
  import { browserStore } from '$lib/stores/browser.svelte';

  interface Props {
    content: string;
    class?: string;
  }

  let { content, class: className = '' }: Props = $props();

  // Configure marked for safe rendering
  // Note: breaks: false to avoid excessive <br> tags in lists
  marked.setOptions({
    gfm: true,
    breaks: false
  });

  // Custom renderer for code blocks with copy button support
  const renderer = new marked.Renderer();
  
  renderer.code = ({ text, lang }) => {
    const language = lang || 'text';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<code class="inline-code">${escaped}</code>`;
  };

  // Custom link renderer - add data attribute for interception
  renderer.link = ({ href, title, text }) => {
    const titleAttr = title ? ` title="${title}"` : '';
    const isExternal = href.startsWith('http://') || href.startsWith('https://');
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
    out = out.replace(/\r\n/g, '\n');
    // Remove trailing spaces on lines
    out = out.replace(/[ \t]+$/gm, '');
    // Collapse any 2+ consecutive blank lines to single blank line
    out = out.replace(/\n\s*\n\s*\n/g, '\n\n');
    // Remove blank lines after headers
    out = out.replace(/(^#{1,6}\s+.+)\n\n+/gm, '$1\n');
    // Remove blank lines before list items
    out = out.replace(/\n\n+([-*+]|\d+\.)\s/g, '\n$1 ');
    // Remove leading/trailing whitespace
    out = out.trim();
    return out;
  }

  function postProcessHtml(raw: string): string {
    let out = raw;
    // Remove empty paragraphs
    out = out.replace(/<p>\s*<br\s*\/?\s*>\s*<\/p>/gi, '');
    out = out.replace(/<p>\s*(?:&nbsp;|\s)*<\/p>/gi, '');
    out = out.replace(/<p><\/p>/gi, '');
    // Collapse 2+ consecutive <br> into nothing (remove them)
    out = out.replace(/(?:<br\s*\/?\s*>\s*){2,}/gi, '');
    // Remove standalone <br> tags between block elements
    out = out.replace(/(<\/(?:p|div|ul|ol|h[1-6]|blockquote)>)\s*<br\s*\/?\s*>\s*(<(?:p|div|ul|ol|h[1-6]|blockquote))/gi, '$1$2');
    // Remove <br> immediately after opening <li> or before closing </li>
    out = out.replace(/<li>\s*<br\s*\/?\s*>/gi, '<li>');
    out = out.replace(/<br\s*\/?\s*>\s*<\/li>/gi, '</li>');
    // Remove <br> between </li> and <li>
    out = out.replace(/<\/li>\s*<br\s*\/?\s*>\s*<li>/gi, '</li><li>');
    // Remove <br> after headers
    out = out.replace(/(<\/h[1-6]>)\s*<br\s*\/?\s*>/gi, '$1');
    return out;
  }

  const html = $derived.by(() => postProcessHtml(marked.parse(preProcessContent(content)) as string));

  // Handle link clicks - open in built-in browser
  function handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const link = target.closest('a[data-external-link="true"]') as HTMLAnchorElement | null;
    
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
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-text);
    word-break: break-word;
  }

  .markdown :global(p) {
    margin: 0 0 4px 0;
  }

  .markdown :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown :global(p:empty) {
    display: none;
    margin: 0;
  }

  /* Compact headers - less margin */
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4) {
    margin: 8px 0 4px 0;
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.3;
  }

  .markdown :global(h1:first-child),
  .markdown :global(h2:first-child),
  .markdown :global(h3:first-child),
  .markdown :global(h4:first-child) {
    margin-top: 0;
  }

  .markdown :global(h1) { font-size: 16px; }
  .markdown :global(h2) { font-size: 14px; }
  .markdown :global(h3) { font-size: 13px; }
  .markdown :global(h4) { font-size: 13px; font-weight: 500; }

  /* Compact lists */
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 2px 0;
    padding-left: 16px;
  }

  .markdown :global(li) {
    margin: 0;
    padding: 0;
    line-height: 1.4;
  }

  .markdown :global(li p) {
    margin: 0;
    display: inline;
  }

  .markdown :global(li > ul),
  .markdown :global(li > ol) {
    margin: 0;
  }

  /* Nested list items even more compact */
  .markdown :global(li li) {
    margin: 0;
  }

  .markdown :global(a) {
    color: var(--color-accent);
    text-decoration: none;
  }

  .markdown :global(a:hover) {
    text-decoration: underline;
  }

  .markdown :global(strong) {
    font-weight: 600;
    color: var(--color-text);
  }

  .markdown :global(em) {
    font-style: italic;
  }

  /* Compact blockquotes */
  .markdown :global(blockquote) {
    margin: 6px 0;
    padding: 6px 10px;
    border-left: 2px solid var(--color-accent);
    background: var(--color-surface0);
    border-radius: 0 4px 4px 0;
  }

  .markdown :global(blockquote p) {
    margin: 0;
  }

  .markdown :global(hr) {
    margin: 10px 0;
    border: none;
    border-top: 1px solid var(--color-border);
  }

  /* Inline code - more compact */
  .markdown :global(.inline-code) {
    padding: 1px 5px;
    background: var(--color-surface0);
    border-radius: 3px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    color: var(--color-mauve);
  }

  /* Code blocks - more compact */
  .markdown :global(.code-block) {
    margin: 8px 0;
    border-radius: 6px;
    background: var(--color-mantle);
    border: 1px solid var(--color-border);
    overflow: hidden;
  }

  .markdown :global(.code-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 10px;
    background: var(--color-surface0);
    border-bottom: 1px solid var(--color-border);
  }

  .markdown :global(.code-lang) {
    font-size: 10px;
    font-weight: 500;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .markdown :global(.copy-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .markdown :global(.copy-btn:hover) {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .markdown :global(.code-block pre) {
    margin: 0;
    padding: 10px;
    overflow-x: auto;
  }

  .markdown :global(.code-block code) {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    line-height: 1.4;
    color: var(--color-text);
    white-space: pre;
  }

  /* Tables - more compact */
  .markdown :global(table) {
    width: 100%;
    margin: 8px 0;
    border-collapse: collapse;
    font-size: 12px;
  }

  .markdown :global(th),
  .markdown :global(td) {
    padding: 5px 10px;
    border: 1px solid var(--color-border);
    text-align: left;
  }

  .markdown :global(th) {
    background: var(--color-surface0);
    font-weight: 600;
  }

  .markdown :global(tr:nth-child(even)) {
    background: var(--color-surface0);
  }
</style>
