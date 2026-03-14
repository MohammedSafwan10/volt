export interface StreamGuards {
  shouldAbortForLeak: (text: string) => boolean;
  isDegenerateRepeat: (chunk: string) => boolean;
  isDegenerateLineRepeat: (text: string) => boolean;
  resetIteration: () => void;
}

export function createStreamGuards(): StreamGuards {
  let lastChunk = '';
  let repeatedChunkCount = 0;
  let lastLine = '';
  let repeatedLineCount = 0;
  let lastParagraphSignature = '';
  let lastPairSignature = '';
  let lastParagraphCount = 0;
  let lastPairParagraphCount = 0;
  const paragraphWindow: string[] = [];
  const paragraphCounts = new Map<string, number>();
  const pairWindow: string[] = [];
  const pairCounts = new Map<string, number>();

  const normalizeForSignature = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[`*_>#-]/g, ' ')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const trackSignature = (
    signature: string,
    window: string[],
    counts: Map<string, number>,
    maxWindow: number,
  ): number => {
    if (!signature) return 0;
    window.push(signature);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);

    if (window.length > maxWindow) {
      const removed = window.shift();
      if (removed) {
        const next = (counts.get(removed) ?? 1) - 1;
        if (next <= 0) counts.delete(removed);
        else counts.set(removed, next);
      }
    }
    return counts.get(signature) ?? 0;
  };

  const shouldAbortForLeak = (text: string): boolean => {
    const lower = text.toLowerCase();
    return (
      lower.includes('<system_context') ||
      lower.includes('</system_context') ||
      lower.includes('<smart_context') ||
      lower.includes('</smart_context') ||
      lower.includes('<system-reminder') ||
      lower.includes('</system-reminder')
    );
  };

  const isDegenerateRepeat = (chunk: string): boolean => {
    const normalized = chunk.trim();
    if (!normalized) return false;

    if (normalized === lastChunk) {
      repeatedChunkCount++;
    } else {
      lastChunk = normalized;
      repeatedChunkCount = 1;
    }

    return repeatedChunkCount >= 6;
  };

  const isDegenerateLineRepeat = (text: string): boolean => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const current = lines.length > 0 ? lines[lines.length - 1] : '';
    if (!current) return false;

    if (current.length < 18) return false;

    if (current === lastLine) {
      repeatedLineCount++;
    } else {
      lastLine = current;
      repeatedLineCount = 1;
    }

    if (repeatedLineCount >= 6) return true;

    const paragraphs = text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);

    // Generic anti-loop guard: if the same paragraph keeps reappearing in a short window,
    // treat as degenerate stream regardless of specific wording.
    const lastParagraph = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : '';
    const paragraphSignature = normalizeForSignature(lastParagraph).slice(0, 220);
    const paragraphAdvanced = paragraphs.length > lastParagraphCount;
    if (
      paragraphSignature.length >= 60 &&
      (paragraphSignature !== lastParagraphSignature || paragraphAdvanced)
    ) {
      lastParagraphSignature = paragraphSignature;
      const seen = trackSignature(
        paragraphSignature,
        paragraphWindow,
        paragraphCounts,
        24,
      );
      if (seen >= 4) return true;
    }
    lastParagraphCount = paragraphs.length;

    // Catch two-paragraph loop patterns (A+B repeated) that avoid single-line repeats.
    if (paragraphs.length >= 2) {
      const pairSignature = normalizeForSignature(
        `${paragraphs[paragraphs.length - 2]}\n${paragraphs[paragraphs.length - 1]}`,
      ).slice(0, 320);
      const pairAdvanced = paragraphs.length > lastPairParagraphCount;
      if (
        pairSignature.length >= 120 &&
        (pairSignature !== lastPairSignature || pairAdvanced)
      ) {
        lastPairSignature = pairSignature;
        const seen = trackSignature(pairSignature, pairWindow, pairCounts, 16);
        if (seen >= 3) return true;
      }
      lastPairParagraphCount = paragraphs.length;
    }

    return false;
  };

  const resetIteration = (): void => {
    lastChunk = '';
    repeatedChunkCount = 0;
    lastLine = '';
    repeatedLineCount = 0;
    lastParagraphSignature = '';
    lastPairSignature = '';
    lastParagraphCount = 0;
    lastPairParagraphCount = 0;
    paragraphWindow.length = 0;
    paragraphCounts.clear();
    pairWindow.length = 0;
    pairCounts.clear();
  };

  return {
    shouldAbortForLeak,
    isDegenerateRepeat,
    isDegenerateLineRepeat,
    resetIteration,
  };
}
