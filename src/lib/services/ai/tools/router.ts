/**
 * AI Tool Router
 * Routes tool calls to appropriate handlers with security validation
 * 
 * Docs consulted:
 * - Tauri v2: path canonicalization and security
 * - Rust path handling for Windows (UNC, long paths)
 * - Security best practices for approval gates
 */

import { invoke } from '@tauri-apps/api/core';
import { projectStore } from '$lib/stores/project.svelte';
import { editorStore } from '$lib/stores/editor.svelte';
import { terminalStore } from '$lib/stores/terminal.svelte';
import type { TerminalSession } from '$lib/services/terminal-client';
import { getToolByName, isToolAllowed, doesToolRequireApproval, type ToolMeta } from './definitions';
import type { AIMode } from '$lib/stores/ai.svelte';
import type { ToolCall } from '$lib/stores/assistant.svelte';

// Maximum output size to prevent memory issues (100KB)
const MAX_OUTPUT_SIZE = 100 * 1024;

// Timeout for tool operations (30 seconds)
const TOOL_TIMEOUT_MS = 30000;

/**
 * Tool execution options
 */
export interface ToolExecutionOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  truncated?: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Tool validation result
 */
export interface ToolValidation {
  valid: boolean;
  error?: string;
  requiresApproval: boolean;
}

function countLines(text: string): number {
  if (!text) return 0;
  // Count \n; handle last line without trailing newline.
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function summarizeTextDiff(oldText: string, newText: string): {
  oldBytes: number;
  newBytes: number;
  oldLines: number;
  newLines: number;
  firstChangedLine: number | null;
  lastChangedLine: number | null;
  note?: string;
} {
  const oldBytes = oldText.length;
  const newBytes = newText.length;

  // If files are very large, avoid expensive per-line comparisons.
  const MAX_ANALYZE_CHARS = 300_000;
  if (oldBytes + newBytes > MAX_ANALYZE_CHARS) {
    return {
      oldBytes,
      newBytes,
      oldLines: countLines(oldText.slice(0, 50_000)),
      newLines: countLines(newText.slice(0, 50_000)),
      firstChangedLine: null,
      lastChangedLine: null,
      note: 'File too large for detailed diff'
    };
  }

  const oldLinesArr = oldText.split(/\r?\n/);
  const newLinesArr = newText.split(/\r?\n/);
  const oldLinesCount = oldLinesArr.length;
  const newLinesCount = newLinesArr.length;

  const minLen = Math.min(oldLinesCount, newLinesCount);
  let first = -1;
  for (let i = 0; i < minLen; i++) {
    if (oldLinesArr[i] !== newLinesArr[i]) {
      first = i;
      break;
    }
  }

  // If all common lines match and lengths are equal, no changes.
  if (first === -1 && oldLinesCount === newLinesCount) {
    return { oldBytes, newBytes, oldLines: oldLinesCount, newLines: newLinesCount, firstChangedLine: null, lastChangedLine: null };
  }

  // Find last differing line by scanning from the end.
  let last = -1;
  let iOld = oldLinesCount - 1;
  let iNew = newLinesCount - 1;
  while (iOld >= 0 && iNew >= 0) {
    if (oldLinesArr[iOld] !== newLinesArr[iNew]) {
      last = Math.max(iOld, iNew);
      break;
    }
    iOld--;
    iNew--;
  }

  const firstChangedLine = first >= 0 ? first + 1 : 1;
  const lastChangedLine = last >= 0 ? last + 1 : Math.max(oldLinesCount, newLinesCount);

  return {
    oldBytes,
    newBytes,
    oldLines: oldLinesCount,
    newLines: newLinesCount,
    firstChangedLine,
    lastChangedLine
  };
}

/**
 * Escapes a string for use in a regular expression
 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeCompletionMarker(): string {
  const rand = Math.random().toString(36).slice(2);
  return `__VOLT_CMD_DONE__${Date.now()}_${rand}__EXIT__`;
}

function wrapCommandWithMarker(command: string, shell: string, marker: string): string {
  const sh = (shell || '').toLowerCase();

  // PowerShell (pwsh/powershell)
  if (sh.includes('pwsh') || sh.includes('powershell')) {
    // Note: We type directly into the shell, so we don't need to quote the user's command.
    // Ensure we always emit the marker even when the command fails.
    return `& { ${command} } ; $ec = $LASTEXITCODE; if ($null -eq $ec) { $ec = if ($?) { 0 } else { 1 } } ; Write-Output "${marker}$ec"`;
  }

  // cmd.exe
  if (sh.includes('cmd.exe') || sh === 'cmd') {
    // %errorlevel% is expanded at runtime in cmd
    return `${command} & echo ${marker}%errorlevel%`;
  }

  // bash/sh/zsh (best-effort)
  return `${command} ; ec=$? ; echo ${marker}$ec`;
}

function stripMarkerFromCapture(capture: string, marker: string): { capture: string; exitCode: number | null } {
  const idx = capture.lastIndexOf(marker);
  if (idx === -1) return { capture, exitCode: null };

  const after = capture.slice(idx + marker.length);
  const m = after.match(/(-?\d+)/);
  const exitCode = m ? Number(m[1]) : null;

  // Remove marker line (and any trailing digits) from output for cleaner parsing
  const before = capture.slice(0, idx);
  return { capture: before, exitCode };
}

function normalizeForComparePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Validate code syntax by checking for balanced brackets/braces/parens
 * Returns null if valid, or an error message if invalid
 */
function validateCodeSyntax(content: string, filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  
  // Only validate code files
  const codeExtensions = ['js', 'ts', 'jsx', 'tsx', 'svelte', 'vue', 'json', 'css', 'scss', 'less'];
  if (!codeExtensions.includes(ext)) return null;
  
  // Check balanced brackets
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const closes = new Set([')', ']', '}']);
  
  let inString = false;
  let stringChar = '';
  let inComment = false;
  let inLineComment = false;
  let inTemplateString = false;
  let prevChar = '';
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1] || '';
    
    // Handle line comments
    if (!inString && !inComment && !inTemplateString && char === '/' && nextChar === '/') {
      inLineComment = true;
      continue;
    }
    if (inLineComment && char === '\n') {
      inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    
    // Handle block comments
    if (!inString && !inTemplateString && char === '/' && nextChar === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (inComment && char === '*' && nextChar === '/') {
      inComment = false;
      i++;
      continue;
    }
    if (inComment) continue;
    
    // Handle template strings
    if (!inString && char === '`') {
      inTemplateString = !inTemplateString;
      continue;
    }
    if (inTemplateString) continue;
    
    // Handle regular strings
    if (!inString && (char === '"' || char === "'") && prevChar !== '\\') {
      inString = true;
      stringChar = char;
      prevChar = char;
      continue;
    }
    if (inString && char === stringChar && prevChar !== '\\') {
      inString = false;
      stringChar = '';
      prevChar = char;
      continue;
    }
    if (inString) {
      prevChar = char;
      continue;
    }
    
    // Check brackets
    if (opens.has(char)) {
      stack.push(char);
    } else if (closes.has(char)) {
      const expected = pairs[char];
      const actual = stack.pop();
      if (actual !== expected) {
        // Find approximate line number
        const lineNum = content.slice(0, i).split('\n').length;
        return `Unbalanced '${char}' at line ${lineNum} - expected '${expected ? expected : 'nothing'}' but found '${actual || 'nothing'}'`;
      }
    }
    
    prevChar = char;
  }
  
  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    const closeChar = unclosed === '(' ? ')' : unclosed === '[' ? ']' : '}';
    return `Missing closing '${closeChar}' - file has ${stack.length} unclosed bracket(s)`;
  }
  
  return null;
}

/**
 * Count syntax errors in content (for comparison)
 * Returns number of bracket imbalances
 */
function countSyntaxErrors(content: string, filePath: string): number {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const codeExtensions = ['js', 'ts', 'jsx', 'tsx', 'svelte', 'vue', 'json', 'css', 'scss', 'less'];
  if (!codeExtensions.includes(ext)) return 0;
  
  let errors = 0;
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const closes = new Set([')', ']', '}']);
  
  let inString = false;
  let stringChar = '';
  let inComment = false;
  let inLineComment = false;
  let inTemplateString = false;
  let prevChar = '';
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1] || '';
    
    if (!inString && !inComment && !inTemplateString && char === '/' && nextChar === '/') {
      inLineComment = true;
      continue;
    }
    if (inLineComment && char === '\n') {
      inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    
    if (!inString && !inTemplateString && char === '/' && nextChar === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (inComment && char === '*' && nextChar === '/') {
      inComment = false;
      i++;
      continue;
    }
    if (inComment) continue;
    
    if (!inString && char === '`') {
      inTemplateString = !inTemplateString;
      continue;
    }
    if (inTemplateString) continue;
    
    if (!inString && (char === '"' || char === "'") && prevChar !== '\\') {
      inString = true;
      stringChar = char;
      prevChar = char;
      continue;
    }
    if (inString && char === stringChar && prevChar !== '\\') {
      inString = false;
      stringChar = '';
      prevChar = char;
      continue;
    }
    if (inString) {
      prevChar = char;
      continue;
    }
    
    if (opens.has(char)) {
      stack.push(char);
    } else if (closes.has(char)) {
      const expected = pairs[char];
      const actual = stack.pop();
      if (actual !== expected) {
        errors++;
        // Put back if we popped wrong thing
        if (actual) stack.push(actual);
      }
    }
    
    prevChar = char;
  }
  
  // Unclosed brackets are also errors
  errors += stack.length;
  
  return errors;
}

