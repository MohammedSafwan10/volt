export interface SnippetMatch {
  index: number;
  length: number;
  similarity: number;
}

export interface ChangedLineRange {
  firstChangedLine: number;
  lastChangedLine: number;
}

/**
 * Sometimes model output contains literal escape sequences instead of real whitespace.
 */
export function fixEscapedNewlines(text: string): string {
  if (text.includes('\\n') && !text.includes('\n')) {
    return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  const realNewlines = (text.match(/\n/g) || []).length;
  const escapedNewlines = (text.match(/\\n/g) || []).length;
  if (escapedNewlines > realNewlines * 3 && escapedNewlines > 5) {
    return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  return text;
}

/**
 * Multi-strategy snippet matching for robust replacements.
 */
export function findBestMatch(content: string, snippet: string): SnippetMatch | null {
  const exactIndex = content.indexOf(snippet);
  if (exactIndex !== -1) {
    return { index: exactIndex, length: snippet.length, similarity: 1 };
  }

  const normalizedSnippet = snippet.replace(/\r\n/g, '\n');
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const normalizedIndex = normalizedContent.indexOf(normalizedSnippet);
  if (normalizedIndex !== -1) {
    return { index: normalizedIndex, length: normalizedSnippet.length, similarity: 0.99 };
  }

  const trimmedSnippet = normalizedSnippet.split('\n').map((line) => line.trim()).join('\n');
  const trimmedContent = normalizedContent.split('\n').map((line) => line.trim()).join('\n');
  const trimmedIndex = trimmedContent.indexOf(trimmedSnippet);
  if (trimmedIndex !== -1) {
    const linesBefore = trimmedContent.slice(0, trimmedIndex).split('\n').length - 1;
    const contentLines = normalizedContent.split('\n');
    let actualIndex = 0;
    for (let i = 0; i < linesBefore; i++) {
      actualIndex += contentLines[i].length + 1;
    }
    const snippetLineCount = trimmedSnippet.split('\n').length;
    let actualLength = 0;
    for (let i = linesBefore; i < linesBefore + snippetLineCount && i < contentLines.length; i++) {
      actualLength += contentLines[i].length + 1;
    }
    actualLength = Math.max(1, actualLength - 1);
    return { index: actualIndex, length: actualLength, similarity: 0.95 };
  }

  const indentNormSnippet = normalizedSnippet
    .split('\n')
    .map((line) => line.replace(/^[\t ]+/, ''))
    .join('\n');
  const indentNormContent = normalizedContent
    .split('\n')
    .map((line) => line.replace(/^[\t ]+/, ''))
    .join('\n');
  const indentIndex = indentNormContent.indexOf(indentNormSnippet);
  if (indentIndex !== -1) {
    const linesBefore = indentNormContent.slice(0, indentIndex).split('\n').length - 1;
    const contentLines = normalizedContent.split('\n');
    let actualIndex = 0;
    for (let i = 0; i < linesBefore; i++) {
      actualIndex += contentLines[i].length + 1;
    }
    const snippetLineCount = indentNormSnippet.split('\n').length;
    let actualLength = 0;
    for (let i = linesBefore; i < linesBefore + snippetLineCount && i < contentLines.length; i++) {
      actualLength += contentLines[i].length + 1;
    }
    actualLength = Math.max(1, actualLength - 1);
    return { index: actualIndex, length: actualLength, similarity: 0.9 };
  }

  try {
    const fuzzyRegex = buildFuzzyRegex(snippet);
    const fuzzyMatch = fuzzyRegex.exec(content);
    if (fuzzyMatch) {
      return { index: fuzzyMatch.index, length: fuzzyMatch[0].length, similarity: 0.8 };
    }
  } catch {
    // Ignore invalid fuzzy regex generation and fall through.
  }

  return null;
}

function buildFuzzyRegex(snippet: string): RegExp {
  const parts = snippet.trim().split(/\s+/).filter((part) => part.length > 0);
  const pattern = parts.map((part) => escapeRegex(part)).join('\\s+');
  return new RegExp(pattern, 'm');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Kept as a non-blocking hook for future syntax checks.
 */
export function validateSyntax(_before: string, _after: string, _path: string): string | null {
  return null;
}

export function calculateChangedLines(before: string, after: string): ChangedLineRange {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let firstChangedLine = 1;
  for (let i = 0; i < Math.min(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] !== afterLines[i]) {
      firstChangedLine = i + 1;
      break;
    }
    firstChangedLine = i + 2;
  }

  let lastChangedLine = afterLines.length;
  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;

  while (beforeEnd >= firstChangedLine - 1 && afterEnd >= firstChangedLine - 1) {
    if (beforeLines[beforeEnd] !== afterLines[afterEnd]) {
      lastChangedLine = afterEnd + 1;
      break;
    }
    beforeEnd--;
    afterEnd--;
    lastChangedLine = afterEnd + 1;
  }

  if (lastChangedLine < firstChangedLine) {
    lastChangedLine = firstChangedLine;
  }

  firstChangedLine = Math.max(1, firstChangedLine);
  lastChangedLine = Math.min(afterLines.length, Math.max(lastChangedLine, firstChangedLine));

  return { firstChangedLine, lastChangedLine };
}
