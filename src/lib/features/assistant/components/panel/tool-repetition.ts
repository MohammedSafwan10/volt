function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

type SeenEntry = {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

const EXEMPT_THRESHOLDS: Record<string, number> = {
  browser_wait_for: 6,
  browser_scroll: 6,
};

export class ToolRepetitionDetector {
  private seen = new Map<string, SeenEntry>();
  constructor(private readonly defaultThreshold = 3) {}

  getSignature(toolName: string, args: Record<string, unknown>): string {
    return `${toolName}:${stableStringify(args)}`;
  }

  recordAndShouldBlock(
    toolName: string,
    args: Record<string, unknown>,
  ): { blocked: boolean; signature: string; count: number; threshold: number } {
    const signature = this.getSignature(toolName, args);
    const now = Date.now();
    const current = this.seen.get(signature);
    const nextCount = (current?.count ?? 0) + 1;
    const threshold = EXEMPT_THRESHOLDS[toolName] ?? this.defaultThreshold;

    this.seen.set(signature, {
      count: nextCount,
      firstSeenAt: current?.firstSeenAt ?? now,
      lastSeenAt: now,
    });

    return {
      blocked: nextCount > threshold,
      signature,
      count: nextCount,
      threshold,
    };
  }
}
