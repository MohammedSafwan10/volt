import type { ContextLane } from './context-budget';

const SNIPPET_LINE_WINDOW = 14;

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function takeLineWindow(lines: string[], startLine: number, endLine: number): string {
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, Math.max(startLine, endLine));
  return lines.slice(s - 1, e).join('\n');
}

export function scoreSnippetCandidate(lane: ContextLane, queryHitCount: number, boost = 0): number {
  const laneBase: Record<ContextLane, number> = {
    active: 110,
    selection: 120,
    touched: 100,
    query: 85,
    imports: 65,
    diagnostics: 95,
    runtime: 50,
  };
  return laneBase[lane] + Math.min(40, queryHitCount * 6) + boost;
}

export function extractQueryWindow(content: string, query: string): { startLine: number; endLine: number; content: string; hitCount: number } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const lines = splitLines(content);
  let matchLine = -1;
  let hitCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (low.includes(q)) {
      hitCount++;
      if (matchLine === -1) matchLine = i + 1;
    }
  }
  if (matchLine === -1) return null;
  const startLine = Math.max(1, matchLine - SNIPPET_LINE_WINDOW);
  const endLine = Math.min(lines.length, matchLine + SNIPPET_LINE_WINDOW);
  return {
    startLine,
    endLine,
    content: takeLineWindow(lines, startLine, endLine),
    hitCount,
  };
}

export function extractCursorWindow(content: string, cursorLine: number): { startLine: number; endLine: number; content: string } {
  const lines = splitLines(content);
  const startLine = Math.max(1, cursorLine - 40);
  const endLine = Math.min(lines.length, cursorLine + 40);
  return {
    startLine,
    endLine,
    content: takeLineWindow(lines, startLine, endLine),
  };
}

export function getLineWindow(content: string, startLine: number, endLine: number): string {
  const lines = splitLines(content);
  return takeLineWindow(lines, startLine, endLine);
}

export function getLineCount(content: string): number {
  return splitLines(content).length;
}
