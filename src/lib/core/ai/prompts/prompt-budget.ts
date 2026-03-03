export function joinPromptWithBudget(parts: string[], maxChars: number): string {
  const separator = '\n\n---\n\n';
  if (parts.length === 0) return '';
  let prompt = parts.join(separator);
  if (prompt.length <= maxChars) return prompt;

  const mutableParts = [...parts];
  const removableIndexes: number[] = [];
  for (let i = mutableParts.length - 1; i >= 0; i--) {
    const header = mutableParts[i].slice(0, 48).toLowerCase();
    if (
      header.includes('# error recovery') ||
      header.includes('# large project strategy') ||
      header.includes('# context awareness')
    ) {
      removableIndexes.push(i);
    }
  }

  for (const idx of removableIndexes) {
    if (mutableParts.length <= 1) break;
    mutableParts.splice(idx, 1);
    prompt = mutableParts.join(separator);
    if (prompt.length <= maxChars) {
      return `${prompt}${separator}# PROMPT BUDGET\nContext compacted to fit system prompt budget.`;
    }
  }

  if (prompt.length <= maxChars) return prompt;
  const clipped = prompt.slice(0, Math.max(0, maxChars - 64));
  return `${clipped}\n\n# PROMPT BUDGET\nPrompt clipped to fit budget.`;
}

