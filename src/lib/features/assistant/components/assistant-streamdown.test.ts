import { describe, expect, it } from "vitest";

import {
  STREAMDOWN_ALLOWED_IMAGE_PREFIXES,
  STREAMDOWN_ALLOWED_LINK_PREFIXES,
  STREAMDOWN_DEFAULT_ORIGIN,
  normalizeAssistantMarkdown,
  shouldOpenInBuiltInBrowser,
} from "./assistant-streamdown";

describe("assistant streamdown config", () => {
  it("keeps the default origin absolute", () => {
    expect(STREAMDOWN_DEFAULT_ORIGIN).toBe("https://volt.local");
  });

  it("allows wildcard http/https links plus mailto and tel", () => {
    expect(STREAMDOWN_ALLOWED_LINK_PREFIXES).toEqual(["*", "mailto:", "tel:"]);
  });

  it("allows only wildcard http/https image prefixes by default", () => {
    expect(STREAMDOWN_ALLOWED_IMAGE_PREFIXES).toEqual(["*"]);
  });

  it("opens only external http-style links in the built-in browser", () => {
    expect(shouldOpenInBuiltInBrowser("https://example.com")).toBe(true);
    expect(shouldOpenInBuiltInBrowser("http://example.com/docs")).toBe(true);
    expect(shouldOpenInBuiltInBrowser("/relative/path")).toBe(false);
    expect(shouldOpenInBuiltInBrowser("#section")).toBe(false);
    expect(shouldOpenInBuiltInBrowser("?tab=logs")).toBe(false);
    expect(shouldOpenInBuiltInBrowser("./local")).toBe(false);
    expect(shouldOpenInBuiltInBrowser("mailto:test@example.com")).toBe(false);
    expect(shouldOpenInBuiltInBrowser("tel:+123456789")).toBe(false);
  });

  it("strips zero-width characters from assistant markdown", () => {
    expect(normalizeAssistantMarkdown("Hello\u200b\nWorld\uFEFF")).toBe("Hello\nWorld");
  });

  it("repairs malformed two-backtick fence closers", () => {
    const input = [
      "```ts",
      'console.log("hi");',
      "``",
      "",
      "## Next section",
    ].join("\n");

    expect(normalizeAssistantMarkdown(input)).toBe([
      "```ts",
      'console.log("hi");',
      "```",
      "",
      "## Next section",
    ].join("\n"));
  });
});
