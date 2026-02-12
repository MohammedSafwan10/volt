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

  const shouldAbortForLeak = (text: string): boolean => {
    const lower = text.toLowerCase();
    return (
      lower.includes('<system_context') ||
      lower.includes('</system_context') ||
      lower.includes('<smart_context') ||
      lower.includes('</smart_context')
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

    const lower = current.toLowerCase();
    if (lower.startsWith("i'll also") || lower.startsWith('i will also')) {
      const count = (text.toLowerCase().match(/\bi\s*'?ll\s+also\b/g) ?? []).length;
      if (count >= 10) return true;
    }

    return false;
  };

  const resetIteration = (): void => {
    lastChunk = '';
    repeatedChunkCount = 0;
    lastLine = '';
    repeatedLineCount = 0;
  };

  return {
    shouldAbortForLeak,
    isDegenerateRepeat,
    isDegenerateLineRepeat,
    resetIteration,
  };
}
