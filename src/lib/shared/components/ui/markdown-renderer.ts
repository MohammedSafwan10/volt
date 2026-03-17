import { Marked } from "marked";

export type MarkdownProfile = "chat" | "document";

export interface MarkdownRenderOptions {
  profile?: MarkdownProfile;
}

const MARKDOWN_CACHE_LIMIT = 200;
const markdownHtmlCache = new Map<string, string>();

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

export function normalizeLinkHref(
  href: string | null | undefined,
): string | null {
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

export function normalizeImageSrc(
  src: string | null | undefined,
): string | null {
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

export function normalizeMarkdownSource(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

const marked = new Marked({
  gfm: true,
  breaks: false,
});

marked.use({
  renderer: {
    table({ header, rows }) {
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
    },
    code({ text, lang }) {
      const language = sanitizeLanguage(lang || "text");
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      return `<div class="code-block" data-lang="${language}">
      <div class="code-header">
        <span class="code-lang">${language}</span>
        <button class="copy-btn" title="Copy code" type="button">
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
    },
    codespan({ text }) {
      return `<code class="inline-code">${escapeHtml(text)}</code>`;
    },
    link({ href, title, tokens }) {
      const safeHref = normalizeLinkHref(href);
      const text = this.parser.parseInline(tokens);
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
    },
  },
});

export function parseMarkdownToHtml(content: string): string {
  return marked.parse(normalizeMarkdownSource(content)) as string;
}

export function sanitizeMarkdownHtml(raw: string): string {
  if (typeof DOMParser === "undefined") {
    return `<pre class="error-markdown">${escapeHtml(raw)}</pre>`;
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

export function renderMarkdown(
  content: string,
  options: MarkdownRenderOptions = {},
): string {
  const profile = options.profile ?? "document";
  const normalized = normalizeMarkdownSource(content);
  const cacheKey = `${profile}\u0000${normalized}`;

  const cached = markdownHtmlCache.get(cacheKey);
  if (cached) {
    markdownHtmlCache.delete(cacheKey);
    markdownHtmlCache.set(cacheKey, cached);
    return cached;
  }

  const sanitized = sanitizeMarkdownHtml(parseMarkdownToHtml(normalized));

  if (normalized.length <= 120_000) {
    markdownHtmlCache.set(cacheKey, sanitized);
    if (markdownHtmlCache.size > MARKDOWN_CACHE_LIMIT) {
      const firstKey = markdownHtmlCache.keys().next().value;
      if (typeof firstKey === "string") {
        markdownHtmlCache.delete(firstKey);
      }
    }
  }

  return sanitized;
}
