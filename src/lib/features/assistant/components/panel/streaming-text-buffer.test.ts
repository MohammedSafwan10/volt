import { describe, expect, it, vi } from "vitest";
import { createStreamingTextBuffer } from "./streaming-text-buffer";
import type { ToolCall } from "$features/assistant/stores/assistant.svelte";

function readTerminalCardIdentity(toolCall: ToolCall) {
  const terminalRun = (toolCall.meta as
    | {
        terminalRun?: {
          state?: string;
          commandPreview?: string;
          excerpt?: string;
        };
      }
    | undefined)?.terminalRun;

  return {
    toolCallId: toolCall.id,
    commandPreview:
      terminalRun?.commandPreview ?? String(toolCall.arguments.command ?? ""),
  };
}

describe("streaming-text-buffer", () => {
  it("prefers complete newline-delimited chunks during timed flushes", async () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const buffer = createStreamingTextBuffer({
      intervalMs: 20,
      sliceChars: 40,
      onFlush: (text) => flushed.push(text),
    });

    buffer.append("alpha");
    await vi.advanceTimersByTimeAsync(25);
    expect(flushed).toEqual([]);

    buffer.append("\nbeta\n");
    await vi.advanceTimersByTimeAsync(25);
    expect(flushed).toEqual(["alpha\n"]);

    await vi.advanceTimersByTimeAsync(25);
    expect(flushed).toEqual(["alpha\n", "beta\n"]);
    vi.useRealTimers();
  });

  it("flushes remaining partial content on close", async () => {
    const flushed: string[] = [];
    const buffer = createStreamingTextBuffer({
      intervalMs: 20,
      sliceChars: 40,
      onFlush: (text) => flushed.push(text),
    });

    buffer.append("trailing partial");
    await buffer.close();

    expect(flushed).toEqual(["trailing partial"]);
  });

  it("keeps terminal card shell stable while excerpt updates", () => {
    const toolCall: ToolCall = {
      id: "tool-1",
      name: "run_command",
      status: "running",
      arguments: { command: "npm run dev" },
      meta: {
        terminalRun: {
          state: "running",
          commandPreview: "npm run dev",
          excerpt: "starting...\n",
        },
      },
    };

    const nextToolCall: ToolCall = {
      ...toolCall,
      meta: {
        terminalRun: {
          state: "streaming_output",
          commandPreview: "npm run dev",
          excerpt: "starting...\nready on http://localhost:5173\n",
        },
      },
    };

    expect(readTerminalCardIdentity(toolCall)).toEqual(
      readTerminalCardIdentity(nextToolCall),
    );
  });
});
