const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

export function normalizeAssistantMarkdown(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n").replace(ZERO_WIDTH_RE, "");
  const lines = normalized.split("\n");
  let insideBacktickFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (/^```/.test(trimmed)) {
      insideBacktickFence = !insideBacktickFence;
      continue;
    }

    // Some models occasionally emit a malformed two-backtick closer after a fenced block.
    // Repair it so the rest of the response doesn't stay trapped inside the code block.
    if (insideBacktickFence && /^``$/.test(trimmed)) {
      lines[index] = rawLine.replace(/``/, "```");
      insideBacktickFence = false;
    }
  }

  return lines.join("\n");
}
