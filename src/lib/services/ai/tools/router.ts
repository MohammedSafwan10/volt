/**
 * AI Tool Router
 * 
 * Clean architecture:
 * - router.ts: validation + dispatch (this file)
 * - definitions.ts: tool schemas
 * - utils.ts: shared helpers
 * - handlers/: individual tool implementations
 */

import { projectStore } from '$lib/stores/project.svelte';
import { getToolByName, isToolAllowed } from './definitions';
import { validatePathInWorkspace, type ToolResult, type CanonicalToolResult } from './utils';
import { toolHandlers } from './handlers';
import { isMcpTool, executeMcpTool, isMcpToolAutoApproved, getMcpToolInfo } from './handlers/mcp';
import type { AIMode } from '$lib/stores/ai.svelte';
import { getToolCapabilities } from './capabilities';
import { toolObservabilityStore } from '$lib/stores/tool-observability.svelte';

// Timeout for tool operations (30 seconds default)
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max
const TERMINAL_TOOL_DEFAULT_TIMEOUT_MS = MAX_TIMEOUT_MS;

/**
 * Tool execution options
 */
export interface ToolExecutionOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

/**
 * Tool validation result
 */
export interface ToolValidation {
  valid: boolean;
  error?: string;
  requiresApproval: boolean;
}

// Re-export ToolResult types for convenience
export type { ToolResult, CanonicalToolResult } from './utils';

const IDEMPOTENCY_RESULT_TTL_MS = 2 * 60 * 1000;
const idempotentResultCache = new Map<string, { result: CanonicalToolResult; expiresAt: number }>();
const idempotentInFlight = new Map<string, Promise<CanonicalToolResult>>();

/**
 * Validate a tool call before execution
 */
export function validateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  mode: AIMode
): ToolValidation {
  // Check if it's an MCP tool
  if (isMcpTool(toolName)) {
    // MCP tools are allowed in agent mode only
    if (mode !== 'agent') {
      return {
        valid: false,
        error: `MCP tools are only available in agent mode`,
        requiresApproval: false
      };
    }

    // Check if auto-approved
    const requiresApproval = !isMcpToolAutoApproved(toolName);
    return { valid: true, requiresApproval };
  }

  // Check if tool exists
  const tool = getToolByName(toolName);
  if (!tool) {
    return { valid: false, error: `Unknown tool: ${toolName}`, requiresApproval: false };
  }

  // Check if tool is allowed in current mode
  if (!isToolAllowed(toolName, mode)) {
    return {
      valid: false,
      error: `Tool "${toolName}" not allowed in ${mode} mode`,
      requiresApproval: false
    };
  }

  // Validate required parameters
  const paramError = validateRequiredParams(toolName, args);
  if (paramError) {
    return { valid: false, error: paramError, requiresApproval: false };
  }

  // Validate path is within workspace (if path param exists)
  const workspaceRoot = projectStore.rootPath;
  const capabilities = getToolCapabilities(toolName);
  if (workspaceRoot && capabilities.requiresWorkspacePathValidation) {
    const pathsToValidate = collectPaths(args);
    for (const path of pathsToValidate) {
      const pathValidation = validatePathInWorkspace(path, workspaceRoot);
      if (!pathValidation.valid) {
        return { valid: false, error: pathValidation.error, requiresApproval: false };
      }
    }
  }

  return {
    valid: true,
    requiresApproval: capabilities.requiresApproval
  };
}

function collectPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const addPath = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) {
      paths.push(value);
    }
  };

  addPath(args.path);
  addPath(args.oldPath);
  addPath(args.newPath);
  addPath(args.cwd);

  if (Array.isArray(args.paths)) {
    for (const value of args.paths) {
      addPath(value);
    }
  }

  return paths;
}

/**
 * Validate required parameters for each tool
 */
