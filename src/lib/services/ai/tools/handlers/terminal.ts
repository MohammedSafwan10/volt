/**
 * Terminal tool handlers - Kiro-style with background process management
 * 
 * Tools:
 * - run_command: Execute command and wait for completion
 * - start_process: Start background process (dev servers, watchers)
 * - stop_process: Stop a background process
 * - list_processes: List all running background processes
 * - get_process_output: Read output from a specific process
 * - read_terminal: Read recent terminal output (legacy)
 */

import { terminalStore } from '$lib/stores/terminal.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import type { TerminalSession } from '$lib/services/terminal-client';
import { truncateOutput, type ToolResult } from '../utils';

// ============================================
// Shared AI Terminal Session
// ============================================

/**
 * Get the AI terminal session, creating if needed.
 * Always uses the same terminal for all AI operations.
 */
async function getAiTerminal(cwd?: string): Promise<TerminalSession> {
  // Open terminal panel so user can see what's happening
  uiStore.openBottomPanelTab('terminal');
  
  // Get or create AI terminal (store handles deduplication)
  const session = await terminalStore.getOrCreateAiTerminal(cwd);
  if (!session) {
    throw new Error('Failed to create terminal session');
  }
  
  console.log('[AI Terminal] Got session:', session.id);
  console.log('[AI Terminal] Session output history length:', session.getRecentOutput().length);
  
  // CRITICAL: Make sure this terminal is active/visible in the UI
  // This ensures the user sees the AI terminal, not some other terminal
  terminalStore.setActive(session.id);
  
  // Small delay to let the UI switch to the AI terminal
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Wait for terminal to be ready (backend handshake)
  const ready = await session.waitForReady(3000);
  console.log('[AI Terminal] Ready:', ready);
  
  return session;
}

// ============================================
// Background Process Tracking
// ============================================

interface BackgroundProcess {
  processId: number;
  command: string;
  cwd: string | undefined;
  startTime: number;
  status: 'running' | 'stopped';
}

// Simple process tracking (all use the same AI terminal)
const processes = new Map<number, BackgroundProcess>();
let nextProcessId = 1;

// ============================================
// Tool Handlers
// ============================================

/**
 * Run a shell command and wait for completion
 */
export async function handleRunCommand(args: Record<string, unknown>): Promise<ToolResult> {
  let command = String(args.command);
  const cwd = args.cwd ? String(args.cwd) : undefined;
  const timeout = Number(args.timeout) || 60000;

  // CRITICAL: Detect and reject chained commands with && (doesn't work in PowerShell)
  // AI should call run_command multiple times instead of chaining
  if (command.includes('&&')) {
    return {
      success: false,
      error: `Command contains "&&" which doesn't work in PowerShell. Run each command separately:\n${command.split('&&').map(c => `- ${c.trim()}`).join('\n')}\n\nCall run_command for each command individually.`
    };
  }

  // Also reject || chaining
  if (command.includes('||')) {
    return {
      success: false,
      error: `Command contains "||" which doesn't work reliably in PowerShell. Run commands separately.`
    };
  }

  // Check for long-running command patterns
  const longRunningPatterns = [
    /npm\s+run\s+(dev|start|watch)/i,
    /yarn\s+(dev|start|watch)/i,
    /pnpm\s+(dev|start|watch)/i,
    /npx\s+(serve|live-server|http-server|vite|next)/i,
    /webpack\s+--watch/i,
    /vite(\s|$)/i,
    /next\s+dev/i,
    /nodemon/i,
    /ts-node-dev/i,
    /cargo\s+watch/i,
    /flask\s+run/i,
    /python.*manage\.py\s+runserver/i,
    /python\s+-m\s+http\.server/i,
    /php\s+-S/i,
    /ruby.*-run/i
  ];

  const isLongRunning = longRunningPatterns.some(p => p.test(command));
  if (isLongRunning) {
    return {
      success: false,
      error: `This looks like a long-running command (dev server/watcher). Use "start_process" instead to run it in the background, then use "get_process_output" to check its status.`
    };
  }

  // Get AI terminal
  let session: TerminalSession;
  try {
    session = await getAiTerminal(cwd);
  } catch (err) {
    return { success: false, error: `Failed to create terminal: ${err}` };
  }

  // Clear previous output for clean capture
  session.clearOutputHistory();
  
  // Small delay to ensure terminal is fully ready
  await new Promise(resolve => setTimeout(resolve, 100));

  // Send command
  console.log('[AI Terminal] Sending command:', command);
  try {
    await session.write(command + '\r\n');
  } catch (err) {
    return { success: false, error: `Failed to send command: ${err}` };
  }

  // Wait for completion
  const output = await waitForCompletion(session, command, timeout);
  console.log('[AI Terminal] Raw output after wait:', output.length, 'chars');
  
  const cleaned = extractOutput(output, command);
  console.log('[AI Terminal] Cleaned output:', cleaned.length, 'chars');
  
  // Don't show "[No output]" as actual output - just leave it empty
  const finalOutput = cleaned === '[No output]' ? '' : cleaned;
  
  const { text, truncated } = truncateOutput(finalOutput);
  
  // Check for common error patterns
  const hasError = /\b(error|failed|exception|not found|ENOENT|EACCES)\b/i.test(cleaned);
  
  // Only include output in result if there's meaningful content
  const result: ToolResult = { 
    success: true,
    truncated,
    meta: { hasError }
  };
  
  if (text.trim()) {
    result.output = text;
  }
  
  return result;
}

