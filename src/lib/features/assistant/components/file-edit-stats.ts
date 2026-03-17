import type { ToolCall } from "$features/assistant/stores/assistant.svelte";
import { calculateDiffStats } from "$core/ai/tools/utils";

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