function validateRequiredParams(toolName: string, args: Record<string, unknown>): string | null {
  const requireString = (key: string, altKey?: string): string | null => {
    const val = args[key] ?? (altKey ? args[altKey] : undefined);
    if (typeof val === 'string' && val.trim().length > 0) return null;
    return `Missing "${key}"`;
  };

  const requireArray = (key: string): string | null => {
    if (Array.isArray(args[key]) && args[key].length > 0) return null;
    return `Missing "${key}" (expected array)`;
  };

  switch (toolName) {
    // Read tools
    case 'list_dir':
    case 'read_file':
    case 'get_file_info':
    case 'file_outline':
      return requireString('path');

    case 'read_files':
      return requireArray('paths');

    // Search tools
    case 'workspace_search':
    case 'find_files':
    case 'search_symbols':
      return requireString('query');

    // Write tools
    case 'write_file':
    case 'append_file': {
      const pathErr = requireString('path');
      if (pathErr) return pathErr;
      // Accept both 'text' and 'content'
      const hasText = typeof args.text === 'string';
      const hasContent = typeof args.content === 'string';
      if (!hasText && !hasContent) return 'Missing "text"';
      return null;
    }

    case 'str_replace':
    case 'apply_edit': {
      const pathErr = requireString('path');
      if (pathErr) return pathErr;
      // Accept both new and old param names
      const hasOld = typeof args.oldStr === 'string' || typeof args.original_snippet === 'string';
      const hasNew = typeof args.newStr === 'string' || typeof args.new_snippet === 'string';
      if (!hasOld) return 'Missing "oldStr"';
      if (!hasNew) return 'Missing "newStr"';
      return null;
    }

    case 'create_dir':
      return requireString('path');

    case 'delete_file':
    case 'delete_path': {
      const pathErr = requireString('path');
      if (pathErr) return pathErr;
      return requireString('explanation');
    }

    case 'rename_path': {
      const oldErr = requireString('oldPath');
      if (oldErr) return oldErr;
      return requireString('newPath');
    }

    case 'write_plan_file': {
      const filenameErr = requireString('filename');
      if (filenameErr) return filenameErr;
      return requireString('content');
    }

    case 'replace_lines': {
      const pathErr = requireString('path');
      if (pathErr) return pathErr;
      if (typeof args.start_line !== 'number') return 'Missing "start_line"';
      if (typeof args.end_line !== 'number') return 'Missing "end_line"';
      if (typeof args.content !== 'string') return 'Missing "content"';
      return null;
    }

    case 'multi_replace': {
      const pathErr = requireString('path');
      if (pathErr) return pathErr;
      if (!Array.isArray(args.edits) || args.edits.length === 0) return 'Missing "edits" (expected non-empty array)';
      return null;
    }

    // Terminal tools
    case 'run_command':
    case 'start_process':
      return requireString('command');

    case 'send_terminal_input':
      return requireString('text');

    case 'stop_process':
    case 'get_process_output':
    case 'command_status':
      if (typeof args.processId !== 'number') return 'Missing "processId"';
      return null;

    case 'list_processes':
    case 'read_terminal':
      return null;

    // Browser tools - read-only
    case 'browser_get_console_logs':
    case 'browser_get_errors':
    case 'browser_get_network_requests':
    case 'browser_get_performance':
    case 'browser_get_selected_element':
    case 'browser_get_summary':
    case 'browser_screenshot':
    case 'browser_scroll':
      return null;

    case 'browser_navigate':
      return requireString('url');

    case 'browser_click':
    case 'browser_get_element':
    case 'browser_wait_for':
      return requireString('selector');

    case 'browser_get_elements':
      return requireString('selector');

    case 'browser_type':
      return requireString('text');

    case 'browser_evaluate':
      return requireString('expression');

    // No required params
    case 'get_file_tree':
    case 'get_active_file':
    case 'get_selection':
    case 'get_open_files':
    case 'get_diagnostics':
    case 'get_tool_metrics':
      return null;

    default:
      return null;
  }
}