/**
 * Smart syntax validation that allows fixes for already-broken files
 * Returns null if edit should be allowed, or error message if it should be blocked
 */
function validateEditSyntax(originalContent: string, newContent: string, filePath: string): string | null {
  // Skip validation for very large files (>100KB) to avoid delays
  if (originalContent.length > 100_000 || newContent.length > 100_000) {
    return null;
  }
  
  const originalErrors = countSyntaxErrors(originalContent, filePath);
  const newErrors = countSyntaxErrors(newContent, filePath);
  
  // If original file was already broken, allow edits that don't make it worse
  if (originalErrors > 0) {
    if (newErrors <= originalErrors) {
      // Edit improves or maintains - allow it
      return null;
    }
    // Edit makes it worse
    const syntaxError = validateCodeSyntax(newContent, filePath);
    return `Edit would add more syntax errors (${originalErrors} → ${newErrors}).\n\n${syntaxError}`;
  }
  
  // Original file was valid - don't allow breaking it
  if (newErrors > 0) {
    const syntaxError = validateCodeSyntax(newContent, filePath);
    return `SYNTAX ERROR DETECTED - Edit would break valid code!\n\n${syntaxError}`;
  }
  
  return null;
}

function isSameOrSuffixPath(openPath: string, absPath: string, relPath: string): boolean {
  const openNorm = normalizeForComparePath(openPath);
  const absNorm = normalizeForComparePath(absPath);
  const relNorm = normalizeForComparePath(relPath);

  if (openNorm === absNorm || openNorm === relNorm) return true;

  const relSuffix = '/' + relNorm.replace(/^\/+/, '');
  if (openNorm.endsWith(relSuffix)) return true;
  if (openNorm.endsWith(relNorm) && (openNorm.length === relNorm.length || openNorm[openNorm.length - relNorm.length - 1] === '/')) {
    return true;
  }

  return false;
}

/**
 * Builds a whitespace-insensitive regex for finding a snippet
 */
function buildFuzzyRegex(snippet: string): RegExp {
  const normalized = snippet.trim();
  const parts = normalized.split(/\s+/).filter(p => p.length > 0);
  const pattern = parts.map(p => escapeRegex(p)).join('\\s+');
  return new RegExp(pattern, 'm');
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses Levenshtein-like approach but optimized for code
 */
function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  
  // Normalize whitespace for comparison
  const normA = a.replace(/\s+/g, ' ').trim();
  const normB = b.replace(/\s+/g, ' ').trim();
  
  if (normA === normB) return 0.95; // Almost perfect match
  
  // Check if one contains the other
  if (normA.includes(normB) || normB.includes(normA)) {
    return 0.8;
  }
  
  // Simple character-based similarity
  const longer = normA.length > normB.length ? normA : normB;
  const shorter = normA.length > normB.length ? normB : normA;
  
  if (longer.length === 0) return 1;
  
  let matches = 0;
  const shorterChars = shorter.split('');
  let lastIndex = 0;
  
  for (const char of shorterChars) {
    const idx = longer.indexOf(char, lastIndex);
    if (idx !== -1) {
      matches++;
      lastIndex = idx + 1;
    }
  }
  
  return matches / longer.length;
}

/**
 * Find the best matching location for a snippet in file content
 * Returns { index, length, similarity } or null if no good match
 */
function findBestMatch(fileContent: string, snippet: string): { index: number; length: number; similarity: number } | null {
  const snippetLines = snippet.trim().split('\n');
  const fileLines = fileContent.split('\n');
  
  // Strategy 1: Exact match
  const exactIndex = fileContent.indexOf(snippet);
  if (exactIndex !== -1) {
    return { index: exactIndex, length: snippet.length, similarity: 1 };
  }
  
  // Strategy 2: Whitespace-normalized exact match
  const normalizedSnippet = snippet.replace(/\r\n/g, '\n').trim();
  const normalizedFile = fileContent.replace(/\r\n/g, '\n');
  const normalizedIndex = normalizedFile.indexOf(normalizedSnippet);
  if (normalizedIndex !== -1) {
    return { index: normalizedIndex, length: normalizedSnippet.length, similarity: 0.98 };
  }
  
  // Strategy 3: Fuzzy regex match
  const fuzzyRegex = buildFuzzyRegex(snippet);
  const fuzzyMatch = fuzzyRegex.exec(fileContent);
  if (fuzzyMatch) {
    return { index: fuzzyMatch.index, length: fuzzyMatch[0].length, similarity: 0.9 };
  }
  
  // Strategy 4: Line-by-line sliding window match
  // Find the best matching window of lines
  if (snippetLines.length > 0 && fileLines.length >= snippetLines.length) {
    let bestMatch: { startLine: number; similarity: number } | null = null;
    
    // Use first and last non-empty lines as anchors
    const firstSnippetLine = snippetLines.find(l => l.trim().length > 0)?.trim() || '';
    const lastSnippetLine = [...snippetLines].reverse().find(l => l.trim().length > 0)?.trim() || '';
    
    for (let i = 0; i <= fileLines.length - snippetLines.length; i++) {
      const windowLines = fileLines.slice(i, i + snippetLines.length);
      const windowText = windowLines.join('\n');
      
      // Quick check: first line should be similar
      const firstFileLine = windowLines.find(l => l.trim().length > 0)?.trim() || '';
      if (calculateSimilarity(firstFileLine, firstSnippetLine) < 0.5) continue;
      
      const similarity = calculateSimilarity(windowText, snippet);
      
      if (similarity > 0.7 && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { startLine: i, similarity };
      }
    }
    
    if (bestMatch && bestMatch.similarity > 0.7) {
      // Calculate character index from line number
      let charIndex = 0;
      for (let i = 0; i < bestMatch.startLine; i++) {
        charIndex += fileLines[i].length + 1; // +1 for newline
      }
      const matchedText = fileLines.slice(bestMatch.startLine, bestMatch.startLine + snippetLines.length).join('\n');
      return { index: charIndex, length: matchedText.length, similarity: bestMatch.similarity };
    }
  }
  
  return null;
}

/**
 * Validate a path is within the workspace root
 * Prevents directory traversal attacks
 */
function validatePathInWorkspace(path: string, workspaceRoot: string): { valid: boolean; absolutePath: string; error?: string } {
  if (!workspaceRoot) {
    return { valid: false, absolutePath: '', error: 'No workspace is open' };
  }

  // Normalize separators
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/');

  // Check for obvious traversal attempts
  if (normalizedPath.includes('..')) {
    // Allow .. only if it doesn't escape the workspace
    // This will be validated by the absolute path check below
  }

  // Build absolute path
  let absolutePath: string;
  if (normalizedPath.startsWith('/') || /^[A-Za-z]:/.test(normalizedPath)) {
    // Already absolute
    absolutePath = normalizedPath;
  } else {
    // Relative path - join with workspace root
    absolutePath = normalizedRoot.endsWith('/')
      ? normalizedRoot + normalizedPath
      : normalizedRoot + '/' + normalizedPath;
  }

  // Normalize the path (resolve . and ..)
  const parts = absolutePath.split('/').filter(p => p !== '');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.') {
      continue;
    } else if (part === '..') {
      if (resolved.length > 0) {
        resolved.pop();
      }
    } else {
      resolved.push(part);
    }
  }

  // Handle Windows drive letters
  let finalPath: string;
  if (/^[A-Za-z]:$/.test(parts[0] || '')) {
    finalPath = resolved.join('/');
  } else {
    finalPath = '/' + resolved.join('/');
  }

  // Check if the resolved path is within the workspace
  const normalizedFinal = finalPath.toLowerCase();
  const normalizedRootLower = normalizedRoot.toLowerCase();

  // IMPORTANT: Prevent prefix attacks (e.g. /workspace vs /workspace2)
  const rootWithSlash = normalizedRootLower.endsWith('/') ? normalizedRootLower : normalizedRootLower + '/';
  const isWithin = normalizedFinal === normalizedRootLower || normalizedFinal.startsWith(rootWithSlash);

  if (!isWithin) {
    return {
      valid: false,
      absolutePath: finalPath,
      error: `Path "${path}" is outside the workspace`
    };
  }

  return { valid: true, absolutePath: finalPath };
}

/**
 * Extract meta from tool arguments
 */
function extractMeta(args: Record<string, unknown>): ToolMeta | null {
  const meta = args.meta as Record<string, unknown> | undefined;
  if (!meta) return null;

  return {
    why: String(meta.why || ''),
    risk: (meta.risk as 'low' | 'medium' | 'high') || 'medium',
    undo: String(meta.undo || '')
  };
}

