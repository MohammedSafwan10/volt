import { describe, expect, it } from "vitest";
import { getFileEditDiffStats } from "./file-edit-stats";
import type { ToolCall } from "$features/assistant/stores/assistant.svelte";

function makeToolCall(
  id: string,
  beforeContent: string,
  afterContent: string,
  added: number,
  removed: number,
): ToolCall {
  return {
    id,
    name: "apply_patch",
    arguments: { path: "src/example.ts" },
    status: "completed",
    meta: {
      fileEdit: {
        beforeContent,
        afterContent,
        added,
        removed,
      },
    },
  };
}

describe("file edit stats", () => {
  it("uses net diff across grouped edits instead of summing intermediate stats", () => {
    const first = makeToolCall(
      "a",
      "one\ntwo\nthree\n",
      "one\nTWO\nthree\n",
      1,
      1,
    );
    const second = makeToolCall(
      "b",
      "one\nTWO\nthree\n",
      "one\nTWO\nthree\nfour\n",
      1,
      0,
    );

    expect(getFileEditDiffStats([first, second])).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it("falls back to stored per-step stats when full contents are unavailable", () => {
    const calls: ToolCall[] = [
      {
        id: "a",
        name: "apply_patch",
        arguments: { path: "src/example.ts" },
        status: "completed",
        meta: { fileEdit: { added: 3, removed: 2 } },
      },
      {
        id: "b",
        name: "apply_patch",
        arguments: { path: "src/example.ts" },
        status: "completed",
        meta: { fileEdit: { added: 1, removed: 0 } },
      },
    ];

    expect(getFileEditDiffStats(calls)).toEqual({
      added: 4,
      removed: 2,
    });
  });
});
