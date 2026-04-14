/**
 * Unified Terminal Tool Handlers (v2)
 *
 * Replaces the fragmented 6-tool surface with 4 clean tools:
 *   - run_in_terminal: Execute command in sync or async mode
 *   - get_terminal_output: Read output from a persistent terminal by ID
 *   - send_to_terminal: Send follow-up input to a persistent terminal
 *   - kill_terminal: Kill a persistent terminal by ID
 *
 * Internally uses the execute strategy tiers, OutputMonitor for prompt
 * detection, and the terminal registry for lifecycle management.
 */

import { terminalStore } from '$features/terminal/stores/terminal.svelte';
import { projectStore } from '$shared/stores/project.svelte';
import { uiStore } from '$shared/stores/ui.svelte';
import {
  POWERSHELL_SHELL_INTEGRATION_IDENTITY,
  type TerminalSession,
} from '$features/terminal/services/terminal-client';
import {
  generateTerminalId,
  registerTerminal,
  getRegisteredTerminal,
  unregisterTerminal,
  getAllRegisteredTerminals,
  attachMonitor,
  setupBackgroundCompletion,
  type RegisteredTerminal,
} from '$features/terminal/services/terminal-registry';
import {
  detectShellIntegrationQuality,
} from '$features/terminal/services/execute-strategy';
import { OutputMonitorState } from '$features/terminal/services/output-monitor';
import { detectsInputRequiredPattern } from '$features/terminal/services/idle-detection';
import { truncateOutput, extractErrorMessage, type ToolResult } from '$core/ai/tools/utils';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCwd(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function resolveToolCwd(rawCwd: unknown): string | undefined {
  const projectRoot = projectStore.rootPath?.trim() || undefined;
  const explicitCwd =
    typeof rawCwd === 'string' && rawCwd.trim() ? rawCwd.trim() : undefined;

  if (!projectRoot) return explicitCwd;
  if (!explicitCwd) return projectRoot;

  const normalizedProjectRoot = normalizeCwd(projectRoot);
  const normalizedExplicit = normalizeCwd(explicitCwd);
  const cwdWithinProject =
    normalizedExplicit &&
    normalizedProjectRoot &&
    (normalizedExplicit === normalizedProjectRoot ||
      normalizedExplicit.startsWith(`${normalizedProjectRoot}/`));

  return cwdWithinProject ? explicitCwd : projectRoot;
}

function requireToolCwd(rawCwd: unknown): string {
  const cwd = resolveToolCwd(rawCwd);
  if (cwd) return cwd;
  throw new Error('No active project root available for terminal command cwd');
}

function extractLeadingCdDirective(
  command: string,
  explicitCwd?: string,
): { command: string; cwd: string | undefined } {
  const trimmed = command.trim();
  const patterns: RegExp[] = [
    /^\s*cd\s+\/d\s+(['"]?)(.+?)\1\s*(?:;|&&)\s*([\s\S]+)$/i,
    /^\s*cd\s+(['"]?)(.+?)\1\s*(?:;|&&)\s*([\s\S]+)$/i,
    /^\s*set-location(?:\s+-literalpath|\s+-path)?\s+(['"])(.+?)\1\s*(?:;|&&)\s*([\s\S]+)$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const extractedCwd = match[2]?.trim();
    const remainder = match[3]?.trim();
    if (!extractedCwd || !remainder) continue;
    if (explicitCwd && normalizeCwd(explicitCwd) !== normalizeCwd(extractedCwd)) {
      return { command, cwd: explicitCwd };
    }
    return { command: remainder, cwd: extractedCwd };
  }

  return { command, cwd: explicitCwd };
}

function getBlockedCommandReason(command: string): string | null {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();

  const mutatingShellVerb =
    /\b(move-item|rename-item|remove-item|del|erase|rmdir|rd|rm|mv|ren)\b/i;
  const touchesVoltDir = /(^|[\s"'`\\/])\.volt([\\/\s"'`]|$)/i.test(command);
  if (touchesVoltDir && mutatingShellVerb.test(command)) {
    return 'Blocked unsafe command: modifying `.volt` is not allowed because it can break plans/chat state.';
  }

  if (
    /\bcreate-next-app(?:@[\w.-]+)?\b/i.test(normalized) &&
    /(?:^|\s)\.(?:\s|$)/.test(normalized)
  ) {
    return 'Blocked unsafe scaffold target: do not run create-next-app in `.`. Scaffold into a temp/subfolder and move app files instead.';
  }

  // Block bare `exit` / `exit <code>` — it kills the AI terminal process itself
  if (/^exit(?:\s+\d+)?\s*$/.test(normalized)) {
    return 'Blocked: `exit` kills the terminal shell process. To test a non-zero exit code, use `cmd /c "exit 42"` (Windows) or `bash -c "exit 42"` (Unix) instead.';
  }

  return null;
}

function isLikelyDevServer(command: string): boolean {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return false;
  const npmRun = /\b(npm|pnpm|yarn)\s+(run\s+)?(dev|serve|start|preview|watch)\b/i;
  const common = /\b(vite|next\s+dev|nuxt\s+dev|astro\s+dev|svelte-kit\s+dev|react-scripts\s+start|ng\s+serve|nx\s+serve|bun\s+run\s+dev|deno\s+task\s+dev)\b/i;
  const avoid = /\b(npm|pnpm|yarn)\s+install\b/i;
  if (avoid.test(cmd)) return false;
  return npmRun.test(cmd) || common.test(cmd);
}

function extractLocalhostUrls(text: string): string[] {
  if (!text) return [];
  const urls = new Set<string>();
  const normalize = (url: string) =>
    url.replace('0.0.0.0', 'localhost').replace('[::]', 'localhost').replace('::1', 'localhost');

  const direct = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|::1)(?::\d{2,5})?(?:\/[^\s"'<>]*)?/gi) || [];
  for (const url of direct) urls.add(normalize(url));

  const hostPort = text.match(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|::1):\d{2,5}(?:\/[^\s"'<>]*)?/gi) || [];
  for (const hp of hostPort) urls.add(normalize(`http://${hp}`));

  return [...urls];
}

async function ensureTerminalSession(cwd?: string): Promise<TerminalSession> {
  let session = await terminalStore.getOrCreateAiTerminal(cwd);
  if (!session) throw new Error('Failed to access AI terminal');

  // Health check: verify the terminal is still alive by testing waitForReady.
  // If a previous command (e.g. `exit`) killed the shell, the session is dead.
  const isReady = await session.waitForReady(2000);
  if (!isReady) {
    console.warn('[TerminalV2] AI terminal appears dead, recreating...');
    session = await terminalStore.recreateAiTerminal(cwd);
    if (!session) throw new Error('Failed to recreate AI terminal after dead session detected');
  }

  await session.waitForReady(3000);
  const needsPowerShellRefresh =
    /powershell|pwsh/i.test(session.info.shell) &&
    session.shellIntegrationIdentity !== POWERSHELL_SHELL_INTEGRATION_IDENTITY;

  if (!session.hasShellIntegration || needsPowerShellRefresh) {
    await session.enableShellIntegration();
  }

  if (
    /powershell|pwsh/i.test(session.info.shell) &&
    (!session.hasShellIntegration ||
      session.shellIntegrationIdentity !== POWERSHELL_SHELL_INTEGRATION_IDENTITY)
  ) {
    console.warn('[TerminalV2] PowerShell shell integration did not initialize; recreating.');
    session = await terminalStore.recreateAiTerminal(cwd);
    if (!session) throw new Error('Failed to recreate AI terminal for shell integration');
    await session.waitForReady(3000);
    if (
      !session.hasShellIntegration ||
      session.shellIntegrationIdentity !== POWERSHELL_SHELL_INTEGRATION_IDENTITY
    ) {
      await session.enableShellIntegration();
    }
  }

  terminalStore.setActive(session.id);
  return session;
}

// ---------------------------------------------------------------------------
// run_in_terminal
// ---------------------------------------------------------------------------

export async function handleRunInTerminal(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const normalized = extractLeadingCdDirective(String(args.command), resolveToolCwd(args.cwd));
  const command = normalized.command.trim();
  const cwd = requireToolCwd(normalized.cwd);
  const mode = String(args.mode || 'sync');
  const timeoutMs = typeof args.timeout === 'number' ? args.timeout : (mode === 'async' ? 30_000 : 90_000);

  // Block dangerous commands
  const blockedReason = getBlockedCommandReason(command);
  if (blockedReason) {
    return {
      success: false,
      error: blockedReason,
      output: 'Use a safe non-destructive command.',
      code: 'COMMAND_BLOCKED',
      retryable: false,
    };
  }

  try {
    uiStore.openBottomPanelTab('terminal');
    const session = await ensureTerminalSession(cwd);
    const termId = generateTerminalId();
    const startOffset = session.getCleanOutputCursor();
    const isAsync = mode === 'async';

    // Register the terminal
    const entry: RegisteredTerminal = {
      termId,
      session,
      command,
      cwd,
      isAsync,
      startedAt: Date.now(),
      startOffset,
      monitor: null,
    };
    registerTerminal(entry);

    // Publish initial live update
    runtime?.onUpdate?.({
      liveStatus: `Running: ${command}`,
      meta: {
        terminalRun: {
          state: 'running',
          commandPreview: command,
          terminalId: termId,
        },
      },
    });

    // Determine execution strategy based on shell integration quality
    const quality = detectShellIntegrationQuality(session);

    if (isAsync) {
      // Async mode: execute the command, wait briefly for initial output, return ID
      const completion = session.executeCommand(command, timeoutMs);

      // Set up output monitor for prompt detection
      const monitor = attachMonitor(termId, {
        onPromptDetected: (info) => {
          runtime?.onUpdate?.({
            liveStatus: `Terminal ${termId} waiting for input: ${info.type}`,
            meta: { terminalPrompt: info },
          });
        },
      });
      entry.monitor = monitor;

      // Wait for initial idle or first output
      if (monitor) {
        const pollResult = await monitor.pollForIdle();
        // If the command is already done (prompt detected), capture final output
        if (pollResult.state === OutputMonitorState.Idle) {
          // Auto-detect dev servers
          const output = session.getCleanOutputSince(startOffset);
          const urls = extractLocalhostUrls(output);
          if (urls.length > 0) entry.detectedUrl = urls[0];

          // Set up background monitoring for prompt detection
          monitor.continueMonitoringAsync();
        }
      }

      // Set up completion notification
      setupBackgroundCompletion(termId, (output, exitCode) => {
        runtime?.onUpdate?.({
          liveStatus: `Terminal ${termId} command completed (exit code ${exitCode})`,
          meta: {
            terminalRun: {
              state: exitCode === 0 ? 'completed' : 'failed',
              terminalId: termId,
            },
          },
        });
      });

      const initialOutput = session.getCleanOutputSince(startOffset);
      const { text: truncatedOutput } = truncateOutput(initialOutput);
      const urlHint = entry.detectedUrl ? `\nDetected URL: ${entry.detectedUrl}` : '';

      return {
        success: true,
        output: `Terminal ${termId} started in async mode.\n\nCommand: ${command}${urlHint}\n\nInitial output:\n${truncatedOutput || '(No output yet)'}`,
        meta: {
          terminalId: termId,
          mode: 'async',
          detectedUrl: entry.detectedUrl,
        },
      };
    } else {
      // Sync mode: execute and wait for completion
      const result = await session.executeCommand(command, timeoutMs);
      const output = session.getCleanOutputSince(startOffset);
      const effectiveOutput = output || result.output;
      const { text: truncatedOutput } = truncateOutput(effectiveOutput);

      // Check for detected URLs
      const urls = extractLocalhostUrls(effectiveOutput);
      if (urls.length > 0) entry.detectedUrl = urls[0];

      // Check if command turned into a long-running process
      if (isLikelyDevServer(command) && result.timedOut) {
        // Auto-switch to async mode
        entry.isAsync = true;
        const monitor = attachMonitor(termId);
        entry.monitor = monitor;
        monitor?.continueMonitoringAsync();

        const urlHint = entry.detectedUrl ? `\nDetected URL: ${entry.detectedUrl}` : '';

        return {
          success: true,
          output: `Command appears to be a long-running process. Switched to async mode.\nTerminal ID: ${termId}${urlHint}\n\nOutput so far:\n${truncatedOutput || '(No output yet)'}`,
          meta: {
            terminalId: termId,
            mode: 'async',
            detectedUrl: entry.detectedUrl,
            autoDetached: true,
          },
        };
      }

      // Check for interactive prompts in the output
      if (result.timedOut && detectsInputRequiredPattern(effectiveOutput)) {
        entry.isAsync = true;
        const monitor = attachMonitor(termId);
        entry.monitor = monitor;
        monitor?.continueMonitoringAsync();

        return {
          success: true,
          output: `Command is waiting for user input. Terminal ID: ${termId}\n\nOutput:\n${truncatedOutput}\n\nUse send_to_terminal to provide input.`,
          meta: {
            terminalId: termId,
            mode: 'async',
            waitingForInput: true,
          },
        };
      }

      // Normal completion — clean up from registry (not persistent)
      unregisterTerminal(termId);

      runtime?.onUpdate?.({
        liveStatus: result.exitCode === 0 ? 'Command completed' : `Command failed (exit code ${result.exitCode})`,
        meta: {
          terminalRun: {
            state: result.exitCode === 0 ? 'completed' : 'failed',
            commandPreview: command,
          },
          terminalOutput: truncatedOutput,
        },
      });

      const exitInfo = result.timedOut
        ? 'Command timed out.'
        : `Exit code: ${result.exitCode}`;

      return {
        success: !result.timedOut && result.exitCode === 0,
        output: truncatedOutput || (result.timedOut ? '[Timeout]' : '[Done]'),
        error: result.timedOut ? 'Command timed out' : (result.exitCode !== 0 ? `Command failed with exit code ${result.exitCode}` : undefined),
        meta: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          terminalRun: {
            state: result.timedOut ? 'timeout' : (result.exitCode === 0 ? 'completed' : 'failed'),
            commandPreview: command,
          },
        },
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `Terminal execution failed: ${extractErrorMessage(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// get_terminal_output
// ---------------------------------------------------------------------------

export async function handleGetTerminalOutput(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const termId = String(args.id);
  const maxLines = Number(args.maxLines) || 200;

  const entry = getRegisteredTerminal(termId);
  if (!entry) {
    return {
      success: false,
      error: `No active terminal found with ID ${termId}. The terminal may have been killed or the ID is invalid.`,
    };
  }

  const output = entry.session.getCleanOutputSince(entry.startOffset);
  const lines = output.split('\n');
  const recent = lines.slice(-maxLines).join('\n');
  const { text: truncated } = truncateOutput(recent);

  // Check for new detected URLs
  const urls = extractLocalhostUrls(output);
  if (urls.length > 0) entry.detectedUrl = urls[0];

  const urlHint = entry.detectedUrl ? `\n\nDetected URL: ${entry.detectedUrl}` : '';
  const promptHint = detectsInputRequiredPattern(output)
    ? '\n\n⚠️ Terminal appears to be waiting for input. Use send_to_terminal to respond.'
    : '';

  return {
    success: true,
    output: (truncated || '(No output yet)') + urlHint + promptHint,
    meta: {
      terminalId: termId,
      command: entry.command,
      isAsync: entry.isAsync,
      detectedUrl: entry.detectedUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// send_to_terminal
// ---------------------------------------------------------------------------

export async function handleSendToTerminal(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const termId = String(args.id);
  const input = String(args.input ?? args.command ?? args.text ?? '');

  if (!input) {
    return { success: false, error: 'Missing "input" parameter — the text to send to the terminal.' };
  }

  const entry = getRegisteredTerminal(termId);
  if (!entry) {
    return {
      success: false,
      error: `No active terminal found with ID ${termId}. The terminal may have been killed or the ID is invalid.`,
    };
  }

  try {
    await entry.session.write(input + '\r');
    return {
      success: true,
      output: `Sent input to terminal ${termId}. Use get_terminal_output to check for updated output.`,
      meta: { terminalId: termId },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to send input to terminal: ${extractErrorMessage(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// kill_terminal
// ---------------------------------------------------------------------------

export async function handleKillTerminal(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const termId = String(args.id);

  const entry = getRegisteredTerminal(termId);
  if (!entry) {
    return {
      success: false,
      error: `No active terminal found with ID ${termId}. The terminal may have already been killed or the ID is invalid.`,
    };
  }

  // Get final output before killing
  const finalOutput = entry.session.getCleanOutputSince(entry.startOffset);

  // Interrupt + kill
  try {
    await entry.session.interrupt();
  } catch { /* ignore */ }

  try {
    await terminalStore.killTerminal(entry.session.id);
  } catch { /* ignore */ }

  // Unregister
  unregisterTerminal(termId);

  const { text: truncated } = truncateOutput(finalOutput);
  const outputSummary = truncated
    ? `Final output before termination:\n${truncated}`
    : 'No output was captured.';

  return {
    success: true,
    output: `Successfully killed terminal ${termId}. ${outputSummary}`,
    meta: { terminalId: termId },
  };
}

// ---------------------------------------------------------------------------
// Backward compatibility aliases
// ---------------------------------------------------------------------------

/**
 * run_command → run_in_terminal(mode: 'sync')
 * Preserves full backward compatibility with the old tool surface.
 */
export async function handleRunCommandV2(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  return handleRunInTerminal({ ...args, mode: 'sync' }, runtime);
}

/**
 * start_process → run_in_terminal(mode: 'async')
 */
export async function handleStartProcessV2(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  return handleRunInTerminal({ ...args, mode: 'async' }, runtime);
}

/**
 * get_process_output → get_terminal_output (maps processId → termId lookup)
 */
export async function handleGetProcessOutputV2(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // If `id` is provided directly, use it
  if (typeof args.id === 'string') {
    return handleGetTerminalOutput(args);
  }

  // Legacy: try to find by processId in the registry (backward compat)
  const processId = Number(args.processId);
  if (!isNaN(processId)) {
    const terminals = getAllRegisteredTerminals();
    const match = terminals.find(t => t.legacyProcessId === processId);
    if (match) {
      return handleGetTerminalOutput({ ...args, id: match.termId });
    }
  }

  return {
    success: false,
    error: `No terminal or process found. Provide a valid terminal "id" returned by run_in_terminal.`,
  };
}
