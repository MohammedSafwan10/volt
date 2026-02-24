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
  const SAFE_HTTP_PROTOCOLS = new Set(["http:", "https:"]);
  const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
  const SAFE_ALIGN_STYLE = /^text-align:\s*(left|right|center)\s*;?$/i;
  const SAFE_SVG_STYLE = /^display:\s*(none|block)\s*;?$/i;
  const ALLOWED_TAGS = new Set([
    "a",
    "blockquote",
    "br",
    "button",
    "code",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "li",
    "ol",
    "p",
    "path",
    "polyline",
    "pre",
    "rect",
    "span",
    "strong",
    "svg",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ]);
  const ALLOWED_ATTRS = new Map<string, Set<string>>([
    ["a", new Set(["href", "title", "target", "rel", "data-external-link"])],
    ["button", new Set(["class", "title", "type"])],
    ["code", new Set(["class"])],
    ["div", new Set(["class", "data-lang"])],
    ["img", new Set(["src", "alt", "title"])],
    ["path", new Set(["d"])],
    ["polyline", new Set(["points"])],
    ["rect", new Set(["x", "y", "width", "height", "rx", "ry"])],
    ["span", new Set(["class"])],
    [
      "svg",
      new Set([
        "class",
        "width",
        "height",
        "viewBox",
        "fill",
        "stroke",
        "stroke-width",
        "style",
      ]),
    ],
    ["td", new Set(["style"])],
    ["th", new Set(["style"])],
  ]);

  function escapeAttribute(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function normalizeLinkHref(href: string | null | undefined): string | null {
    const raw = (href || "").trim();
    if (!raw) return null;
    if (
      raw.startsWith("#") ||
      raw.startsWith("/") ||
      raw.startsWith("./") ||
      raw.startsWith("../") ||
      raw.startsWith("?")
    ) {
      return raw;
    }
    try {
      const parsed = new URL(raw);
      return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  function normalizeImageSrc(src: string | null | undefined): string | null {
    const raw = (src || "").trim();
    if (!raw) return null;
    if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) {
      return raw;
    }
    if (/^data:image\/[a-z0-9+.-]+;base64,[a-z0-9+/=]+$/i.test(raw)) {
      return raw;
    }
    try {
      const parsed = new URL(raw);
      return SAFE_HTTP_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  function sanitizeLanguage(lang: string): string {
    const normalized = lang.trim().toLowerCase();
    const safe = normalized.replace(/[^a-z0-9_+-]/g, "");
    return safe || "text";
  }

  function sanitizeHtml(raw: string): string {
    if (typeof DOMParser === "undefined") {
      return `<pre class="error-markdown">${raw
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>`;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, "text/html");
    const elements = Array.from(doc.body.querySelectorAll("*"));

    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        element.replaceWith(doc.createTextNode(element.textContent ?? ""));
        continue;
      }

      const allowedAttrs = ALLOWED_ATTRS.get(tag) ?? new Set<string>();
      for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;

        if (name.startsWith("on") || !allowedAttrs.has(name)) {
          element.removeAttribute(attr.name);
          continue;
        }

        if (name === "href") {
          const safeHref = normalizeLinkHref(value);
          if (!safeHref) {
            element.removeAttribute(attr.name);
            element.removeAttribute("data-external-link");
            element.removeAttribute("target");
            element.removeAttribute("rel");
            continue;
          }
          element.setAttribute("href", safeHref);
          const external = /^https?:\/\//i.test(safeHref);
          if (external) {
            element.setAttribute("data-external-link", "true");
            element.setAttribute("target", "_blank");
            element.setAttribute("rel", "noopener noreferrer nofollow");
          } else {
            element.removeAttribute("data-external-link");
            element.removeAttribute("target");
            element.removeAttribute("rel");
          }
          continue;
        }

        if (name === "src") {
          const safeSrc = normalizeImageSrc(value);
          if (!safeSrc) {
            element.removeAttribute(attr.name);
            continue;
          }
          element.setAttribute("src", safeSrc);
          continue;
        }

        if (name === "style") {
          const allowTableAlign =
            (tag === "th" || tag === "td") && SAFE_ALIGN_STYLE.test(value);
          const allowSvgDisplay = tag === "svg" && SAFE_SVG_STYLE.test(value);
          if (!allowTableAlign && !allowSvgDisplay) {
            element.removeAttribute(attr.name);
          }
          continue;
        }

        if (name === "data-lang") {
          element.setAttribute("data-lang", sanitizeLanguage(value));
          continue;
        }

        if (name === "data-external-link") {
          if (value !== "true") {
            element.removeAttribute(attr.name);
          }
          continue;
        }

        element.setAttribute(attr.name, value);
      }
    }

    return doc.body.innerHTML;
  }

  renderer.table = ({ header, rows }) => {
    let headerHtml = "";
    header.forEach((cell) => {
      const align = cell.align ? ` style="text-align: ${cell.align}"` : "";
      const content = marked.parseInline(cell.text) as string;
      headerHtml += `<th${align}>${content}</th>`;
    });

    let bodyHtml = "";
    rows.forEach((row) => {
      bodyHtml += "<tr>";
      row.forEach((cell) => {
        const align = cell.align ? ` style="text-align: ${cell.align}"` : "";
        const content = marked.parseInline(cell.text) as string;
        bodyHtml += `<td${align}>${content}</td>`;
      });
      bodyHtml += "</tr>";
    });

    return `
      <div class="table-wrapper">
        <table>
          <thead><tr>${headerHtml}</tr></thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>
    `;
  };

  renderer.code = ({ text, lang }) => {
    const language = sanitizeLanguage(lang || "text");
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return `<div class="code-block" data-lang="${language}">
      <div class="code-header">
        <span class="code-lang">${language}</span>
        <button class="copy-btn" title="Copy code">
          <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display: none;">
            <polyline points="20 6 9 17 4 12"></polyline>
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
    const safeHref = normalizeLinkHref(href);
    if (!safeHref) {
      return `<span>${text}</span>`;
    }
    const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
    const isExternal =
      safeHref.startsWith("http://") || safeHref.startsWith("https://");
    if (isExternal) {
      return `<a href="${safeHref}"${titleAttr} data-external-link="true">${text}</a>`;
    }
    return `<a href="${safeHref}"${titleAttr}>${text}</a>`;
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

  const html = $derived.by(() => {
    try {
      const parsed = marked.parse(preProcessContent(content)) as string;
      return sanitizeHtml(postProcessHtml(parsed));
    } catch (err) {
      console.error("[Markdown] Error rendering content:", err);
      // Fallback to raw content if parsing fails
      return `<pre class="error-markdown">${content.replace(/</g, "&lt;")}</pre>`;
    }
  });

  // Handle link clicks - open in built-in browser
  function handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // Detect copy button click
    const copyBtn = target.closest(".copy-btn") as HTMLButtonElement | null;
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();

      const codeBlock = copyBtn.closest(".code-block");
      const code = codeBlock?.querySelector("code")?.textContent;

      if (code) {
        navigator.clipboard.writeText(code).then(() => {
          // Animate transition
          copyBtn.classList.add("copied");
          const copyIcon = copyBtn.querySelector(".copy-icon") as HTMLElement;
          const checkIcon = copyBtn.querySelector(".check-icon") as HTMLElement;

          if (copyIcon && checkIcon) {
            copyIcon.style.display = "none";
            checkIcon.style.display = "block";

            setTimeout(() => {
              copyBtn.classList.remove("copied");
              copyIcon.style.display = "block";
              checkIcon.style.display = "none";
            }, 2000);
          }
        });
      }
      return;
    }

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

  .markdown :global(.copy-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .markdown :global(.copy-btn:hover) {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
    border-color: rgba(255, 255, 255, 0.1);
  }

  .markdown :global(.copy-btn.copied) {
    color: #4ade80 !important; /* Green */
    background: rgba(74, 222, 128, 0.1);
  }

  .markdown :global(.copy-icon),
  .markdown :global(.check-icon) {
    transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  }

  .markdown :global(.copy-btn.copied .check-icon) {
    transform: scale(1.1);
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

  /* Professional Tables - with horizontal scroll support */
  .markdown :global(.table-wrapper) {
    margin: 16px 0 !important;
    overflow-x: auto;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(255, 255, 255, 0.01);
  }

  .markdown :global(table) {
    width: 100%;
    min-width: max-content; /* Don't squash columns */
    border-collapse: collapse;
    font-size: 13px;
    line-height: 1.5;
  }

  .markdown :global(th),
  .markdown :global(td) {
    padding: 10px 14px;
    border: 1px solid var(--color-border);
    text-align: left;
    white-space: normal;
    word-break: normal; /* Preserve whole words in tables */
  }

  .markdown :global(th) {
    background: #252526;
    font-weight: 600;
    color: #ffffff;
    font-size: 12.5px;
    letter-spacing: 0.01em;
  }

  /* Zebra striping */
  .markdown :global(tbody tr:nth-child(even)) {
    background: rgba(255, 255, 255, 0.02);
  }

  .markdown :global(tbody tr:hover) {
    background: rgba(255, 255, 255, 0.04);
  }

  /* Support for emojis and icons in tables */
  .markdown :global(td img),
  .markdown :global(td svg) {
    display: inline-block;
    vertical-align: text-bottom;
    margin-right: 4px;
  }
</style>
