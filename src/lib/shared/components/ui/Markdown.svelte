<script lang="ts">
  import {
    renderMarkdown,
    type MarkdownProfile,
  } from "./markdown-renderer";

  interface Props {
    content: string;
    class?: string;
    profile?: MarkdownProfile;
  }

  let {
    content,
    class: className = "",
    profile = "document",
  }: Props = $props();

  const html = $derived.by(() => {
    try {
      return renderMarkdown(content, { profile });
    } catch (err) {
      console.error("[Markdown] Error rendering content:", err);
      return `<pre class="error-markdown">${content.replace(/</g, "&lt;")}</pre>`;
    }
  });

  function handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    const copyBtn = target.closest(".copy-btn") as HTMLButtonElement | null;
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();

      const codeBlock = copyBtn.closest(".code-block");
      const code = codeBlock?.querySelector("code")?.textContent;

      if (code) {
        navigator.clipboard.writeText(code).then(() => {
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

  }
</script>

<div
  class={`markdown ${profile} ${className}`.trim()}
  onclick={handleClick}
  role="presentation"
>
  {@html html}
</div>

<style>
  .markdown {
    font-size: 13.5px;
    line-height: 1.65;
    color: var(--color-text);
    word-break: break-word;
  }

  .markdown :global(> *) {
    margin-top: 10px !important;
    margin-bottom: 10px !important;
  }

  .markdown.chat :global(> *) {
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

  .markdown :global(a) {
    color: var(--color-accent);
    text-decoration: none;
  }

  .markdown :global(a:hover) {
    text-decoration: underline;
  }

  .markdown :global(strong) {
    font-weight: 600;
    color: #ffffff;
  }

  .markdown :global(blockquote) {
    margin: 16px 0 !important;
    padding: 8px 16px;
    border-left: 3px solid var(--color-accent);
    background: rgba(var(--color-accent-rgb), 0.05);
    border-radius: 0 6px 6px 0;
    color: var(--color-text-secondary);
  }

  .markdown :global(.inline-code) {
    padding: 2px 5px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    font-family: var(--font-mono, "JetBrains Mono", monospace);
    font-size: 12.5px;
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

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
    color: #4ade80 !important;
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

  .markdown :global(.table-wrapper) {
    margin: 16px 0 !important;
    overflow-x: auto;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(255, 255, 255, 0.01);
  }

  .markdown :global(table) {
    width: 100%;
    min-width: max-content;
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
    word-break: normal;
  }

  .markdown :global(th) {
    background: #252526;
    font-weight: 600;
    color: #ffffff;
    font-size: 12.5px;
    letter-spacing: 0.01em;
  }

  .markdown :global(tbody tr:nth-child(even)) {
    background: rgba(255, 255, 255, 0.02);
  }

  .markdown :global(tbody tr:hover) {
    background: rgba(255, 255, 255, 0.04);
  }

  .markdown :global(td img),
  .markdown :global(td svg) {
    display: inline-block;
    vertical-align: text-bottom;
    margin-right: 4px;
  }
</style>
