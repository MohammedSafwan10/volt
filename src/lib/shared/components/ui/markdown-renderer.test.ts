import { describe, expect, it } from "vitest";
import {
  normalizeImageSrc,
  normalizeLinkHref,
  normalizeMarkdownSource,
  parseMarkdownToHtml,
} from "./markdown-renderer";

describe("markdown renderer", () => {
  it("preserves heading and paragraph separation", () => {
    const html = parseMarkdownToHtml("# Heading\n\nParagraph text.\n");

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<p>Paragraph text.</p>");
  });

  it("preserves list structure without collapsing surrounding paragraphs", () => {
    const html = parseMarkdownToHtml(
      "Intro paragraph.\n\n- first item\n- second item\n\nClosing paragraph.\n",
    );

    expect(html).toContain("<p>Intro paragraph.</p>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first item</li>");
    expect(html).toContain("<li>second item</li>");
    expect(html).toContain("<p>Closing paragraph.</p>");
  });

  it("preserves fenced code blocks separated by blank lines", () => {
    const html = parseMarkdownToHtml(
      "Before\n\n```ts\nconst value = 1;\n```\n\nAfter\n",
    );

    expect(html).toContain("<p>Before</p>");
    expect(html).toContain('class="code-block" data-lang="ts"');
    expect(html).toContain("const value = 1;");
    expect(html).toContain("<p>After</p>");
  });

  it("wraps tables and preserves alignment metadata", () => {
    const html = parseMarkdownToHtml(
      "| Name | Score |\n| :--- | ---: |\n| Ada | 10 |\n",
    );

    expect(html).toContain('<div class="table-wrapper">');
    expect(html).toContain('<th style="text-align: left">Name</th>');
    expect(html).toContain('<th style="text-align: right">Score</th>');
    expect(html).toContain('<td style="text-align: left">Ada</td>');
  });

  it("normalizes line endings without trimming meaningful blank lines", () => {
    const normalized = normalizeMarkdownSource("Line 1\r\n\r\n- item\r\n");

    expect(normalized).toBe("Line 1\n\n- item\n");
  });

  it("allows only safe link protocols", () => {
    expect(normalizeLinkHref("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(normalizeLinkHref("mailto:test@example.com")).toBe(
      "mailto:test@example.com",
    );
    expect(normalizeLinkHref("tel:+123456789")).toBe("tel:+123456789");
    expect(normalizeLinkHref("javascript:alert(1)")).toBeNull();
  });

  it("allows only safe image sources", () => {
    expect(normalizeImageSrc("https://example.com/image.png")).toBe(
      "https://example.com/image.png",
    );
    expect(
      normalizeImageSrc("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"),
    ).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA");
    expect(normalizeImageSrc("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(normalizeImageSrc("javascript:alert(1)")).toBeNull();
  });
});
