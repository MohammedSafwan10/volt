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

type ChunkingMode = "smooth" | "catch_up";

const ENTER_QUEUE_DEPTH = 4;
const ENTER_OLDEST_AGE_MS = 60;
const EXIT_QUEUE_DEPTH = 1;
const EXIT_OLDEST_AGE_MS = 20;
const EXIT_HOLD_MS = 100;
const REENTER_HOLD_MS = 80;
const SEVERE_QUEUE_DEPTH = 32;
const SEVERE_OLDEST_AGE_MS = 150;

interface QueuedChunk {
  text: string;
  queuedAt: number;
}

function splitIntoChunks(text: string, sliceChars: number): string[] {
  if (!text) return [];
  if (text.length <= sliceChars) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + sliceChars));
    cursor += sliceChars;
  }
  return chunks;
}

export function createStreamingTextBuffer(
  options: StreamingTextBufferOptions,
): StreamingTextBuffer {
  const intervalMs = Math.max(8, options.intervalMs ?? 16);
  const sliceChars = Math.max(20, options.sliceChars ?? 60);

  let pendingText = "";
  let queue: QueuedChunk[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeFlush: Promise<void> | null = null;
  let mode: ChunkingMode = "smooth";
  let belowExitThresholdSince: number | null = null;
  let lastCatchUpExitAt: number | null = null;

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush(false);
    }, intervalMs);
  };

  const enqueue = (text: string, queuedAt = Date.now()) => {
    for (const chunk of splitIntoChunks(text, sliceChars)) {
      queue.push({ text: chunk, queuedAt });
    }
  };

  const moveReadyTextToQueue = (forcePartial: boolean) => {
    if (!pendingText) return;

    let committedUpTo = 0;
    let newlineIndex = pendingText.indexOf("\n");
    while (newlineIndex !== -1) {
      const segment = pendingText.slice(committedUpTo, newlineIndex + 1);
      if (segment) enqueue(segment);
      committedUpTo = newlineIndex + 1;
      newlineIndex = pendingText.indexOf("\n", committedUpTo);
    }

    if (committedUpTo > 0) {
      pendingText = pendingText.slice(committedUpTo);
    }

    if (
      pendingText &&
      (forcePartial || pendingText.length >= sliceChars * 2)
    ) {
      const partial = pendingText;
      pendingText = "";
      enqueue(partial);
    }
  };

  const getOldestAgeMs = (now: number): number | null => {
    const oldest = queue[0];
    return oldest ? Math.max(0, now - oldest.queuedAt) : null;
  };

  const isSevereBacklog = (queuedLines: number, oldestAgeMs: number | null): boolean =>
    queuedLines >= SEVERE_QUEUE_DEPTH ||
    (oldestAgeMs !== null && oldestAgeMs >= SEVERE_OLDEST_AGE_MS);

  const decideDrainCount = (now: number): number => {
    if (queue.length === 0) {
      if (mode === "catch_up") {
        lastCatchUpExitAt = now;
      }
      mode = "smooth";
      belowExitThresholdSince = null;
      return 0;
    }

    const oldestAgeMs = getOldestAgeMs(now);

    if (mode === "smooth") {
      const shouldEnter =
        queue.length >= ENTER_QUEUE_DEPTH ||
        (oldestAgeMs !== null && oldestAgeMs >= ENTER_OLDEST_AGE_MS);
      const reentryBlocked =
        lastCatchUpExitAt !== null &&
        now - lastCatchUpExitAt < REENTER_HOLD_MS &&
        !isSevereBacklog(queue.length, oldestAgeMs);
      if (shouldEnter && !reentryBlocked) {
        mode = "catch_up";
        belowExitThresholdSince = null;
        lastCatchUpExitAt = null;
      }
    } else {
      const shouldExit =
        queue.length <= EXIT_QUEUE_DEPTH &&
        (oldestAgeMs === null || oldestAgeMs <= EXIT_OLDEST_AGE_MS);
      if (!shouldExit) {
        belowExitThresholdSince = null;
      } else if (belowExitThresholdSince === null) {
        belowExitThresholdSince = now;
      } else if (now - belowExitThresholdSince >= EXIT_HOLD_MS) {
        mode = "smooth";
        belowExitThresholdSince = null;
        lastCatchUpExitAt = now;
      }
    }

    return mode === "catch_up" ? queue.length : 1;
  };

  const flush = async (force: boolean): Promise<void> => {
    if (activeFlush) {
      if (force) await activeFlush;
      return;
    }

    activeFlush = (async () => {
      moveReadyTextToQueue(force);

      while (queue.length > 0) {
        const drainCount = force ? queue.length : decideDrainCount(Date.now());
        if (drainCount <= 0) break;

        const batch = queue.splice(0, drainCount).map((item) => item.text);
        if (batch.length === 0) break;
        options.onFlush(batch.join(""));

        if (!force) break;
        await new Promise((resolve) => setTimeout(resolve, 8));
      }

      if (pendingText.length > 0 || queue.length > 0) {
        schedule();
      }
    })();

    await activeFlush;
    activeFlush = null;
  };

  return {
    append(chunk: string) {
      if (!chunk) return;
      pendingText += chunk;
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