/**
 * Truncate output if too large
 */
function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_SIZE) {
    return { text: output, truncated: false };
  }
  return {
    text: output.slice(0, MAX_OUTPUT_SIZE) + '\n\n[Output truncated - exceeded 100KB limit]',
    truncated: true
  };
}

/**
 * Check if a line looks like a shell prompt
 */
function isPromptLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // PowerShell: "PS C:\path>" or "PS C:\path> "
  if (/^PS\s+.*>\s*$/i.test(trimmed)) return true;

  // CMD: "C:\path>" or "C:\path> "
  if (/^[A-Z]:\\.*>\s*$/i.test(trimmed)) return true;

  // Common *nix prompts: ending in $, #, %, or >
  // Avoid matching simple arrows or comparison operators by checking length or context if possible,
  // but for a prompt at the end of a block, strict ending checks are usually safe.
  if (/[>#$%\\]\s*$/.test(trimmed) && trimmed.length < 300) return true;

  return false;
}

function isContinuationPromptLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // PowerShell continuation prompt: ">>"
  if (/^>>\s*$/i.test(trimmed)) return true;

  // Python REPL prompts
  if (/^>>>\s*$/.test(trimmed)) return true;
  if (/^\.\.\.\s*$/.test(trimmed)) return true;

  return false;
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/**
 * Wait for command completion with smart detection
 * Uses multiple strategies: prompt detection, output stabilization, and timeout
 */
async function waitForCommandCompletion(
  session: TerminalSession,
  command: string,
  timeoutMs: number
): Promise<string> {
  const commandTrimmed = command.trim();
  const startTime = Date.now();

  let lastOutput = '';
  let lastOutputTime = startTime;
  let commandSeen = false;

  // Stabilization: if no new output for this many ms, consider done
  // Reduced from 1000ms to 400ms for faster responsiveness
  const STABLE_THRESHOLD_MS = 400;

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startTime;
      const currentOutput = session.getRecentOutput();

      // Check if we've seen the command echoed
      // We look for the command logic somewhat loosely to handle variations in echo behavior
      if (!commandSeen && currentOutput.includes(commandTrimmed.substring(0, Math.min(20, commandTrimmed.length)))) {
        commandSeen = true;
      }

      // Only start checking for completion after command is echoed (or if enough time passed)
      // If we never see the echo (e.g. blind typing), we rely on stabilization after a delay.
      const echoGracePeriod = 2000;
      const shouldCheckCompletion = commandSeen || (elapsed > echoGracePeriod);

      if (shouldCheckCompletion) {
        // Check if output has changed
        if (currentOutput !== lastOutput) {
          lastOutput = currentOutput;
          lastOutputTime = Date.now();
        }

        // Check for output stabilization (no new output for a while)
        const timeSinceLastOutput = Date.now() - lastOutputTime;

        // 1. Fast path: Prompt detection
        const lines = currentOutput.split(/[\r\n]+/).filter(l => l.trim());
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1];
          if (isPromptLine(lastLine) && !isContinuationPromptLine(lastLine)) {
            // Additional check: Ensure we aren't just seeing the *command itself* as the last line
            if (!lastLine.includes(commandTrimmed)) {
              resolve(currentOutput);
              return;
            }
          }
        }

        // 2. Slow path: Stabilization
        if (timeSinceLastOutput >= STABLE_THRESHOLD_MS && currentOutput.length > 0) {
          // Output hasn't changed for 1s. Assume done.
          resolve(currentOutput);
          return;
        }
      }

      // Timeout check
      if (elapsed >= timeoutMs) {
        resolve(currentOutput || '[Command timed out]');
        return;
      }

      // Continue checking
      setTimeout(check, 100);
    };

    // Start checking after initial delay
    setTimeout(check, 200);
  });
}

/**
 * Strip all ANSI escape sequences from terminal output
 */
function stripAnsi(str: string): string {
  return str
    // CSI sequences: ESC [ ... letter (includes cursor control like [?25h, [?25l)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // OSC sequences: ESC ] ... BEL or ESC ] ... ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Single-character escape sequences
    .replace(/\x1b[NOPXZc^_]/g, '')
    // DCS sequences: ESC P ... ST
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    // APC sequences: ESC _ ... ST
    .replace(/\x1b_[^\x1b]*\x1b\\/g, '')
    // PM sequences: ESC ^ ... ST
    .replace(/\x1b\^[^\x1b]*\x1b\\/g, '')
    // SOS sequences: ESC X ... ST
    .replace(/\x1bX[^\x1b]*\x1b\\/g, '')
    // Remaining escape sequences
    .replace(/\x1b./g, '');
}

/**
 * Extract command output from terminal capture
 * Removes the command echo and trailing prompt
 */
function extractCommandOutput(capture: string, command: string): string {
  // Strip all ANSI escape codes first
  let cleaned = stripAnsi(capture)
    .replace(/\r\n/g, '\n')  // Normalize CRLF to LF
    .replace(/\r/g, '\n');   // Convert remaining CR to LF

  const lines = cleaned.split('\n');
  const commandTrimmed = command.trim();

  // Find where the command was echoed (first occurrence only)
  let startIdx = 0;
  let foundCommand = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match the command, but not if it's part of a prompt line
    if (line.includes(commandTrimmed) && !foundCommand) {
      startIdx = i + 1;
      foundCommand = true;
      break;
    }
  }

  // Find where the next prompt starts (end of output)
  let endIdx = lines.length;
  const promptPatterns = [
    /^PS\s+[A-Z]:\\[^>]*>\s*$/i,  // PowerShell: PS C:\path>
    /^[A-Z]:\\[^>]*>\s*$/i,        // CMD: C:\path>
    /^.*[$#]\s*$/,                  // Bash/Zsh: ends with $ or #
    /^>>\s*$/i,                      // PowerShell continuation prompt
    /^>>>\s*$/,                      // Python prompt
    /^\.\.\.\s*$/,                 // Python continuation prompt
  ];

  // Scan from the end to find where output ends and prompt begins
  for (let i = lines.length - 1; i >= startIdx; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let isPrompt = false;
    for (const pattern of promptPatterns) {
      if (pattern.test(trimmed)) {
        isPrompt = true;
        break;
      }
    }

    if (!isPrompt) {
      endIdx = i + 1;
      break;
    }
  }

  // Extract the output lines, filtering out empty lines at start/end
  const outputLines = lines.slice(startIdx, endIdx)
    .filter((line, idx, arr) => {
      // Keep non-empty lines, or empty lines that are between content
      if (line.trim()) return true;
      // Skip leading/trailing empty lines
      const hasContentBefore = arr.slice(0, idx).some(l => l.trim());
      const hasContentAfter = arr.slice(idx + 1).some(l => l.trim());
      return hasContentBefore && hasContentAfter;
    });

  const cleanOutput = outputLines.join('\n').trim();

  return cleanOutput || '[No output]';
}

/**
 * Validate a tool call before execution
 */
