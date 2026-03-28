import type { ToolCall } from "$features/assistant/types/tool-call";

function calculateDiffStats(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const beforeMap = new Map<string, number>();
  for (const line of beforeLines) {
    beforeMap.set(line, (beforeMap.get(line) || 0) + 1);
  }

  let added = 0;
  for (const line of afterLines) {
    const count = beforeMap.get(line) || 0;
    if (count > 0) {
      beforeMap.set(line, count - 1);
    } else {
      added++;
    }
  }

  let removed = 0;
  for (const count of beforeMap.values()) {
    removed += count;
  }

  return { added, removed };
}

export interface FileEditDiffStats {
  added: number;
  removed: number;
}

function getFileEditMeta(toolCall: ToolCall): Record<string, unknown> | undefined {
  const meta = toolCall.meta as Record<string, unknown> | undefined;
  return meta?.fileEdit as Record<string, unknown> | undefined;
}

export function getFileEditDiffStats(
  toolCalls: ToolCall[],
): FileEditDiffStats | null {
  if (toolCalls.length === 0) return null;

  const firstMeta = getFileEditMeta(toolCalls[0]);
  const lastMeta = getFileEditMeta(toolCalls[toolCalls.length - 1]);
  const beforeContent = firstMeta?.beforeContent;
  const afterContent = lastMeta?.afterContent;

  if (typeof beforeContent === "string" && typeof afterContent === "string") {
    return calculateDiffStats(beforeContent, afterContent);
  }

  let added = 0;
  let removed = 0;
  let hasStats = false;

  for (const toolCall of toolCalls) {
    const fileEdit = getFileEditMeta(toolCall);
    if (
      typeof fileEdit?.added === "number" ||
      typeof fileEdit?.removed === "number"
    ) {
      added += typeof fileEdit?.added === "number" ? fileEdit.added : 0;
      removed += typeof fileEdit?.removed === "number" ? fileEdit.removed : 0;
      hasStats = true;
    }
  }

  return hasStats ? { added, removed } : null;
}
