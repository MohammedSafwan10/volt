export interface StreamingTextBuffer {
  append: (chunk: string) => void;
  flushNow: () => Promise<void>;
  close: () => Promise<void>;
}

export interface StreamingTextBufferOptions {
  intervalMs?: number;
  sliceChars?: number;
  onFlush: (text: string) => void;
}

export function createStreamingTextBuffer(
  options: StreamingTextBufferOptions,
): StreamingTextBuffer {
  const intervalMs = Math.max(10, options.intervalMs ?? 45);
  const sliceChars = Math.max(20, options.sliceChars ?? 120);

  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeFlush: Promise<void> | null = null;

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush(false);
    }, intervalMs);
  };

  const flush = async (force: boolean): Promise<void> => {
    if (activeFlush) {
      if (force) await activeFlush;
      return;
    }

    activeFlush = (async () => {
      while (buffer.length > 0) {
        const next = buffer.slice(0, sliceChars);
        buffer = buffer.slice(sliceChars);
        options.onFlush(next);

        if (!force) break;
        await new Promise((resolve) => setTimeout(resolve, 8));
      }

      if (buffer.length > 0) {
        schedule();
      }
    })();

    await activeFlush;
    activeFlush = null;
  };

  return {
    append(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      schedule();
    },
    flushNow() {
      return flush(true);
    },
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush(true);
    },
  };
}