/**
 * Start a background process (for dev servers, watchers, etc.)
 */
export async function handleStartProcess(args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command);
  const cwd = args.cwd ? String(args.cwd) : undefined;

  // Check if same command already running
  for (const [id, proc] of processes) {
    if (proc.command === command && proc.status === 'running') {
      // Return existing process
      uiStore.openBottomPanelTab('terminal');
      return {
        success: true,
        output: `Process already running (ID: ${id})`,
        meta: { processId: id, isReused: true }
      };
    }
  }

  try {
    // Get AI terminal
    const session = await getAiTerminal(cwd);
    
    // Clear previous output
    session.clearOutputHistory();
    
    // Small delay to ensure terminal is ready
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send command
    console.log('[AI Terminal] Starting process:', command);
    await session.write(command + '\r\n');

    // Create process record
    const processId = nextProcessId++;
    processes.set(processId, {
      processId,
      command,
      cwd,
      startTime: Date.now(),
      status: 'running'
    });

    // Wait for initial output (longer for npm/npx commands that may need to install)
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Get initial output
    const output = session.getRecentOutput();
    console.log('[AI Terminal] Initial output length:', output.length);
    
    const cleanedOutput = extractCommandOutput(output, command);
    console.log('[AI Terminal] Cleaned output length:', cleanedOutput.length);
    
    // Check if server started successfully
    const hasUrl = /https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(cleanedOutput);
    const hasError = /\b(error|failed|ENOENT|EACCES|cannot find|not found)\b/i.test(cleanedOutput);
    const needsInput = /\(y\/n\)|proceed\?|confirm|install.*\?/i.test(cleanedOutput);
    
    let statusMsg = '';
    if (needsInput) {
      statusMsg = '⚠ Process is waiting for user input - check terminal';
    } else if (hasUrl && !hasError) {
      statusMsg = '✓ Server appears to be running';
    } else if (hasError) {
      statusMsg = '⚠ There may be errors - check terminal';
    } else {
      statusMsg = 'Process started - check terminal for output';
    }
    
    // Only show output if there's meaningful content (not just prompt/command echo)
    const meaningfulOutput = cleanedOutput.length > 10 ? cleanedOutput : '';
    const outputSection = meaningfulOutput ? `\n\nOutput:\n${meaningfulOutput}` : '';
    
    return {
      success: true,
      output: `Started background process (ID: ${processId})\n${statusMsg}${outputSection}`,
      meta: { processId, hasUrl, hasError, needsInput }
    };
  } catch (err) {
    return { success: false, error: `Failed to start process: ${err}` };
  }
}

/**
 * Stop a background process
 */
