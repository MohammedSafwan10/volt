interface PatchHunkLine {
  op: 'context' | 'remove' | 'add';
  text: string;
}

export interface ParsedPatchHunk {
  lines: PatchHunkLine[];
}

export interface ParsedCodexPatch {
  path: string;
  hunks: ParsedPatchHunk[];
}

export function getCodexPatchLineStats(
  hunks: ParsedPatchHunk[],
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.op === 'add') added++;
      else if (line.op === 'remove') removed++;
    }
  }

  return { added, removed };
}

function normalizePatchText(patch: string): string {
  const normalized = patch.replace(/\r\n/g, '\n').trim();

  // Accept fenced output wrappers (```diff ... ``` / ```patch ... ```)
  const fenced = normalized.match(/```(?:diff|patch|text)?\s*\n([\s\S]*?)\n```/i);
  let text = fenced ? fenced[1].trim() : normalized;

  const rawLines = text.split('\n');

  // Tolerate leading VCS headers before Codex patch body.
  const linesWithoutVcsHeaders = rawLines.filter(
    (line) =>
      !(
        line.startsWith('diff --git ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ')
      ),
  );

  // If body already starts with explicit codex header/footer, keep as-is.
  if (
    linesWithoutVcsHeaders[0] === '*** Begin Patch' &&
    linesWithoutVcsHeaders[linesWithoutVcsHeaders.length - 1] === '*** End Patch'
  ) {
    return linesWithoutVcsHeaders.join('\n');
  }

  // Common near-miss: model emits "*** Update File" + hunks but forgets Begin/End wrapper.
  if (linesWithoutVcsHeaders[0]?.startsWith('*** Update File: ')) {
    const wrapped = ['*** Begin Patch', ...linesWithoutVcsHeaders];
    if (wrapped[wrapped.length - 1] !== '*** End Patch') {
      wrapped.push('*** End Patch');
    }
    return wrapped.join('\n');
  }

  // Another near-miss: wrapper exists but footer is missing.
  if (linesWithoutVcsHeaders[0] === '*** Begin Patch') {
    const wrapped = [...linesWithoutVcsHeaders];
    if (wrapped[wrapped.length - 1] !== '*** End Patch') {
      wrapped.push('*** End Patch');
    }
    return wrapped.join('\n');
  }

  text = linesWithoutVcsHeaders.join('\n').trim();
  return text;
}

function parseHunkLine(raw: string, lineNo: number): PatchHunkLine {
  if (raw.length === 0) {
    throw new Error(
      `Malformed patch: invalid patch line at ${lineNo}. Expected prefix " ", "-" or "+".`,
    );
  }
  const marker = raw[0];
  if (marker !== ' ' && marker !== '-' && marker !== '+') {
    throw new Error(
      `Malformed patch: invalid patch line at ${lineNo}. Expected prefix " ", "-" or "+".`,
    );
  }
  return {
    op: marker === ' ' ? 'context' : marker === '-' ? 'remove' : 'add',
    text: raw.slice(1),
  };
}

export function parseCodexPatch(patch: string): ParsedCodexPatch {
  const text = normalizePatchText(patch);
  const lines = text.split('\n');
  if (lines.length < 3 || lines[0] !== '*** Begin Patch') {
    throw new Error('Malformed patch: expected "*** Begin Patch" header.');
  }
  if (lines[lines.length - 1] !== '*** End Patch') {
    throw new Error('Malformed patch: expected "*** End Patch" footer.');
  }

  const fileLine = lines[1];
  if (!fileLine.startsWith('*** Update File: ')) {
    throw new Error('Malformed patch: only "*** Update File: <path>" is supported.');
  }
  const path = fileLine.slice('*** Update File: '.length).trim();
  if (!path) {
    throw new Error('Malformed patch: missing file path in "*** Update File".');
  }

  const hunks: ParsedPatchHunk[] = [];
  let i = 2;
  while (i < lines.length - 1) {
    const line = lines[i];
    if (!line.startsWith('@@')) {
      throw new Error(`Malformed patch: expected "@@" hunk header at line ${i + 1}.`);
    }
    i++;
    const hunkLines: PatchHunkLine[] = [];
    while (i < lines.length - 1 && !lines[i].startsWith('@@')) {
      hunkLines.push(parseHunkLine(lines[i], i + 1));
      i++;
    }
    if (hunkLines.length === 0) {
      throw new Error('Malformed patch: empty hunk is not allowed.');
    }
    hunks.push({ lines: hunkLines });
  }

  if (hunks.length === 0) {
    throw new Error('Malformed patch: no hunks found.');
  }

  return { path, hunks };
}

function findSubsequence(
  lines: string[],
  pattern: string[],
  startAt: number,
): number {
  if (pattern.length === 0) {
    return startAt;
  }
  const max = lines.length - pattern.length;
  for (let i = startAt; i <= max; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

export function applyCodexPatch(content: string, hunks: ParsedPatchHunk[]): string {
  const inputLines = content.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const oldSegment = hunk.lines
      .filter((line) => line.op !== 'add')
      .map((line) => line.text);
    const newSegment = hunk.lines
      .filter((line) => line.op !== 'remove')
      .map((line) => line.text);

    const at = findSubsequence(inputLines, oldSegment, cursor);
    if (at < 0) {
      throw new Error('Patch apply failed: context mismatch. Try a smaller patch or refresh file state if needed.');
    }

    while (cursor < at) {
      output.push(inputLines[cursor]);
      cursor++;
    }
    for (const line of newSegment) {
      output.push(line);
    }
    cursor = at + oldSegment.length;
  }

  while (cursor < inputLines.length) {
    output.push(inputLines[cursor]);
    cursor++;
  }

  return output.join('\n');
}