export function validateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  mode: AIMode
): ToolValidation {
  // Check if tool exists
  const tool = getToolByName(toolName);
  if (!tool) {
    return { valid: false, error: `Unknown tool: ${toolName}`, requiresApproval: false };
  }

  // Check if tool is allowed in current mode
  if (!isToolAllowed(toolName, mode)) {
    return {
      valid: false,
      error: `Tool "${toolName}" is not allowed in ${mode} mode. Switch to ${tool.allowedModes.join(' or ')} mode.`,
      requiresApproval: false
    };
  }

  // NOTE: `meta` is optional. It is useful for UX/auditing, but missing meta must not
  // block tool execution (models often omit it).

  // Lightweight argument validation to prevent tool-loop degeneration.
  // (We don't do full JSON-schema validation here; this is a pragmatic guardrail.)
  const requireString = (key: string): string | null => {
    const v = args[key];
    return typeof v === 'string' && v.trim().length > 0
      ? null
      : `Missing or invalid "${key}" (expected non-empty string)`;
  };

  const requireArray = (key: string): string | null => {
    const v = args[key];
    return Array.isArray(v) ? null : `Missing or invalid "${key}" (expected array)`;
  };

  // Tool-specific required args.
  switch (toolName) {
    case 'read_file': {
      const err = requireString('path');
      if (err) return { valid: false, error: err, requiresApproval: false };
      break;
    }
    case 'get_file_info': {
      const err = requireString('path');
      if (err) return { valid: false, error: err, requiresApproval: false };
      break;
    }
    case 'workspace_search': {
      const err = requireString('query');
      if (err) return { valid: false, error: err, requiresApproval: false };
      break;
    }
    case 'write_file': {
      const err1 = requireString('path');
      if (err1) return { valid: false, error: err1, requiresApproval: false };
      const err2 = requireString('content');
      if (err2) return { valid: false, error: err2, requiresApproval: false };
      break;
    }
    case 'create_file': {
      // create_file only needs path - it creates an empty file
      const err = requireString('path');
      if (err) return { valid: false, error: err, requiresApproval: false };
      break;
    }
    case 'apply_edit': {
      const err1 = requireString('path');
      if (err1) return { valid: false, error: err1, requiresApproval: false };
      const err2 = requireString('original_snippet');
      if (err2) return { valid: false, error: err2, requiresApproval: false };
      // Allow empty new_snippet for deletions - just check it exists
      if (typeof args.new_snippet !== 'string') {
        return { valid: false, error: 'Missing "new_snippet" (use empty string "" to delete code)', requiresApproval: false };
      }
      break;
    }
    case 'multi_replace_file_content': {
      const err1 = requireString('path');
      if (err1) return { valid: false, error: err1, requiresApproval: false };
      // Canonical schema uses `replacement_chunks`.
      // Accept legacy `replacements` as a fallback to avoid breaking older prompts.
      const err2 =
        Array.isArray(args.replacement_chunks)
          ? null
          : Array.isArray(args.replacements)
            ? null
            : 'Missing or invalid "replacement_chunks" (expected array)';
      if (err2) return { valid: false, error: err2, requiresApproval: false };
      break;
    }
    case 'delete_path':
    case 'delete_paths':
    case 'create_dir': {
      if (toolName === 'delete_paths') {
        if (!Array.isArray(args.paths) || (args.paths as unknown[]).length === 0) {
          return { valid: false, error: 'Missing or invalid "paths" (expected non-empty array)', requiresApproval: false };
        }
      } else {
        const err = requireString('path');
        if (err) return { valid: false, error: err, requiresApproval: false };
      }
      break;
    }
    case 'rename_path': {
      const err1 = requireString('oldPath');
      if (err1) return { valid: false, error: err1, requiresApproval: false };
      const err2 = requireString('newPath');
      if (err2) return { valid: false, error: err2, requiresApproval: false };
      break;
    }
    case 'run_command': {
      const err = requireString('command');
      if (err) return { valid: false, error: err, requiresApproval: false };
      break;
    }
    case 'terminal_write': {
      const err2 = requireString('command');
      if (err2) return { valid: false, error: err2, requiresApproval: false };

      // Back-compat: allow either terminalId or sessionId.
      // If neither is provided, we'll try to default to the active terminal at runtime.
      const terminalId = args.terminalId;
      const sessionId = args.sessionId;
      if (terminalId != null && (typeof terminalId !== 'string' || !terminalId.trim())) {
        return { valid: false, error: 'Missing or invalid "terminalId" (expected non-empty string)', requiresApproval: false };
      }
      if (sessionId != null && (typeof sessionId !== 'string' || !sessionId.trim())) {
        return { valid: false, error: 'Missing or invalid "sessionId" (expected non-empty string)', requiresApproval: false };
      }
      break;
    }
    default:
      break;
  }

  // Validate path arguments if present
  const workspaceRoot = projectStore.rootPath;
  if (args.path && typeof args.path === 'string') {
    const pathValidation = validatePathInWorkspace(args.path, workspaceRoot || '');
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error, requiresApproval: false };
    }
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p !== 'string') {
        return { valid: false, error: 'Invalid path in "paths" (expected string)', requiresApproval: false };
      }
      const pathValidation = validatePathInWorkspace(p, workspaceRoot || '');
      if (!pathValidation.valid) {
        return { valid: false, error: pathValidation.error, requiresApproval: false };
      }
    }
  }
  if (args.oldPath && typeof args.oldPath === 'string') {
    const pathValidation = validatePathInWorkspace(args.oldPath, workspaceRoot || '');
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error, requiresApproval: false };
    }
  }
  if (args.newPath && typeof args.newPath === 'string') {
    const pathValidation = validatePathInWorkspace(args.newPath, workspaceRoot || '');
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error, requiresApproval: false };
    }
  }

  return {
    valid: true,
    requiresApproval: doesToolRequireApproval(toolName)
  };
}

