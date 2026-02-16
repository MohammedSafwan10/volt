import type { ToolResult } from '../utils';

function requireNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function handleAttemptCompletion(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = requireNonEmptyString(args.result);
  if (!result) {
    return {
      success: false,
      error: 'Missing "result"',
      data: null,
      meta: {
        completionAccepted: false,
      },
    };
  }

  const summary =
    requireNonEmptyString(args.summary) ??
    (result.length > 200 ? `${result.slice(0, 197)}...` : result);

  return {
    success: true,
    output: summary,
    data: {
      result,
      summary,
      completedAt: Date.now(),
    },
    meta: {
      completionAccepted: true,
    },
  };
}