export async function handleStopProcess(args: Record<string, unknown>): Promise<ToolResult> {
  const processId = Number(args.processId);
  
  if (!processId || isNaN(processId)) {
    return { success: false, error: 'Missing or invalid processId' };
  }

  const proc = processes.get(processId);
  if (!proc) {
    return { success: false, error: `Process ${processId} not found` };
  }

  if (proc.status === 'stopped') {
    return { success: true, output: `Process ${processId} already stopped` };
  }

  try {
    // Get AI terminal and send Ctrl+C
    const session = await getAiTerminal();
    await session.write('\x03'); // Ctrl+C
    
    proc.status = 'stopped';
    return { success: true, output: `Process ${processId} stopped (sent Ctrl+C)` };
  } catch (err) {
    return { success: false, error: `Failed to stop process: ${err}` };
  }
}

/**
 * List all background processes
 */
export async function handleListProcesses(): Promise<ToolResult> {
  if (processes.size === 0) {
    return { success: true, output: 'No background processes tracked' };
  }

  const lines = [];
  for (const proc of processes.values()) {
    const elapsed = Date.now() - proc.startTime;
    lines.push(`[${proc.processId}] ${proc.status.toUpperCase()} - ${proc.command} (${formatDuration(elapsed)})`);
  }

  return {
    success: true,
    output: `Background processes:\n${lines.join('\n')}`
  };
}

/**
 * Get output from a background process
 */
export async function handleGetProcessOutput(args: Record<string, unknown>): Promise<ToolResult> {
  const processId = Number(args.processId);
  const maxLines = Number(args.maxLines) || 100;
  
  if (!processId || isNaN(processId)) {
    return { success: false, error: 'Missing or invalid processId' };
  }

  const proc = processes.get(processId);
  if (!proc) {
    return { success: false, error: `Process ${processId} not found. Use list_processes to see available processes.` };
  }

  try {
    // Get output from AI terminal
    const session = await getAiTerminal();
    const output = session.getRecentOutput();
    
    console.log('[AI Terminal] getRecentOutput for process', processId);
    console.log('[AI Terminal] Raw output length:', output.length);
    
    if (!output || output.length === 0) {
      // No output yet - give a helpful message
      const elapsed = Date.now() - proc.startTime;
      const elapsedSec = Math.floor(elapsed / 1000);
      
      return {
        success: true,
        output: `Process ${processId} is running (${elapsedSec}s elapsed) but no output captured yet.\n\nThe process may still be starting. You can:\n1. Wait a few seconds and check again\n2. Look at the terminal panel in the UI\n3. Continue with other tasks - the process is running in the background`,
        meta: { processId, status: proc.status, noOutput: true }
      };
    }
    
    const lines = output.split('\n');
    const recent = lines.slice(-maxLines).join('\n');
    
    const cleaned = stripAnsi(recent);
    const { text, truncated } = truncateOutput(cleaned);

    // Check for common patterns
    const hasUrl = /https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(text);
    const hasError = /\b(error|failed|ENOENT|EACCES|cannot find|not found)\b/i.test(text);
    
    // Return meaningful output
    const finalOutput = text.trim() || `Process ${processId} is running but output is empty.`;

    return {
      success: true,
      output: finalOutput,
      truncated,
      meta: { processId, status: proc.status, hasUrl, hasError }
    };
  } catch (err) {
    return { success: false, error: `Failed to get output: ${err}` };
  }
}

/**
 * Read recent terminal output
 */
export async function handleReadTerminal(args: Record<string, unknown>): Promise<ToolResult> {
  const maxLines = Number(args.maxLines) || 100;
  
  try {
    const session = await getAiTerminal();
    const output = session.getRecentOutput();
    
    console.log('[AI Terminal] readTerminal output length:', output.length);
    
    if (!output || output.length === 0) {
      return { 
        success: true, 
        output: 'Terminal is active but no output captured yet. Run a command first or check the terminal panel.',
        meta: { empty: true }
      };
    }
    
    const lines = output.split('\n');
    const recent = lines.slice(-maxLines).join('\n');
    
    const cleaned = stripAnsi(recent);
    const { text, truncated } = truncateOutput(cleaned);
    
    return { 
      success: true, 
      output: text || 'Terminal output is empty.',
      truncated 
    };
  } catch (err) {
    return { success: true, output: 'No terminal session active. Use run_command or start_process to create one.' };
  }
}

// ============================================
// Helper functions
// ============================================

/**
 * Wait for command to complete
 */