/**
 * Execute a tool call
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolExecutionOptions = {}
): Promise<CanonicalToolResult> {
  const { signal, idempotencyKey } = options;
  const signature = createToolSignature(toolName, args);

  purgeExpiredIdempotencyCache();

  if (idempotencyKey) {
    const cached = idempotentResultCache.get(idempotencyKey);
    if (cached && cached.expiresAt > Date.now()) {
      const replayMeta: Record<string, any> = {
        ...(cached.result.meta ?? {}),
        replayed: true,
        idempotencyKey,
        signature,
      };
      const replayResult = {
        ...cached.result,
        timestamp: Date.now(),
        meta: replayMeta,
      };
      toolObservabilityStore.record({
        timestamp: Date.now(),
        toolName,
        signature,
        idempotencyKey,
        durationMs: 0,
        success: replayResult.success,
        code: replayResult.code,
        retryable: replayResult.retryable,
        attempt: Number(replayMeta.attempts ?? 1),
        maxAttempts: Number(replayMeta.maxAttempts ?? 1),
        replayed: true,
      });
      return replayResult;
    }

    const inFlight = idempotentInFlight.get(idempotencyKey);
    if (inFlight) {
      toolObservabilityStore.record({
        timestamp: Date.now(),
        toolName,
        signature,
        idempotencyKey,
        durationMs: 0,
        success: true,
        code: 'IDEMPOTENT_IN_FLIGHT',
        retryable: false,
        attempt: 1,
        maxAttempts: 1,
        replayed: true,
      });
      return inFlight;
    }
  }

  const executionPromise = executeToolCallInternal(toolName, args, {
    signal,
    idempotencyKey,
    signature,
  });

  if (idempotencyKey) {
    idempotentInFlight.set(idempotencyKey, executionPromise);
  }

  try {
    const result = await executionPromise;
    if (idempotencyKey) {
      idempotentResultCache.set(idempotencyKey, {
        result,
        expiresAt: Date.now() + IDEMPOTENCY_RESULT_TTL_MS,
      });
    }
    return result;
  } finally {
    if (idempotencyKey) {
      idempotentInFlight.delete(idempotencyKey);
    }
  }
}

async function executeToolCallInternal(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolExecutionOptions & { signature: string }
): Promise<CanonicalToolResult> {
  const { signal, idempotencyKey, signature } = options;

  if (isMcpTool(toolName)) {
    const startedAt = Date.now();
    const result = await executeMcpTool(toolName, args);
    const normalized = normalizeToolResult(toolName, result, {
      idempotencyKey,
      signature,
      attempt: 1,
      maxAttempts: 1,
    });
    recordExecutionTelemetry(toolName, signature, idempotencyKey, normalized, Date.now() - startedAt, 1, 1, false);
    return normalized;
  }

  const capabilities = getToolCapabilities(toolName);
  const defaultTimeout = capabilities.isLongRunning ? TERMINAL_TOOL_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const requestedTimeout = typeof args.timeout === 'number' ? args.timeout : defaultTimeout;
  const timeoutMs = Math.min(Math.max(0, requestedTimeout), MAX_TIMEOUT_MS);

  const handler = toolHandlers[toolName];
  if (!handler) {
    const normalized = normalizeToolResult(toolName, { success: false, error: `No handler for tool: ${toolName}` }, {
      idempotencyKey,
      signature,
      attempt: 1,
      maxAttempts: 1,
    });
    recordExecutionTelemetry(toolName, signature, idempotencyKey, normalized, 0, 1, 1, false);
    return normalized;
  }

  const toolDef = getToolByName(toolName);
  const maxAttempts = shouldRetryTool(toolName, toolDef) ? 2 : 1;
  let attempt = 0;
  const execStarted = Date.now();

  while (attempt < maxAttempts) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = timeoutMs === 0
      ? new Promise<ToolResult>(() => undefined)
      : new Promise<ToolResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ success: false, error: 'Tool execution timed out' });
        }, timeoutMs);
      });

    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<ToolResult>((resolve) => {
      if (!signal) return;
      abortHandler = () => resolve({ success: false, error: 'Tool execution cancelled' });
      signal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
      const result = await Promise.race([
        handler(args),
        timeoutPromise,
        ...(signal ? [abortPromise] : [])
      ]);

      const normalized = normalizeToolResult(toolName, result, {
        idempotencyKey,
        signature,
        attempt: attempt + 1,
        maxAttempts,
      });
      recordExecutionTelemetry(toolName, signature, idempotencyKey, normalized, Date.now() - execStarted, attempt + 1, maxAttempts, false);
      if (normalized.success || !shouldRetryResult(toolName, toolDef, normalized, attempt, maxAttempts)) {
        return normalized;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const normalized = normalizeToolResult(toolName, { success: false, error: message }, {
        idempotencyKey,
        signature,
        attempt: attempt + 1,
        maxAttempts,
      });
      recordExecutionTelemetry(toolName, signature, idempotencyKey, normalized, Date.now() - execStarted, attempt + 1, maxAttempts, false);
      if (!shouldRetryResult(toolName, toolDef, normalized, attempt, maxAttempts)) {
        return normalized;
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }

    attempt++;
    await delay(200 * attempt);
  }

  const finalFailure = normalizeToolResult(toolName, { success: false, error: 'Tool execution failed' }, {
    idempotencyKey,
    signature,
    attempt: maxAttempts,
    maxAttempts,
  });
  recordExecutionTelemetry(toolName, signature, idempotencyKey, finalFailure, Date.now() - execStarted, maxAttempts, maxAttempts, false);
  return finalFailure;
}

function normalizeToolResult(
  toolName: string,
  result: ToolResult,
  context: {
    idempotencyKey?: string;
    signature: string;
    attempt: number;
    maxAttempts: number;
  }
): CanonicalToolResult {
  const baseOutput = typeof result.output === 'string'
    ? result.output
    : result.output == null
      ? ''
      : JSON.stringify(result.output, null, 2);

  const baseError = typeof result.error === 'string'
    ? result.error
    : result.error == null
      ? ''
      : String(result.error);

  const success = Boolean(result.success);
  const error = success
    ? (baseError || '')
    : (baseError || baseOutput || 'Tool execution failed');
  const output = baseOutput || (success ? '[ok]' : '');
  const code = success ? 'OK' : mapErrorCode(error);
  const retryable = success ? false : isRetryableError(error);

  return {
    success,
    output,
    error,
    data: result.data ?? null,
    meta: {
      ...(result.meta ?? {}),
      idempotencyKey: context.idempotencyKey,
      signature: context.signature,
      attempts: context.attempt,
      maxAttempts: context.maxAttempts,
    },
    tool: toolName,
    code,
    retryable,
    timestamp: Date.now(),
    truncated: result.truncated,
  };
}

function mapErrorCode(error?: string): string {
  const message = (error ?? '').toLowerCase();
  if (!message) return 'ERROR';
  if (message.includes('timed out')) return 'TIMEOUT';
  if (message.includes('cancelled')) return 'CANCELLED';
  if (message.includes('no handler') || message.includes('unknown tool')) return 'TOOL_NOT_FOUND';
  if (message.includes('missing')) return 'MISSING_PARAM';
  if (message.includes('outside workspace')) return 'PATH_OUTSIDE_WORKSPACE';
  if (message.includes('not found')) return 'NOT_FOUND';
  if (message.includes('permission') || message.includes('denied')) return 'PERMISSION_DENIED';
  if (message.includes('invalid line range') || message.includes('exceeds file length')) return 'INVALID_RANGE';
  if (message.includes('syntax')) return 'SYNTAX_ERROR';
  return 'ERROR';
}

function isRetryableError(error?: string): boolean {
  const message = (error ?? '').toLowerCase();
  if (!message) return false;
  if (message.includes('timed out')) return true;
  if (message.includes('temporarily') || message.includes('transient')) return true;
  if (message.includes('network') || message.includes('econn') || message.includes('connection')) return true;
  return false;
}

function shouldRetryTool(toolName: string, toolDef: ReturnType<typeof getToolByName>): boolean {
  if (toolName.startsWith('lsp_')) return false;
  const category = toolDef?.category;
  return category === 'workspace_read' ||
    category === 'workspace_search' ||
    category === 'diagnostics' ||
    category === 'editor_context' ||
    category === 'browser';
}

function shouldRetryResult(
  toolName: string,
  toolDef: ReturnType<typeof getToolByName>,
  result: CanonicalToolResult,
  attempt: number,
  maxAttempts: number
): boolean {
  if (attempt >= maxAttempts - 1) return false;
  if (!shouldRetryTool(toolName, toolDef)) return false;
  if (!result.retryable) return false;
  return true;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function createToolSignature(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${stableStringify(args)}`;
}

function purgeExpiredIdempotencyCache(): void {
  const now = Date.now();
  for (const [key, entry] of idempotentResultCache) {
    if (entry.expiresAt <= now) {
      idempotentResultCache.delete(key);
    }
  }
}

function recordExecutionTelemetry(
  toolName: string,
  signature: string,
  idempotencyKey: string | undefined,
  result: CanonicalToolResult,
  durationMs: number,
  attempt: number,
  maxAttempts: number,
  replayed: boolean
): void {
  toolObservabilityStore.record({
    timestamp: Date.now(),
    toolName,
    signature,
    idempotencyKey,
    durationMs,
    success: result.success,
    code: result.code,
    retryable: result.retryable,
    attempt,
    maxAttempts,
    replayed,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format tool call for display (used in UI)
 */
export function formatToolCallForDisplay(toolCall: { name: string; arguments: Record<string, unknown> }): string {
  const args = { ...toolCall.arguments };
  delete args.meta; // Don't show meta in display

  const argStr = Object.entries(args)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => {
      const val = typeof v === 'string' && v.length > 50
        ? v.slice(0, 50) + '...'
        : JSON.stringify(v);
      return `${k}=${val}`;
    })
    .join(', ');

  return `${toolCall.name}(${argStr})`;
}