/**
 * Execute a tool call
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolExecutionOptions = {}
): Promise<ToolResult> {
  const { signal } = options;
  const workspaceRoot = projectStore.rootPath;

  // Allow per-call override for tools that support timeouts (e.g. run_command)
  const requestedTimeout = typeof args.timeout === 'number' ? args.timeout : undefined;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(0, Math.min(5 * 60_000, Math.floor(requestedTimeout!)))
    : TOOL_TIMEOUT_MS;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  // Create a timeout promise (ensure it cannot become an unhandled rejection)
  const timeoutPromise = new Promise<ToolResult>((_, reject) => {
    if (timeoutMs <= 0) return;
    timeoutId = setTimeout(() => reject(new Error('Tool execution timed out')), timeoutMs);
  }).catch(() => {
    // Swallow if it loses the race; the race winner handles the outcome.
    return { success: false, error: 'Tool execution timed out' };
  });

  // Create abort handler (ensure it cannot become an unhandled rejection)
  const abortPromise = new Promise<ToolResult>((_, reject) => {
    if (!signal) return;
    abortListener = () => reject(new Error('Tool execution cancelled'));
    signal.addEventListener('abort', abortListener, { once: true });
  }).catch(() => {
    // Swallow if it loses the race; the race winner handles the outcome.
    return { success: false, error: 'Tool execution cancelled' };
  });

  try {
    const executionPromise = executeToolInternal(
      toolName,
      args,
      workspaceRoot || ''
    );

    // Race between execution, timeout, and abort
    const result = await Promise.race([
      executionPromise,
      timeoutPromise,
      ...(signal ? [abortPromise] : [])
    ]);

    return result;
  } catch (err) {
    // Use the helper to extract meaningful error messages
    const message = extractErrorMessage(err);
    return { success: false, error: message };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (signal && abortListener) {
      try {
        signal.removeEventListener('abort', abortListener);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Extract meaningful error message from Tauri invoke errors
 */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (err && typeof err === 'object') {
    const errObj = err as Record<string, unknown>;
    // Tauri FileError format: { type: "NotFound", path: "..." }
    if (errObj.type && typeof errObj.type === 'string') {
      const errorType = errObj.type;
      const path = errObj.path || '';
      const message = errObj.message || '';
      if (message) return String(message);
      return `${errorType}${path ? `: ${path}` : ''}`;
    }
    if (errObj.message && typeof errObj.message === 'string') {
      return errObj.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return 'Unknown error';
}

/**
 * Internal tool execution logic
 */
async function executeToolInternal(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string
): Promise<ToolResult> {
  // Helper to resolve relative paths to absolute
  const resolvePath = (relativePath: string): string => {
    if (!relativePath || relativePath === '.') {
      return workspaceRoot;
    }
    const sep = workspaceRoot.includes('\\') ? '\\' : '/';
    const normalized = relativePath.replace(/[/\\]/g, sep);
    return workspaceRoot + sep + normalized;
  };

  switch (toolName) {
    // ============================================
    // WORKSPACE READ TOOLS
    // ============================================
    case 'list_dir': {
      const path = resolvePath(String(args.path || '.'));
      // Rust list_dir returns Vec<FileEntry> directly (array), not { entries: [...] }
      const entries = await invoke<Array<{ name: string; isDir: boolean; isFile: boolean; size: number }>>('list_dir', { path });

      if (!Array.isArray(entries) || entries.length === 0) {
        return { success: true, output: 'Empty directory' };
      }

      const output = entries
        .map(e => `${e.isDir ? '📁' : '📄'} ${e.name}${e.isDir ? '/' : ''} (${e.size} bytes)`)
        .join('\n');
      const { text, truncated } = truncateOutput(output);
      return { success: true, output: text, truncated };
    }

    case 'read_file': {
      const relativePath = String(args.path);
      const path = resolvePath(relativePath);
      
      let content: string;
      try {
        content = await invoke<string>('read_file', { path });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to read file "${relativePath}": ${message}` };
      }
      
      const totalLines = content.split('\n').length;

      // Handle line range if specified
      let output = content;
      let startLine = 1;
      let endLine = totalLines;
      
      if (args.startLine || args.endLine) {
        const lines = content.split('\n');
        startLine = Math.max(1, Number(args.startLine) || 1);
        endLine = args.endLine ? Math.min(Number(args.endLine), totalLines) : totalLines;
        const start = startLine - 1;
        output = lines.slice(start, endLine).join('\n');
      }

      const { text, truncated } = truncateOutput(output);
      return { 
        success: true, 
        output: text, 
        truncated,
        meta: {
          startLine,
          endLine,
          totalLines
        }
      };
    }

    case 'get_file_info': {
      const path = resolvePath(String(args.path));
      const info = await invoke<{
        name: string;
        path: string;
        isDir: boolean;
        isFile: boolean;
        isReadonly: boolean;
        size: number;
        modified: number | null;
      }>('get_file_info', { path });

      const output = [
        `Name: ${info.name}`,
        `Type: ${info.isDir ? 'Directory' : 'File'}`,
        `Size: ${info.size} bytes`,
        `Read-only: ${info.isReadonly}`,
        `Modified: ${info.modified ? new Date(info.modified).toISOString() : 'Unknown'}`
      ].join('\n');

      return { success: true, output };
    }

    // ============================================
    // WORKSPACE SEARCH TOOLS
    // ============================================
    case 'workspace_search': {
      const result = await invoke<{
        files: Array<{
          path: string;
          matches: Array<{ line: number; lineContent: string }>;
        }>;
        totalMatches: number;
        truncated: boolean;
      }>('workspace_search', {
        options: {
          query: String(args.query),
          rootPath: workspaceRoot,
          useRegex: Boolean(args.useRegex),
          caseSensitive: Boolean(args.caseSensitive),
          includePatterns: (args.includePatterns as string[]) || [],
          excludePatterns: (args.excludePatterns as string[]) || [],
          maxResults: Number(args.maxResults) || 100,
          requestId: Date.now()
        }
      });

      if (result.totalMatches === 0) {
        return { success: true, output: 'No matches found' };
      }

      const lines: string[] = [`Found ${result.totalMatches} matches in ${result.files.length} files:`];
      for (const file of result.files.slice(0, 20)) {
        lines.push(`\n📄 ${file.path}`);
        for (const match of file.matches.slice(0, 5)) {
          lines.push(`  L${match.line}: ${match.lineContent.trim().slice(0, 100)}`);
        }
        if (file.matches.length > 5) {
          lines.push(`  ... and ${file.matches.length - 5} more matches`);
        }
      }
      if (result.files.length > 20) {
        lines.push(`\n... and ${result.files.length - 20} more files`);
      }
      if (result.truncated) {
        lines.push('\n[Results truncated]');
      }

      const { text, truncated } = truncateOutput(lines.join('\n'));
      return { success: true, output: text, truncated };
    }

    // ============================================
    // EDITOR CONTEXT TOOLS
    // ============================================
    case 'get_active_file': {
      const activeFile = editorStore.activeFile;
      if (!activeFile) {
        return { success: true, output: 'No file is currently open in the editor' };
      }
      const { text, truncated } = truncateOutput(
        `Path: ${activeFile.path}\n\nContent:\n${activeFile.content}`
      );
      return { success: true, output: text, truncated };
    }

    case 'get_selection': {
      // Dynamic import to avoid circular dependency
      const { getEditorSelection } = await import('$lib/services/monaco-models');
      const selection = getEditorSelection();

      if (!selection || !selection.text) {
        return { success: true, output: 'No text is currently selected' };
      }

      const { text, truncated } = truncateOutput(
        `Selection from ${selection.path || 'unknown file'}:\n${selection.text}`
      );
      return { success: true, output: text, truncated };
    }

    case 'get_open_files': {
      const openFiles = editorStore.openFiles;
      if (openFiles.length === 0) {
        return { success: true, output: 'No files are currently open' };
      }

      const output = openFiles
        .map(f => `${editorStore.isDirty(f.path) ? '●' : '○'} ${f.path}`)
        .join('\n');

      return { success: true, output: `Open files:\n${output}` };
    }

    // ============================================
    // FILE WRITE TOOLS
    // ============================================
    case 'write_file': {
      const relativePath = String(args.path);
      const path = resolvePath(relativePath);
      const content = String(args.content);

      // Kiro-style: Write directly to disk, then open in editor
      // Simple, reliable, no virtual files or streaming complexity

      // 1. Check if file exists and get before content for diff
      let before = '';
      let isNewFile = false;
      try {
        before = await invoke<string>('read_file', { path });
      } catch {
        before = '';
        isNewFile = true;
      }

      // 2. Write content directly to disk
      try {
        await invoke('write_file', { path, content });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to write file "${relativePath}": ${message}` };
      }

      // 3. Refresh file tree if new file
      if (isNewFile) {
        try {
          const { projectStore } = await import('$lib/stores/project.svelte');
          await projectStore.refreshTree();
        } catch {
          // Ignore tree refresh errors
        }
      }

      // 4. Open file in editor (reads from disk - shows actual content)
      try {
        const { editorStore } = await import('$lib/stores/editor.svelte');
        
        // If file is already open, reload it to show new content
        const existingFile = editorStore.openFiles.find(f => 
          f.path === path || f.path === relativePath || 
          f.path.endsWith('/' + relativePath) || f.path.endsWith('\\' + relativePath)
        );
        
        if (existingFile) {
          await editorStore.reloadFile(existingFile.path);
        } else {
          await editorStore.openFile(path);
        }
      } catch {
        // File was written successfully, just couldn't open in editor
      }

      // 5. Return success with diff summary
      const summary = summarizeTextDiff(before, content);
      const range = (summary.firstChangedLine && summary.lastChangedLine)
        ? `Changed lines (approx): ${summary.firstChangedLine}–${summary.lastChangedLine}`
        : 'Changed lines (approx): unknown';
      const note = summary.note ? `\nNote: ${summary.note}` : '';

      return {
        success: true,
        output:
          `Wrote file: ${relativePath}\n` +
          `Before: ${summary.oldBytes} bytes, ${summary.oldLines} lines\n` +
          `After:  ${summary.newBytes} bytes, ${summary.newLines} lines\n` +
          `${range}${note}`,
        meta: {
          fileEdit: {
            relativePath,
            absolutePath: path,
            beforeContent: (before.length <= 300_000 && content.length <= 300_000) ? before : null,
            firstChangedLine: summary.firstChangedLine,
            lastChangedLine: summary.lastChangedLine
          }
        }
      };
    }

    case 'apply_edit': {
      const relativePath = String(args.path);
      const path = resolvePath(relativePath);
      const originalSnippet = String(args.original_snippet);
      const newSnippet = String(args.new_snippet);

      // Kiro-style: Read file, apply edit, write to disk, reload in editor

      // 1. Read current file content
      let fileContent = '';
      try {
        fileContent = await invoke<string>('read_file', { path });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to read file "${relativePath}": ${message}` };
      }

      // 2. PRE-VALIDATE: Smart syntax check - allows fixes for already-broken files
      const testContent = fileContent.replace(originalSnippet, newSnippet);
      const syntaxError = validateEditSyntax(fileContent, testContent, relativePath);
      if (syntaxError) {
        return {
          success: false,
          error: `${syntaxError}\n\nThe edit was NOT applied. Please fix the new_snippet to ensure balanced brackets/braces and try again.`
        };
      }

      // 3. Find the snippet using smart fuzzy matching
      const match = findBestMatch(fileContent, originalSnippet);

      if (!match) {
        // Provide a helpful error with context
        const snippetStart = originalSnippet.slice(0, 80).replace(/\n/g, '\\n') + (originalSnippet.length > 80 ? '...' : '');
        
        // Try to find similar lines to help debug
        const snippetFirstLine = originalSnippet.trim().split('\n')[0]?.trim() || '';
        const fileLines = fileContent.split('\n');
        let similarLines: string[] = [];
        
        for (let i = 0; i < fileLines.length && similarLines.length < 3; i++) {
          const line = fileLines[i].trim();
          if (line.length > 10 && calculateSimilarity(line, snippetFirstLine) > 0.5) {
            similarLines.push(`L${i + 1}: ${line.slice(0, 60)}`);
          }
        }
        
        const similarHint = similarLines.length > 0 
          ? `\n\nSimilar lines found:\n${similarLines.join('\n')}`
          : '';
        
        return {
          success: false,
          error: `EDIT FAILED: Could not find original_snippet in file.\n\nExpected: "${snippetStart}"${similarHint}\n\nACTION REQUIRED: Use read_file to get the exact current content of ${relativePath}, then retry apply_edit with the correct snippet. Do NOT give up.`
        };
      }

      const startIndex = match.index;
      const matchLength = match.length;
      const matchNote = match.similarity < 1 
        ? ` (fuzzy match, ${Math.round(match.similarity * 100)}% confidence)` 
        : '';

      // 4. Apply the edit
      const newContent = fileContent.slice(0, startIndex) + newSnippet + fileContent.slice(startIndex + matchLength);

      // 5. Final syntax validation
      const finalSyntaxError = validateEditSyntax(fileContent, newContent, relativePath);
      if (finalSyntaxError) {
        return {
          success: false,
          error: `${finalSyntaxError}\n\nThe edit was NOT applied. Please fix the new_snippet and try again.`
        };
      }

      // 6. Write to disk
      try {
        await invoke('write_file', { path, content: newContent });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to write file "${relativePath}": ${message}` };
      }

      // 7. Reload file in editor if open
      try {
        const { editorStore } = await import('$lib/stores/editor.svelte');
        const openFile = editorStore.openFiles.find(f => 
          f.path === path || f.path === relativePath || 
          f.path.endsWith('/' + relativePath) || f.path.endsWith('\\' + relativePath)
        );
        if (openFile) {
          await editorStore.reloadFile(openFile.path);
        } else {
          // Open the file so user can see the edit
          await editorStore.openFile(path);
        }
      } catch {
        // File was written successfully, just couldn't update editor
      }

      // 8. Return success with context preview
      const contextStart = Math.max(0, startIndex - 200);
      const contextEnd = Math.min(newContent.length, startIndex + newSnippet.length + 200);
      const preview = newContent.slice(contextStart, contextEnd);

      const summary = summarizeTextDiff(fileContent, newContent);

      return {
        success: true,
        output: `Successfully applied edit to ${relativePath}${matchNote}.\n\nContext around edit:\n...\n${preview}\n...`,
        meta: {
          fileEdit: {
            relativePath,
            absolutePath: path,
            beforeContent: (fileContent.length <= 300_000 && newContent.length <= 300_000) ? fileContent : null,
            firstChangedLine: summary.firstChangedLine,
            lastChangedLine: summary.lastChangedLine
          }
        }
      };
    }

    case 'multi_replace_file_content': {
      const relativePath = String(args.path);
      const path = resolvePath(relativePath);
      const chunks = (Array.isArray(args.replacement_chunks)
        ? args.replacement_chunks
        : args.replacements) as Array<{
        startLine: number;
        endLine: number;
        targetContent: string;
        replacementContent: string;
      }>;

      // Kiro-style: Read file, apply all edits, write to disk, reload in editor

      // 1. Read current file content
      let fileContent = '';
      try {
        fileContent = await invoke<string>('read_file', { path });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to read file "${relativePath}": ${message}` };
      }

      // 2. Apply chunks bottom-to-top to maintain index stability
      const sortedChunks = [...chunks].sort((a, b) => b.startLine - a.startLine);
      let currentContent = fileContent;

      for (const chunk of sortedChunks) {
        const match = findBestMatch(currentContent, chunk.targetContent);

        if (match && match.similarity >= 0.7) {
          const startIndex = match.index;
          const matchLength = match.length;
          currentContent = currentContent.slice(0, startIndex) + chunk.replacementContent + currentContent.slice(startIndex + matchLength);
        } else {
          const snippetStart = chunk.targetContent.slice(0, 60).replace(/\n/g, '\\n') + (chunk.targetContent.length > 60 ? '...' : '');
          return {
            success: false,
            error: `EDIT FAILED: Could not find target content for chunk at line ${chunk.startLine}.\n\nExpected: "${snippetStart}"\n\nACTION REQUIRED: Use read_file to get the exact current content, then retry with correct snippets. Do NOT give up.`
          };
        }
      }

      // 3. Write to disk
      try {
        await invoke('write_file', { path, content: currentContent });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to write file "${relativePath}": ${message}` };
      }

      // 4. Reload file in editor if open
      try {
        const { editorStore } = await import('$lib/stores/editor.svelte');
        const openFile = editorStore.openFiles.find(f => 
          f.path === path || f.path === relativePath || 
          f.path.endsWith('/' + relativePath) || f.path.endsWith('\\' + relativePath)
        );
        if (openFile) {
          await editorStore.reloadFile(openFile.path);
        } else {
          await editorStore.openFile(path);
        }
      } catch {
        // File was written successfully, just couldn't update editor
      }

      // 5. Return success
      const summary = summarizeTextDiff(fileContent, currentContent);

      return {
        success: true,
        output: `Successfully applied ${chunks.length} edits to ${relativePath}.`,
        meta: {
          fileEdit: {
            relativePath,
            absolutePath: path,
            beforeContent: (fileContent.length <= 300_000 && currentContent.length <= 300_000) ? fileContent : null,
            firstChangedLine: summary.firstChangedLine,
            lastChangedLine: summary.lastChangedLine
          }
        }
      };
    }

    case 'create_file': {
      const relativePath = String(args.path);
      const path = resolvePath(relativePath);
      
      try {
        await invoke('create_file', { path });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to create file "${relativePath}": ${message}` };
      }

      // Refresh file tree to show new file
      const { projectStore } = await import('$lib/stores/project.svelte');
      await projectStore.refreshTree();

      return { success: true, output: `Created empty file: ${args.path}\nTip: Use write_file to add content.` };
    }

    case 'create_dir': {
      const relativePath = String(args.path);
      const path = resolvePath(relativePath);
      
      try {
        await invoke('create_dir', { path });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to create directory "${relativePath}": ${message}` };
      }

      // Refresh file tree to show new directory
      const { projectStore } = await import('$lib/stores/project.svelte');
      await projectStore.refreshTree();

      return { success: true, output: `Created directory: ${args.path}` };
    }

    case 'delete_path': {
      const relativePath = String(args.path);
      const path = resolvePath(relativePath);
      
      try {
        await invoke('delete_path', { path });
      } catch (err) {
        const message = extractErrorMessage(err);
        return { success: false, error: `Failed to delete "${relativePath}": ${message}` };
      }

      // Close the file tab if it's open
      const { editorStore } = await import('$lib/stores/editor.svelte');
      const relPath = String(args.path);
      const openFiles = editorStore.openFiles.filter(f => isSameOrSuffixPath(f.path, path, relPath));
      for (const f of openFiles) {
        editorStore.closeFile(f.path, true);
      }

      // Refresh file tree to remove deleted item
      const { projectStore } = await import('$lib/stores/project.svelte');
      projectStore.removeNode(path);

      return { success: true, output: `Deleted: ${args.path}` };
    }

    case 'delete_paths': {
      const relPaths = Array.isArray(args.paths) ? (args.paths as unknown[]) : [];
      const relativePaths = relPaths.filter((p): p is string => typeof p === 'string');
      const absolutePaths = relativePaths.map((p) => resolvePath(p));

      const { editorStore } = await import('$lib/stores/editor.svelte');
      const { projectStore } = await import('$lib/stores/project.svelte');

      // Close any open tabs first to avoid stale models
      const openFiles = editorStore.openFiles;
      for (let i = 0; i < absolutePaths.length; i++) {
        const abs = absolutePaths[i];
        const rel = relativePaths[i] ?? '';
        const matches = openFiles.filter(f => isSameOrSuffixPath(f.path, abs, rel));
        for (const f of matches) {
          editorStore.closeFile(f.path, true);
        }
      }

      const results = await Promise.allSettled(
        absolutePaths.map((p) => invoke('delete_path', { path: p }))
      );

      const deleted: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      results.forEach((r, i) => {
        const rel = relativePaths[i] ?? absolutePaths[i] ?? 'unknown';
        if (r.status === 'fulfilled') {
          deleted.push(rel);
          try {
            projectStore.removeNode(absolutePaths[i]);
          } catch {
            // ignore
          }
        } else {
          failed.push({ path: rel, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
        }
      });

      // One refresh for consistency
      await projectStore.refreshTree();

      const lines: string[] = [];
      lines.push(`Deleted ${deleted.length}/${relativePaths.length} paths.`);
      if (failed.length > 0) {
        lines.push('Failures:');
        for (const f of failed.slice(0, 20)) {
          lines.push(`- ${f.path}: ${f.error}`);
        }
        if (failed.length > 20) {
          lines.push(`- (and ${failed.length - 20} more)`);
        }
      }

      return {
        success: failed.length === 0,
        output: lines.join('\n')
      };
    }

    case 'rename_path': {
      const oldPath = resolvePath(String(args.oldPath));
      const newPath = resolvePath(String(args.newPath));
      await invoke('rename_path', { oldPath, newPath });

      // Update the file tab if it's open
      const { editorStore } = await import('$lib/stores/editor.svelte');
      const normalizedOldPath = oldPath.replace(/\\/g, '/');
      const openFile = editorStore.openFiles.find(f =>
        f.path.replace(/\\/g, '/').toLowerCase() === normalizedOldPath.toLowerCase()
      );
      if (openFile) {
        // Close old tab and reopen with new path
        editorStore.closeFile(openFile.path, true);
        await editorStore.openFile(newPath);
      }

      // Update file tree
      const { projectStore } = await import('$lib/stores/project.svelte');
      const newName = newPath.split(/[/\\]/).pop() || '';
      projectStore.updateNodePath(oldPath, newPath, newName);

      return { success: true, output: `Renamed ${args.oldPath} to ${args.newPath}` };
    }

    // ============================================
    // TERMINAL TOOLS
    // ============================================
    case 'run_command': {
      // Validate command is not empty or undefined
      if (!args.command || typeof args.command !== 'string' || !args.command.trim()) {
        return { success: false, error: 'Command is required and cannot be empty' };
      }
      const command = String(args.command).trim();
      const timeout = Number(args.timeout) || 60000; // Increased default to 60s
      const cwd = args.cwd ? resolvePath(String(args.cwd)) : workspaceRoot;
      const waitForCompletion = args.wait !== false; // Default: wait for completion

      // Open the terminal panel so user can see the command running
      const { uiStore } = await import('$lib/stores/ui.svelte');
      uiStore.openBottomPanelTab('terminal');

      // Get or create AI terminal
      const session = await terminalStore.getOrCreateAiTerminal(cwd);
      if (!session) {
        return { success: false, error: 'Failed to create terminal' };
      }

      // Activate the session
      terminalStore.setActive(session.id);

      // Wait for terminal to be ready
      await session.waitForReady(3000);
      
      // Small delay for UI to render
      await new Promise(resolve => setTimeout(resolve, 200));

      // Clear output history before sending command
      session.clearOutputHistory();

      // Send the command with newline
      try {
        await invoke('terminal_write', {
          terminalId: session.info.terminalId,
          data: command + '\r\n'
        });
      } catch (err) {
        return {
          success: false,
          error: `Failed to send command: ${err instanceof Error ? err.message : 'Unknown error'}`
        };
      }

      // If not waiting for completion, return immediately with terminal ID
      if (!waitForCompletion) {
        return {
          success: true,
          output: `Command started in background: $ ${command}\nTerminal ID: ${session.info.terminalId}\nUse read_terminal to check output.`,
          meta: { terminalId: session.info.terminalId, backgrounded: true }
        };
      }

      // Smart wait for command completion
      const startTime = Date.now();
      let lastOutput = '';
      let lastChangeTime = startTime;
      let stableCount = 0;
      let output = '';
      
      // Detect if this is a known long-running command
      const longRunningPatterns = [
        /^npm\s+(install|i|ci|run|test)/i,
        /^yarn\s+(install|add|run|test)/i,
        /^pnpm\s+(install|add|run|test)/i,
        /^cargo\s+(build|test|run|check)/i,
        /^pip\s+install/i,
        /^npx\s+/i,
        /^eslint/i,
        /^tsc/i,
        /^webpack/i,
        /^vite/i,
        /^jest/i,
        /^vitest/i,
        /^pytest/i,
      ];
      const isLongRunning = longRunningPatterns.some(p => p.test(command));
      
      // Adjust stability threshold based on command type
      const stabilityThreshold = isLongRunning ? 2000 : 800; // 2s for long commands, 800ms for quick ones
      const minWaitTime = isLongRunning ? 1000 : 300; // Minimum wait before checking for completion
      
      // Wait minimum time for command to start producing output
      await new Promise(resolve => setTimeout(resolve, minWaitTime));
      
      while (Date.now() - startTime < timeout) {
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const currentOutput = session.getRecentOutput();
        const cleanedCurrent = stripAnsi(currentOutput);
        
        if (currentOutput !== lastOutput) {
          lastOutput = currentOutput;
          lastChangeTime = Date.now();
          stableCount = 0;
        } else {
          stableCount++;
        }
        
        // Check for completion indicators
        const timeSinceChange = Date.now() - lastChangeTime;
        const lines = cleanedCurrent.split('\n').filter(l => l.trim());
        const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
        
        // Prompt detection patterns (command finished)
        const promptPatterns = [
          /[>$#%]\s*$/,                    // Unix prompts: $, #, %, >
          /^PS\s+[A-Z]:\\.*>\s*$/i,        // PowerShell: PS C:\path>
          /^[A-Z]:\\.*>\s*$/i,             // CMD: C:\path>
          /^\([^)]+\)\s*[>$#%]\s*$/,       // Conda/venv: (env) $
        ];
        
        const isPrompt = promptPatterns.some(p => p.test(lastLine));
        
        // Error/success indicators
        const hasExitIndicator = /^(error|Error|ERROR|npm ERR!|failed|Failed|FAILED|success|Success|SUCCESS|Done|done|DONE|✓|✔|✗|✘)/m.test(cleanedCurrent);
        
        // Completion conditions:
        // 1. Output stable for threshold AND we see a prompt
        // 2. Output stable for longer threshold (command might have no final prompt)
        // 3. We see clear success/error indicators and output is stable
        if (isPrompt && timeSinceChange > stabilityThreshold) {
          output = currentOutput;
          break;
        }
        
        if (timeSinceChange > stabilityThreshold * 2 && currentOutput.length > 0) {
          // Output stable for 2x threshold, assume done
          output = currentOutput;
          break;
        }
        
        if (hasExitIndicator && timeSinceChange > stabilityThreshold && stableCount >= 3) {
          output = currentOutput;
          break;
        }
      }
      
      // Get final output if loop ended by timeout
      if (!output) {
        output = session.getRecentOutput();
      }

      // Clean up the output - remove ANSI codes
      const cleanedOutput = stripAnsi(output).trim();
      
      // Extract just the command output (remove command echo and trailing prompt)
      const lines = cleanedOutput.split('\n');
      let startIdx = 0;
      
      // Find where the command was echoed
      const cmdPrefix = command.slice(0, Math.min(30, command.length));
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(cmdPrefix)) {
          startIdx = i + 1;
          break;
        }
      }
      
      // Remove trailing prompt lines
      let endIdx = lines.length;
      for (let i = lines.length - 1; i >= startIdx; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        // Check if it's a prompt
        if (/[>$#%]\s*$/.test(line) || /^PS\s+.*>\s*$/i.test(line) || /^[A-Z]:\\.*>\s*$/i.test(line)) {
          endIdx = i;
        } else {
          break;
        }
      }
      
      const resultLines = lines.slice(startIdx, endIdx);
      let finalOutput = resultLines.join('\n').trim();
      
      // Check if command is still running (timeout reached without completion)
      const timedOut = Date.now() - startTime >= timeout;
      if (timedOut && finalOutput) {
        finalOutput += '\n\n[Command may still be running - use read_terminal to check for more output]';
      } else if (!finalOutput) {
        finalOutput = '[Command completed with no output]';
      }

      const { text, truncated } = truncateOutput(finalOutput);

      return {
        success: true,
        output: `$ ${command}\n\n${text}`,
        truncated,
        meta: { 
          terminalId: session.info.terminalId,
          timedOut,
          executionTime: Date.now() - startTime
        }
      };
    }

    case 'terminal_create': {
      const cwd = args.cwd ? resolvePath(String(args.cwd)) : workspaceRoot;

      // Open the terminal panel
      const { uiStore } = await import('$lib/stores/ui.svelte');
      uiStore.openBottomPanelTab('terminal');

      const session = await terminalStore.createTerminal(cwd);
      if (!session) {
        return { success: false, error: 'Failed to create terminal' };
      }
      return { success: true, output: `Created terminal: ${session.info.terminalId}\nShell: ${session.info.shell}\nCWD: ${session.info.cwd}` };
    }

    case 'terminal_write': {
      const command = String(args.command);

      // terminalId is canonical, sessionId is a legacy alias.
      const providedTerminalId =
        (typeof args.terminalId === 'string' && args.terminalId.trim())
          ? String(args.terminalId)
          : (typeof (args as Record<string, unknown>).sessionId === 'string' && String((args as Record<string, unknown>).sessionId).trim())
            ? String((args as Record<string, unknown>).sessionId)
            : null;

      // Open the terminal panel
      const { uiStore } = await import('$lib/stores/ui.svelte');
      uiStore.openBottomPanelTab('terminal');

      // If no terminal specified, default to the active session.
      const session =
        providedTerminalId
          ? terminalStore.sessions.find(s => s.info.terminalId === providedTerminalId) ?? null
          : terminalStore.activeSession;

      if (!session) {
        return {
          success: false,
          error: 'No active terminal session. Run terminal_create (or run_command) first, or provide terminalId.'
        };
      }

      const terminalId = session.info.terminalId;

      // Capture output delta so the AI can see results.
      const beforeOutput = session.getRecentOutput();
      const beforeLen = beforeOutput.length;

      // Ensure command ends with newline to execute (use CRLF for cross-platform safety)
      const commandWithNewline = /\r?\n$/.test(command) ? command : command + '\r\n';

      await invoke('terminal_write', { terminalId, data: commandWithNewline });

      const waitMs = typeof args.waitMs === 'number' ? Math.max(0, Number(args.waitMs)) : 800;
      const newOutput = await session.waitForOutput((delta) => {
        const cleaned = stripAnsi(delta);
        return Boolean(cleaned && cleaned.trim().length > 0);
      }, Math.min(Math.max(waitMs, 0), 10_000));

      const delta = session.getRecentOutput().slice(beforeLen);
      const cleaned = stripAnsi(delta || newOutput || '').trim();
      const { text, truncated } = truncateOutput(cleaned || '[No output yet]');

      return {
        success: true,
        output: `$ ${command}\n\n${text}`,
        truncated
      };
    }

    case 'terminal_kill': {
      const terminalId = (typeof args.terminalId === 'string' && args.terminalId.trim())
        ? String(args.terminalId)
        : (typeof (args as Record<string, unknown>).sessionId === 'string' && String((args as Record<string, unknown>).sessionId).trim())
          ? String((args as Record<string, unknown>).sessionId)
          : '';
      await invoke('terminal_kill', { terminalId });
      return { success: true, output: `Killed terminal: ${terminalId}` };
    }

    case 'terminal_get_output': {
      const terminalId = (typeof args.terminalId === 'string' && args.terminalId.trim())
        ? String(args.terminalId)
        : (typeof (args as Record<string, unknown>).sessionId === 'string' && String((args as Record<string, unknown>).sessionId).trim())
          ? String((args as Record<string, unknown>).sessionId)
          : '';
      const lines = Number(args.lines) || 100;

      const session = terminalStore.sessions.find(s => s.info.terminalId === terminalId);
      if (!session) {
        return { success: false, error: `Terminal session ${terminalId} not found` };
      }

      const output = session.getRecentOutput(lines * 120); // Roughly 120 chars per line
      const cleaned = stripAnsi(output);

      const { text, truncated } = truncateOutput(cleaned);
      return {
        success: true,
        output: text,
        truncated
      };
    }

    // ============================================
    // WORKSPACE READ/SEARCH TOOLS (Phase 2)
    // ============================================
    case 'read_files': {
      const paths = (args.paths as string[]) || [];
      const results: Array<{ path: string; content?: string; error?: string; lines?: number }> = [];
      let totalLinesRead = 0;

      for (const path of paths) {
        try {
          const content = await invoke('read_file', { path: resolvePath(path) }) as string;
          const lineCount = content.split('\n').length;
          totalLinesRead += lineCount;
          results.push({ path, content, lines: lineCount });
        } catch (err) {
          results.push({ path, error: err instanceof Error ? err.message : String(err) });
        }
      }

      return {
        success: true,
        output: JSON.stringify(results, null, 2),
        meta: {
          fileCount: paths.length,
          totalLines: totalLinesRead,
          files: results.map(r => ({ path: r.path, lines: r.lines || 0 }))
        }
      };
    }

    case 'find_files': {
      const pattern = String(args.pattern).toLowerCase();
      const maxResults = Number(args.maxResults) || 50;

      const found: string[] = [];
      const stack: string[] = [workspaceRoot];

      while (stack.length > 0 && found.length < maxResults) {
        const currentPath = stack.pop()!;
        try {
          const entries = await invoke('list_dir', { path: currentPath }) as Array<{ name: string; isDir: boolean }>;
          for (const entry of entries) {
            const fullPath = `${currentPath}/${entry.name}`;
            const relativePath = fullPath.replace(`${workspaceRoot}/`, '');

            if (entry.isDir) {
              // Skip node_modules, .git, etc.
              if (!['node_modules', '.git', 'dist', '.svelte-kit', 'target'].includes(entry.name)) {
                stack.push(fullPath);
              }
            } else {
              if (entry.name.toLowerCase().includes(pattern) || relativePath.toLowerCase().includes(pattern)) {
                found.push(relativePath);
                if (found.length >= maxResults) break;
              }
            }
          }
        } catch {
          // Skip inaccessible dirs
        }
      }

      return {
        success: true,
        output: found.length > 0 ? found.join('\n') : 'No files found matching the pattern.'
      };
    }

    case 'get_file_tree': {
      const startPath = args.path ? resolvePath(String(args.path)) : workspaceRoot;
      const maxDepth = Number(args.depth) || 3;

      async function buildTree(currentPath: string, currentDepth: number): Promise<string[]> {
        if (currentDepth > maxDepth) return [];

        try {
          const entries = await invoke('list_dir', { path: currentPath }) as Array<{ name: string; isDir: boolean }>;
          const lines: string[] = [];

          for (const entry of entries) {
            const indent = '  '.repeat(currentDepth);
            if (entry.isDir) {
              if (['node_modules', '.git', 'dist', '.svelte-kit', 'target'].includes(entry.name)) {
                lines.push(`${indent}📁 ${entry.name}/ (skipped)`);
                continue;
              }
              lines.push(`${indent}📁 ${entry.name}/`);
              const children = await buildTree(`${currentPath}/${entry.name}`, currentDepth + 1);
              lines.push(...children);
            } else {
              lines.push(`${indent}📄 ${entry.name}`);
            }
          }
          return lines;
        } catch {
          return [`${'  '.repeat(currentDepth)}⚠️ Access denied`];
        }
      }

      const tree = await buildTree(startPath, 0);
      return {
        success: true,
        output: tree.join('\n') || 'Empty directory.'
      };
    }

    case 'search_symbols': {
      const query = String(args.query);

      try {
        // Use the existing workspace_search command which is highly optimized in Rust
        const result = await invoke<{
          files: Array<{
            path: string;
            matches: Array<{ line: number; lineContent: string }>;
          }>;
          totalMatches: number;
          truncated: boolean;
        }>('workspace_search', {
          options: {
            query,
            rootPath: workspaceRoot,
            useRegex: false,
            caseSensitive: false,
            wholeWord: true,
            includePatterns: [],
            excludePatterns: ['node_modules/**', '.git/**', 'dist/**', '.svelte-kit/**', 'target/**'],
            maxResults: 100,
            requestId: Date.now()
          }
        });

        if (result.totalMatches === 0) {
          return { success: true, output: `No symbols found matching "${query}"` };
        }

        const lines: string[] = [`Found ${result.totalMatches} matches:`];
        for (const file of result.files.slice(0, 10)) {
          for (const match of file.matches.slice(0, 5)) {
            lines.push(`${file.path}:${match.line}: ${match.lineContent.trim()}`);
          }
        }

        if (result.totalMatches > lines.length - 1) {
          lines.push(`... and many more matches.`);
        }

        return {
          success: true,
          output: lines.join('\n')
        };
      } catch (err) {
        return { success: false, error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'read_terminal': {
      // Get terminal ID - use AI terminal if not specified
      let terminalId = (typeof args.terminalId === 'string' && args.terminalId.trim())
        ? String(args.terminalId)
        : (typeof (args as Record<string, unknown>).sessionId === 'string' && String((args as Record<string, unknown>).sessionId).trim())
          ? String((args as Record<string, unknown>).sessionId)
          : '';
      
      // If no terminal ID specified, try to use the AI terminal
      if (!terminalId) {
        const aiSession = terminalStore.sessions.find(s => 
          terminalStore.getSessionLabel?.(s.id) === 'Volt AI'
        ) || terminalStore.activeSession;
        
        if (aiSession) {
          terminalId = aiSession.info.terminalId;
        } else {
          return { 
            success: false, 
            error: 'No terminal session found. Run a command first with run_command.' 
          };
        }
      }
      
      const maxLines = Number(args.maxLines) || 100;

      const session = terminalStore.sessions.find(s => s.info.terminalId === terminalId);
      if (!session) {
        return { success: false, error: `Terminal session ${terminalId} not found` };
      }

      const output = session.getRecentOutput(maxLines * 120);
      const cleaned = stripAnsi(output);
      
      // Check if command appears to still be running (no prompt at end)
      const lines = cleaned.split('\n').filter(l => l.trim());
      const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
      const promptPatterns = [
        /[>$#%]\s*$/,
        /^PS\s+[A-Z]:\\.*>\s*$/i,
        /^[A-Z]:\\.*>\s*$/i,
      ];
      const hasPrompt = promptPatterns.some(p => p.test(lastLine));
      
      const status = hasPrompt ? 'Command completed (prompt detected)' : 'Command may still be running...';

      const { text, truncated } = truncateOutput(cleaned);
      return {
        success: true,
        output: `${status}\n\n${text}`,
        truncated,
        meta: { terminalId, hasPrompt }
      };
    }

    // ============================================
    // DIAGNOSTICS TOOLS
    // ============================================
    case 'run_check': {
      const checkType = String(args.checkType);

      // Create a terminal and run the check command
      const cwd = workspaceRoot;
      const session = await terminalStore.createTerminal(cwd);
      if (!session) {
        return { success: false, error: 'Failed to create terminal for check' };
      }

      let command: string;
      switch (checkType) {
        case 'npm_check':
          command = 'npm run check';
          break;
        case 'cargo_check':
          command = 'cargo check';
          break;
        case 'eslint':
          command = 'npx eslint .';
          break;
        case 'typescript':
          command = 'npx tsc --noEmit';
          break;
        default:
          return { success: false, error: `Unknown check type: ${checkType}` };
      }

      await invoke('terminal_write', { terminalId: session.info.terminalId, data: command + '\n' });
      return {
        success: true,
        output: `Running ${checkType} in terminal ${session.info.terminalId}. Check the terminal panel for results.`
      };
    }

    case 'get_diagnostics': {
      const { problemsStore } = await import('$lib/stores/problems.svelte');
      const targetPath = args.path ? String(args.path).replace(/\\/g, '/') : null;

      const problems = targetPath
        ? problemsStore.getProblemsForFile(targetPath)
        : problemsStore.allProblems;

      if (problems.length === 0) {
        return { success: true, output: 'No problems detected.' };
      }

      // Format problems, prioritize errors
      const sorted = [...problems].sort((a, b) => {
        const severityMap = { error: 0, warning: 1, info: 2, hint: 3 };
        return severityMap[a.severity] - severityMap[b.severity];
      });

      const lines = sorted.slice(0, 50).map(p =>
        `[${p.severity.toUpperCase()}] ${p.file}:${p.line}:${p.column} - ${p.message} (${p.source})`
      );

      if (sorted.length > 50) {
        lines.push(`... and ${sorted.length - 50} more problems.`);
      }

      return { success: true, output: lines.join('\n') };
    }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

/**
 * Format tool call for display in UI
 */
export function formatToolCallForDisplay(toolCall: ToolCall): string {
  const meta = toolCall.arguments.meta as ToolMeta | undefined;
  const args = { ...toolCall.arguments };
  delete args.meta;

  const parts: string[] = [toolCall.name];

  if (meta?.why) {
    parts.push(`Why: ${meta.why}`);
  }

  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 50)}`)
    .join(', ');

  if (argStr) {
    parts.push(`Args: ${argStr}`);
  }

  return parts.join(' | ');
}
