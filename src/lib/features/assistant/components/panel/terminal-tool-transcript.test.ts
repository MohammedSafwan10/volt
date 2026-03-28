import { describe, expect, it, vi } from "vitest";
import {
  buildTerminalToolExcerpt,
  readTerminalTranscriptSlice,
} from "./terminal-tool-transcript";

describe("terminal-tool-transcript", () => {
  it("reads only output after the provided start offset", () => {
    const readCleanOutputSince = vi.fn((offset: number, maxChars: number) => ({
      text: offset === 20 ? "owned output\n" : "wrong output\n",
      nextOffset: 33,
      truncatedBeforeOffset: false,
    }));
    const session = {
      readCleanOutputSince,
    };

    const result = readTerminalTranscriptSlice(session, 20, 4000);

    expect(readCleanOutputSince).toHaveBeenCalledWith(20, 4000);
    expect(result).toEqual({
      text: "owned output\n",
      nextOffset: 33,
      truncatedBeforeOffset: false,
    });
  });

  it("builds a bounded excerpt without mixing old output", () => {
    const excerpt = buildTerminalToolExcerpt("a\nb\nc\nd\ne", 2);
    expect(excerpt).toBe("d\ne");
  });

  it("preserves truncation signal for caller handling", () => {
    const session = {
      readCleanOutputSince: () => ({
        text: "partial\n",
        nextOffset: 99,
        truncatedBeforeOffset: true,
      }),
    };

    expect(readTerminalTranscriptSlice(session, 40, 4000).truncatedBeforeOffset).toBe(true);
  });
});
