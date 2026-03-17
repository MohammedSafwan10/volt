import { describe, expect, it, vi } from "vitest";
import { createStreamingTextBuffer } from "./streaming-text-buffer";

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
});
