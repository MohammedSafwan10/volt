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
 * Streaming progress callback for file write operations
 */
export interface StreamingProgressCallback {
  (progress: {
    charsWritten: number;
    totalChars: number;
    linesWritten: number;
    totalLines: number;
    percent: number;
  }): void;
}

/**
 * Tool execution options
 */
export interface ToolExecutionOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback for streaming progress (file writes) */
  onStreamingProgress?: StreamingProgressCallback;
  /** Whether to enable live streaming to editor (default: true for write_file) */
  enableStreaming?: boolean;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  truncated?: boolean;
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
      note: 'Diff summary limited due to file size.'
    };
  }

  const oldLinesArr = oldText.split(/\r?\n/);
  const newLinesArr = newText.split(/\r?\n/);
  const oldLines = oldLinesArr.length;
  const newLines = newLinesArr.length;

  const minLen = Math.min(oldLines, newLines);
  let first = -1;
  for (let i = 0; i < minLen; i++) {
    if (oldLinesArr[i] !== newLinesArr[i]) {
      first = i;
      break;
    }
  }

  // If all common lines match and lengths are equal, no changes.
  if (first === -1 && oldLines === newLines) {
    return { oldBytes, newBytes, oldLines, newLines, firstChangedLine: null, lastChangedLine: null };
  }

  // Find last differing line by scanning from the end.
  let last = -1;
  let iOld = oldLines - 1;
  let iNew = newLines - 1;
  while (iOld >= 0 && iNew >= 0) {
    if (oldLinesArr[iOld] !== newLinesArr[iNew]) {
      last = Math.max(iOld, iNew);
      break;
    }
    iOld--;
    iNew--;
  }

  const firstChangedLine = first >= 0 ? first + 1 : 1;
  const lastChangedLine = last >= 0 ? last + 1 : Math.max(oldLines, newLines);
  return { oldBytes, newBytes, oldLines, newLines, firstChangedLine, lastChangedLine };
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

  if (!normalizedFinal.startsWith(normalizedRootLower)) {
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
  if (/^PS\s+[A-Z]:\\[^>]*>\s*$/i.test(trimmed)) return true;
  
  // CMD: "C:\path>" or "C:\path> "
  if (/^[A-Z]:\\[^>]*>\s*$/i.test(trimmed)) return true;
  
  // Bash/Zsh: ends with $ or # (common prompt endings)
  if (/[$#]\s*$/.test(trimmed) && trimmed.length < 100) return true;
  
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
  const STABLE_THRESHOLD_MS = 800;
  
  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startTime;
      const currentOutput = session.getRecentOutput();
      
      // Check if we've seen the command echoed
      if (!commandSeen && currentOutput.includes(commandTrimmed)) {
        commandSeen = true;
      }
      
      // Only start checking for completion after command is echoed
      if (commandSeen) {
        // Check if output has changed
        if (currentOutput !== lastOutput) {
          lastOutput = currentOutput;
          lastOutputTime = Date.now();
        }
        
        // Check for output stabilization (no new output for a while)
        const timeSinceLastOutput = Date.now() - lastOutputTime;
        if (timeSinceLastOutput >= STABLE_THRESHOLD_MS && currentOutput.length > commandTrimmed.length + 10) {
          // Output has stabilized, check if we have a prompt at the end
          const lines = currentOutput.split(/[\r\n]+/).filter(l => l.trim());
          if (lines.length >= 2) {
            const lastLine = lines[lines.length - 1];
            // Only treat *normal* shell prompts as completion; ignore continuation prompts.
            if (isPromptLine(lastLine) && !isContinuationPromptLine(lastLine)) {
              resolve(currentOutput);
              return;
            }
          }
          
          // Even without prompt, if output is stable for long enough, we're done
          if (timeSinceLastOutput >= STABLE_THRESHOLD_MS * 2) {
            resolve(currentOutput);
            return;
          }
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

  // Check for required meta field
  const meta = extractMeta(args);
  if (!meta) {
    return { 
      valid: false, 
      error: `Tool "${toolName}" requires a 'meta' field with 'why', 'risk', and 'undo'`,
      requiresApproval: false 
    };
  }

  // Validate path arguments if present
  const workspaceRoot = projectStore.rootPath;
  if (args.path && typeof args.path === 'string') {
    const pathValidation = validatePathInWorkspace(args.path, workspaceRoot || '');
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error, requiresApproval: false };
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
  const { signal, onStreamingProgress, enableStreaming = true } = options;
  const workspaceRoot = projectStore.rootPath;

  // Create a timeout promise
  const timeoutPromise = new Promise<ToolResult>((_, reject) => {
    setTimeout(() => reject(new Error('Tool execution timed out')), TOOL_TIMEOUT_MS);
  });

  // Create abort handler
  const abortPromise = new Promise<ToolResult>((_, reject) => {
    if (signal) {
      signal.addEventListener('abort', () => reject(new Error('Tool execution cancelled')));
    }
  });

  try {
    const executionPromise = executeToolInternal(
      toolName, 
      args, 
      workspaceRoot || '',
      { onStreamingProgress, enableStreaming }
    );
    
    // Race between execution, timeout, and abort
    const result = await Promise.race([
      executionPromise,
      timeoutPromise,
      ...(signal ? [abortPromise] : [])
    ]);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Internal tool execution logic
 */
async function executeToolInternal(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  options: { onStreamingProgress?: StreamingProgressCallback; enableStreaming?: boolean } = {}
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
      const path = resolvePath(String(args.path));
      const content = await invoke<string>('read_file', { path });
      
      // Handle line range if specified
      let output = content;
      if (args.startLine || args.endLine) {
        const lines = content.split('\n');
        const start = Math.max(0, (Number(args.startLine) || 1) - 1);
        const end = args.endLine ? Number(args.endLine) : lines.length;
        output = lines.slice(start, end).join('\n');
      }
      
      const { text, truncated } = truncateOutput(output);
      return { success: true, output: text, truncated };
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
      const { onStreamingProgress, enableStreaming } = options;

      // If streaming is enabled and we have a progress callback, stream to editor
      if (enableStreaming && onStreamingProgress) {
        // Read existing content in parallel (non-blocking)
        const beforePromise = invoke<string>('read_file', { path }).catch(() => '');
        
        try {
          const { startStreaming } = await import('$lib/services/editor-streaming');
          
          // Start streaming and wait for completion
          await new Promise<void>((resolve, reject) => {
            startStreaming(relativePath, content, {
              chunkSize: 40, // Larger chunks for speed
              chunkDelay: 1, // Minimal delay
              onProgress: onStreamingProgress,
              onComplete: async () => {
                // After streaming completes, save the file to disk
                try {
                  await invoke('write_file', { path, content });
                  resolve();
                } catch (err) {
                  reject(err);
                }
              },
              onError: (error) => {
                reject(new Error(error));
              }
            }).catch(reject);
          });
          
          // Get the before content for summary (already resolved by now)
          const before = await beforePromise;
          
          // If this was a new file (before was empty), refresh the file tree
          if (!before) {
            const { projectStore } = await import('$lib/stores/project.svelte');
            await projectStore.refreshTree();
          }
          
          const summary = summarizeTextDiff(before, content);
          const range = (summary.firstChangedLine && summary.lastChangedLine)
            ? `Changed lines (approx): ${summary.firstChangedLine}–${summary.lastChangedLine}`
            : 'Changed lines (approx): unknown';
          const note = summary.note ? `\nNote: ${summary.note}` : '';

          return {
            success: true,
            output:
              `Wrote file: ${args.path}\n` +
              `Before: ${summary.oldBytes} bytes, ${summary.oldLines} lines\n` +
              `After:  ${summary.newBytes} bytes, ${summary.newLines} lines\n` +
              `${range}${note}`
          };
        } catch (err) {
          // Fallback to direct write if streaming fails
          console.warn('[write_file] Streaming failed, falling back to direct write:', err);
          await invoke('write_file', { path, content });
          
          // Still try to open the file in editor so user can see it
          try {
            const { editorStore } = await import('$lib/stores/editor.svelte');
            await editorStore.openFile(path);
          } catch {
            // Ignore - file was written, just couldn't open in editor
          }
          
          // Refresh file tree for new file
          const { projectStore } = await import('$lib/stores/project.svelte');
          await projectStore.refreshTree();
          
          return {
            success: true,
            output: `Wrote file: ${args.path} (${content.length} bytes)`
          };
        }
      } else {
        // Direct write without streaming
        let before = '';
        try {
          before = await invoke<string>('read_file', { path });
        } catch {
          before = '';
        }
        
        await invoke('write_file', { path, content });
        
        // If this was a new file (before was empty), refresh the file tree
        if (!before) {
          const { projectStore } = await import('$lib/stores/project.svelte');
          await projectStore.refreshTree();
        }
        
        const summary = summarizeTextDiff(before, content);
        const range = (summary.firstChangedLine && summary.lastChangedLine)
          ? `Changed lines (approx): ${summary.firstChangedLine}–${summary.lastChangedLine}`
          : 'Changed lines (approx): unknown';
        const note = summary.note ? `\nNote: ${summary.note}` : '';

        return {
          success: true,
          output:
            `Wrote file: ${args.path}\n` +
            `Before: ${summary.oldBytes} bytes, ${summary.oldLines} lines\n` +
            `After:  ${summary.newBytes} bytes, ${summary.newLines} lines\n` +
            `${range}${note}`
        };
      }
    }

    case 'create_file': {
      const path = resolvePath(String(args.path));
      await invoke('create_file', { path });
      
      // Refresh file tree to show new file
      const { projectStore } = await import('$lib/stores/project.svelte');
      await projectStore.refreshTree();
      
      return { success: true, output: `Created file: ${args.path}` };
    }

    case 'create_dir': {
      const path = resolvePath(String(args.path));
      await invoke('create_dir', { path });
      
      // Refresh file tree to show new directory
      const { projectStore } = await import('$lib/stores/project.svelte');
      await projectStore.refreshTree();
      
      return { success: true, output: `Created directory: ${args.path}` };
    }

    case 'delete_path': {
      const path = resolvePath(String(args.path));
      await invoke('delete_path', { path });
      
      // Close the file tab if it's open
      const { editorStore } = await import('$lib/stores/editor.svelte');
      const normalizedPath = path.replace(/\\/g, '/');
      const openFile = editorStore.openFiles.find(f => 
        f.path.replace(/\\/g, '/').toLowerCase() === normalizedPath.toLowerCase()
      );
      if (openFile) {
        editorStore.closeFile(openFile.path, true); // Force close
      }
      
      // Refresh file tree to remove deleted item
      const { projectStore } = await import('$lib/stores/project.svelte');
      projectStore.removeNode(path);
      
      return { success: true, output: `Deleted: ${args.path}` };
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
      const timeout = Number(args.timeout) || 20000;
      const cwd = args.cwd ? resolvePath(String(args.cwd)) : workspaceRoot;
      
      // Open the terminal panel so user can see the command running
      const { uiStore } = await import('$lib/stores/ui.svelte');
      uiStore.openBottomPanelTab('terminal');
      
      // Give UI time to render the terminal panel
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // VS Code-like behavior: use a dedicated AI terminal so user terminals
      // (often mid-command / REPL / multiline input) don't poison tool execution.
      let session = await terminalStore.getOrCreateAiTerminal(cwd);
      if (!session) {
        return { success: false, error: 'Failed to create terminal' };
      }
      terminalStore.setActive(session.id);
      
      const ensureReadyForCommand = async (attempt: number): Promise<TerminalSession | null> => {
        // Wait for backend readiness signal (or first output) before sending control sequences.
        // This avoids writing into a terminal that exists but whose PTY/shell isn't fully initialized yet.
        await session!.waitForReady(2500);

        // Clear output history before running command to get clean capture
        session!.clearOutputHistory();

        // Cancel any pending/incomplete input in the terminal first.
        // ESC cancels PowerShell multi-line input; Ctrl+C cancels running programs/REPL.
        try {
          await invoke('terminal_write', { terminalId: session!.info.terminalId, data: '\x1b' });
          await new Promise(resolve => setTimeout(resolve, 50));
          await invoke('terminal_write', { terminalId: session!.info.terminalId, data: '\x03' });
          await new Promise(resolve => setTimeout(resolve, 75));
          await invoke('terminal_write', { terminalId: session!.info.terminalId, data: '\x03' });
          await new Promise(resolve => setTimeout(resolve, 125));
        } catch {
          // Ignore errors from cancel sequence
        }

        // Nudge prompt rendering.
        try {
          await invoke('terminal_write', { terminalId: session!.info.terminalId, data: '\r\n' });
        } catch {
          // ignore
        }

        // Wait briefly for a *normal* prompt.
        await session!.waitForOutput((newOutput) => {
          return (
            /PS\s+[A-Z]:\\[^>]*>\s*$/im.test(newOutput) ||
            /^[A-Z]:\\[^>]*>\s*$/im.test(newOutput) ||
            /[$#]\s*$/m.test(newOutput)
          );
        }, 2500);

        const tail = session!.getRecentOutput(8000);
        const last = lastNonEmptyLine(tail);

        // If we still ended up in a continuation/REPL prompt, the session is “dirty”.
        if (isContinuationPromptLine(last) && attempt === 0) {
          await terminalStore.killTerminal(session!.id);
          session = await terminalStore.getOrCreateAiTerminal(cwd);
          if (!session) return null;
          terminalStore.setActive(session.id);
          return await ensureReadyForCommand(1);
        }

        return session!;
      };

      const ready = await ensureReadyForCommand(0);
      if (!ready) {
        return { success: false, error: 'Failed to prepare terminal for command execution' };
      }
      
      // Send the command with CRLF (works well across platforms; avoids PowerShell oddities on Windows)
      const commandToSend = command + '\r\n';
      
      try {
        await invoke('terminal_write', { 
          terminalId: session.info.terminalId, 
          data: commandToSend 
        });
      } catch (err) {
        return { 
          success: false, 
          error: `Failed to send command: ${err instanceof Error ? err.message : 'Unknown error'}` 
        };
      }
      
      // Wait for command to complete using smart detection
      const output = await waitForCommandCompletion(session, command, timeout);
      
      // Extract clean output (remove command echo and prompt)
      const cleanOutput = extractCommandOutput(output, command);
      
      const { text, truncated } = truncateOutput(cleanOutput);
      return { 
        success: true, 
        output: `$ ${command}\n\n${text}`,
        truncated 
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
      const terminalId = String(args.terminalId);
      const command = String(args.command);
      
      // Open the terminal panel
      const { uiStore } = await import('$lib/stores/ui.svelte');
      uiStore.openBottomPanelTab('terminal');
      
      // Ensure command ends with newline to execute (use CRLF for cross-platform safety)
      const commandWithNewline = /\r?\n$/.test(command) ? command : command + '\r\n';
      
      await invoke('terminal_write', { terminalId, data: commandWithNewline });
      return { success: true, output: `Sent command to terminal ${terminalId}: ${command}` };
    }

    case 'terminal_kill': {
      const terminalId = String(args.terminalId);
      await invoke('terminal_kill', { terminalId });
      return { success: true, output: `Killed terminal: ${terminalId}` };
    }

    case 'terminal_get_output': {
      // Terminal output is streamed via events, so we return a message
      // In a real implementation, we'd need to capture recent output
      return { 
        success: true, 
        output: 'Terminal output is streamed in real-time. Check the terminal panel for output.' 
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
