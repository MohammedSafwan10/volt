import { normalizeAssistantMarkdown } from "../utils/assistant-markdown";

export const STREAMDOWN_DEFAULT_ORIGIN = "https://volt.local";

export const STREAMDOWN_ALLOWED_LINK_PREFIXES = ["*", "mailto:", "tel:"];

export const STREAMDOWN_ALLOWED_IMAGE_PREFIXES = ["*"];

export { normalizeAssistantMarkdown };

export const ASSISTANT_STREAMDOWN_THEME = {
  link: {
    base: "text-[var(--color-accent)] wrap-anywhere no-underline hover:underline",
    blocked: "text-[var(--color-text-secondary)] opacity-70",
  },
  h1: {
    base: "mt-6 mb-3 border-b border-[var(--color-border)] pb-1 text-[18px] font-semibold leading-[1.3] text-white",
  },
  h2: {
    base: "mt-6 mb-3 text-[16px] font-semibold leading-[1.3] text-white",
  },
  h3: {
    base: "mt-6 mb-3 text-[14.5px] font-semibold leading-[1.3] text-white",
  },
  h4: {
    base: "mt-6 mb-3 text-[13.5px] font-semibold leading-[1.3] text-white",
  },
  h5: {
    base: "mt-6 mb-3 text-[13px] font-semibold leading-[1.3] text-white",
  },
  h6: {
    base: "mt-6 mb-3 text-[12.5px] font-semibold leading-[1.3] text-white",
  },
  paragraph: {
    base: "my-3 text-[var(--color-text)]",
  },
  ul: {
    base: "my-3 list-disc pl-6 text-[var(--color-text)]",
  },
  ol: {
    base: "my-3 list-decimal pl-6 text-[var(--color-text)]",
  },
  li: {
    base: "my-1 py-0 marker:text-[var(--color-text-secondary)]",
  },
  strong: {
    base: "font-semibold text-white",
  },
  blockquote: {
    base: "my-4 rounded-r-md border-l-[3px] border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.05)] px-4 py-2 italic text-[var(--color-text-secondary)]",
  },
  codespan: {
    base: "rounded border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.08)] px-1.5 py-0.5 font-mono text-[12.5px] text-[#e2e8f0]",
  },
  code: {
    base: "my-4 flex w-full flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[#181818]",
    container:
      "relative overflow-visible bg-[#181818] px-0 py-0 font-mono text-[12.5px] text-[var(--color-text)]",
    header:
      "flex items-center justify-between border-b border-[var(--color-border)] bg-[#252526] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)]",
    buttons: "flex items-center gap-2",
    language: "ml-0 font-mono lowercase text-[var(--color-text-secondary)]",
    skeleton:
      "block whitespace-nowrap rounded-md bg-[rgba(255,255,255,0.08)] font-mono text-transparent",
    pre: "m-0 overflow-x-auto bg-transparent px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-[var(--color-text)]",
    line: "block",
  },
  table: {
    base: "my-4 max-w-full overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[rgba(255,255,255,0.01)]",
    table: "min-w-full border-collapse",
  },
  thead: {
    base: "bg-[#252526]",
  },
  tfoot: {
    base: "border-t border-[var(--color-border)] bg-[rgba(255,255,255,0.03)]",
  },
  tr: {
    base: "border-b border-[var(--color-border)]",
  },
  th: {
    base: "min-w-[160px] max-w-[400px] break-words border border-[var(--color-border)] px-3 py-2 text-left text-[12.5px] font-semibold text-white",
  },
  td: {
    base: "min-w-[160px] max-w-[400px] break-words border border-[var(--color-border)] px-3 py-2 text-[13px] text-[var(--color-text)]",
  },
  hr: {
    base: "my-6 border-[var(--color-border)]",
  },
  del: {
    base: "text-[var(--color-text-secondary)]",
  },
};