async function waitForCompletion(
  session: TerminalSession,
  command: string,
  timeoutMs: number
): Promise<string> {
  const startTime = Date.now();
  let lastOutput = '';
  let lastOutputTime = startTime;
  const STABLE_MS = 800; // Increased from 500 for more reliable detection
  const MIN_WAIT_MS = 300; // Minimum wait before checking for completion

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startTime;
      const currentOutput = session.getRecentOutput();

      console.log('[waitForCompletion] Check at', elapsed, 'ms, output length:', currentOutput.length);

      if (currentOutput !== lastOutput) {
        lastOutput = currentOutput;
        lastOutputTime = Date.now();
        console.log('[waitForCompletion] Output changed, resetting stable timer');
      }

      // Don't check for completion too early
      if (elapsed < MIN_WAIT_MS) {
        setTimeout(check, 100);
        return;
      }

      // Check for prompt (command finished)
      const lines = currentOutput.split(/[\r\n]+/).filter(l => l.trim());
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        if (isPromptLine(lastLine) && !lastLine.includes(command.slice(0, 20))) {
          console.log('[waitForCompletion] Detected prompt line, command complete');
          resolve(currentOutput);
          return;
        }
      }

      // Check for stabilization (no new output for STABLE_MS)
      const timeSinceOutput = Date.now() - lastOutputTime;
      if (timeSinceOutput >= STABLE_MS && currentOutput.length > 0) {
        console.log('[waitForCompletion] Output stabilized for', timeSinceOutput, 'ms');
        resolve(currentOutput);
        return;
      }

      // Timeout
      if (elapsed >= timeoutMs) {
        console.log('[waitForCompletion] Timeout reached');
        resolve(currentOutput + '\n[Command timed out]');
        return;
      }

      setTimeout(check, 100);
    };

    // Start checking after a small delay to let initial output arrive
    setTimeout(check, 150);
  });
}

/**
 * Check if line looks like a shell prompt
 */
function isPromptLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  
  // PowerShell: PS C:\path>
  if (/^PS\s+.*>\s*$/i.test(trimmed)) return true;
  // CMD: C:\path>
  if (/^[A-Z]:\\.*>\s*$/i.test(trimmed)) return true;
  // Unix: ends with $ or #
  if (/[>#$%]\s*$/.test(trimmed) && trimmed.length < 200) return true;
  
  return false;
}

/**
 * Extract command output (remove echo and prompt)
 */
function extractOutput(capture: string, command: string): string {
  let cleaned = stripAnsi(capture).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  const lines = cleaned.split('\n');
  const cmdTrimmed = command.trim();
  
  // Find where command was echoed
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(cmdTrimmed.slice(0, 30))) {
      startIdx = i + 1;
      break;
    }
  }
  
  // Find where prompt starts (end of output)
  let endIdx = lines.length;
  for (let i = lines.length - 1; i >= startIdx; i--) {
    if (lines[i].trim() && !isPromptLine(lines[i])) {
      endIdx = i + 1;
      break;
    }
  }
  
  const output = lines.slice(startIdx, endIdx).join('\n').trim();
  return output || '[No output]';
}

/**
 * Extract meaningful output from command (for background processes)
 * More aggressive filtering for cleaner display
 */
function extractCommandOutput(capture: string, command: string): string {
  let cleaned = stripAnsi(capture).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  const lines = cleaned.split('\n');
  const cmdTrimmed = command.trim();
  
  // Find where command was echoed
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip prompt lines and command echo
    if (line.includes(cmdTrimmed.slice(0, 20)) || isPromptLine(line)) {
      startIdx = i + 1;
    }
  }
  
  // Filter out empty lines and prompts from the end
  let endIdx = lines.length;
  for (let i = lines.length - 1; i >= startIdx; i--) {
    const line = lines[i].trim();
    if (line && !isPromptLine(lines[i])) {
      endIdx = i + 1;
      break;
    }
    endIdx = i;
  }
  
  // Get output lines and filter empty ones
  const outputLines = lines.slice(startIdx, endIdx)
    .map(l => l.trimEnd())
    .filter(l => l.length > 0);
  
  return outputLines.join('\n').trim();
}

/**
 * Strip ANSI escape codes
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[NOPXZc^_]/g, '')
    .replace(/\x1b./g, '');
}

/**
 * Format duration
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
