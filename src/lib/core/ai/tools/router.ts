/**
 * AI Tool Router
 * 
 * Clean architecture:
 * - router.ts: validation + dispatch (this file)
 * - definitions.ts: tool schemas
 * - utils.ts: shared helpers
 * - handlers/: individual tool implementations
 */

import { projectStore } from '$shared/stores/project.svelte';
import { assistantStore } from '$features/assistant/stores/assistant.svelte';
import {
  getAllToolsForMode,
  getToolByName,
  isToolAllowed,
  RETIRED_TOOL_NAMES,
} from '$core/ai/tools/definitions';
import {
  normalizeToolOutputBudget,
  validatePathInWorkspace,
  type ToolResult,
  type CanonicalToolResult,
} from '$core/ai/tools/utils';
import { toolHandlers } from '$core/ai/tools/handlers';
import { isMcpTool, executeMcpTool, isMcpToolAutoApproved, getMcpToolInfo } from '$core/ai/tools/handlers/mcp';
import type { AIMode } from '$features/assistant/stores/ai.svelte';
import { getToolCapabilities } from '$core/ai/tools/capabilities';
import { toolObservabilityStore } from '$features/assistant/stores/tool-observability.svelte';
import { agentTelemetryStore } from '$features/assistant/stores/agent-telemetry.svelte';
import { afterToolHook, beforeToolHook } from '$core/ai/tools/hooks';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';

// Timeout for tool operations (30 seconds default)
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max
const TERMINAL_TOOL_DEFAULT_TIMEOUT_MS = MAX_TIMEOUT_MS;
const HIDDEN_HANDLER_NAMES = new Set([
  'lsp_go_to_definition',
  'lsp_find_references',
  'lsp_get_hover',
  'lsp_rename_symbol',
]);
const TOOL_MAX_ATTEMPTS: Record<string, number> = {};
const TOOL_NAME_ALIASES: Record<string, string> = {
  shell_command: 'run_command',
};

export function normalizeToolName(toolName: string): string {
  const trimmed = toolName.trim();
  return TOOL_NAME_ALIASES[trimmed] ?? trimmed;
}

/**
 * Tool execution options
 */
export interface ToolExecutionOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  runtime?: ToolRuntimeContext;
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
export type { ToolResult, CanonicalToolResult } from '$core/ai/tools/utils';

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
  const canonicalToolName = normalizeToolName(toolName);
  // Check if it's an MCP tool
  if (isMcpTool(canonicalToolName)) {
    // MCP tools are allowed in agent and spec mode only
    if (mode !== 'agent' && mode !== 'spec') {
      return {
        valid: false,
        error: `MCP tools are only available in agent or spec mode`,
        requiresApproval: false
      };
    }

    // Check if auto-approved
    const requiresApproval = !isMcpToolAutoApproved(canonicalToolName);
    return { valid: true, requiresApproval };
  }

  // Check if tool exists
  const tool = getToolByName(canonicalToolName);
  if (!tool) {
    if (RETIRED_TOOL_NAMES.has(canonicalToolName)) {
      return {
        valid: false,
        error: `Tool "${canonicalToolName}" was removed from strict profile. Use read_file/workspace_search/apply_patch/run_command equivalents.`,
        requiresApproval: false,
      };
    }
    const suggestion = suggestToolName(canonicalToolName, mode);
    const suffix = suggestion ? ` Did you mean "${suggestion}"?` : '';
    return { valid: false, error: `Unknown tool: ${canonicalToolName}.${suffix}`, requiresApproval: false };
  }
  // If tool is in definitions, proceed to mode/param checks

  // Check if tool is allowed in current mode
  if (!isToolAllowed(canonicalToolName, mode)) {
    return {
      valid: false,
      error: `Tool "${canonicalToolName}" not allowed in ${mode} mode`,
      requiresApproval: false
    };
  }

  // Validate required parameters
  const paramError = validateRequiredParams(canonicalToolName, args);
  if (paramError) {
    return { valid: false, error: paramError, requiresApproval: false };
  }
  if (
    canonicalToolName === 'read_file' &&
    (typeof args.start_line === 'number' ||
      typeof args.end_line === 'number' ||
      typeof args.startLine === 'number' ||
      typeof args.endLine === 'number')
  ) {
    return {
      valid: false,
      error: 'read_file now requires Codex-style slice args: use "offset" and "limit" (line-based).',
      requiresApproval: false,
    };
  }

  // Validate path is within workspace (if path param exists)
  const workspaceRoot = projectStore.rootPath;
  const capabilities = getToolCapabilities(canonicalToolName);
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

  switch (toolName) {
    // Read tools
    case 'list_dir':
    case 'read_file':
    case 'get_file_info':
      return requireString('path');

    case 'workspace_search':
      return requireString('query');

    // Write tools
    case 'apply_patch': {
      const pathErr = requireString('path');
      if (pathErr) return pathErr;
      return requireString('patch');
    }

    // Terminal tools
    case 'run_command':
      return requireString('command');

    // Browser tools - read-only
    // No required params
    case 'get_diagnostics':
      return null;

    case 'attempt_completion':
      return requireString('result');

    default:
      return validateRequiredParamsFromSchema(toolName, args);
  }
}

function validateRequiredParamsFromSchema(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const tool = getToolByName(toolName);
  if (!tool) return null;

  const schema = tool.parameters as Record<string, unknown>;
  const required = schema.required;
  if (!Array.isArray(required) || required.length === 0) return null;

  for (const key of required) {
    if (typeof key !== 'string') continue;
    const value = args[key];
    const missingString = typeof value === 'string' && value.trim().length === 0;
    if (value === undefined || value === null || missingString) {
      return `Missing "${key}"`;
    }
  }

  return null;
}

export function getToolContractParity(): {
  missingHandlers: string[];
  orphanHandlers: string[];
} {
  const definedTools = new Set([
    ...getAllToolsForMode('ask').map((tool) => tool.name),
    ...getAllToolsForMode('plan').map((tool) => tool.name),
    ...getAllToolsForMode('spec').map((tool) => tool.name),
    ...getAllToolsForMode('agent').map((tool) => tool.name),
  ]);
  const handlerTools = new Set(Object.keys(toolHandlers));

  const missingHandlers = [...definedTools]
    .filter((name) => !handlerTools.has(name) && !isMcpTool(name))
    .sort();

  const orphanHandlers = [...handlerTools]
    .filter(
      (name) =>
        !definedTools.has(name) &&
        !getToolByName(name) &&
        !HIDDEN_HANDLER_NAMES.has(name) &&
        !RETIRED_TOOL_NAMES.has(name) &&
        !isMcpTool(name),
    )
    .sort();

  return { missingHandlers, orphanHandlers };
}

function normalizeToolToken(value: string): string {
  return value.toLowerCase().replace(/[-_\s]+/g, '');
}

function suggestToolName(toolName: string, mode: AIMode): string | null {
  const available = getAllToolsForMode(mode).map((tool) => tool.name);
  if (available.length === 0) return null;

  const normalized = normalizeToolToken(toolName);
  const exactNormalized = available.find((name) => normalizeToolToken(name) === normalized);
  if (exactNormalized) return exactNormalized;

  const prefixMatch = available.find((name) => name.startsWith(toolName) || toolName.startsWith(name));
  if (prefixMatch) return prefixMatch;

  let best: { name: string; distance: number } | null = null;
  for (const candidate of available) {
    const distance = levenshteinDistance(normalizeToolToken(candidate), normalized);
    if (!best || distance < best.distance) {
      best = { name: candidate, distance };
    }
  }

  if (!best) return null;
  return best.distance <= 6 ? best.name : null;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

/**
 * Execute a tool call
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolExecutionOptions = {}
): Promise<CanonicalToolResult> {
  const canonicalToolName = normalizeToolName(toolName);
  const { signal, idempotencyKey } = options;
  const signature = createToolSignature(canonicalToolName, args);

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
        toolName: canonicalToolName,
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
        toolName: canonicalToolName,
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

  const executionPromise = executeToolCallInternal(canonicalToolName, args, {
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
  const { signal, idempotencyKey, signature, runtime } = options;
  if (RETIRED_TOOL_NAMES.has(toolName)) {
    return normalizeToolResult(
      toolName,
      {
        success: false,
        error: `Tool "${toolName}" was removed from strict profile. Use read_file/workspace_search/apply_patch/run_command equivalents.`,
      },
      {
        idempotencyKey,
        signature,
        attempt: 1,
        maxAttempts: 1,
      },
    );
  }

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
  const maxAttempts = getToolMaxAttempts(toolName, toolDef);
  let attempt = 0;
  const execStarted = Date.now();

  while (attempt < maxAttempts) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const effectiveTimeout = timeoutMs === 0 ? MAX_TIMEOUT_MS : timeoutMs;
    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ success: false, error: 'Tool execution timed out' });
      }, effectiveTimeout);
    });

    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<ToolResult>((resolve) => {
      if (!signal) return;
      abortHandler = () => resolve({ success: false, error: 'Tool execution cancelled' });
      signal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
      beforeToolHook({
        toolName,
        args,
        attempt: attempt + 1,
        maxAttempts,
        startedAt: execStarted,
      });
      const result = await Promise.race([
        handler(args, runtime),
        timeoutPromise,
        ...(signal ? [abortPromise] : [])
      ]);

      const normalized = normalizeToolResult(toolName, result, {
        idempotencyKey,
        signature,
        attempt: attempt + 1,
        maxAttempts,
      });
      const hookOutcome = afterToolHook(
        {
          toolName,
          args,
          attempt: attempt + 1,
          maxAttempts,
          startedAt: execStarted,
        },
        normalized,
      );
      agentTelemetryStore.record({
        type: 'agent.tool.hook',
        timestamp: Date.now(),
        toolName,
        parseCategory: hookOutcome.parseCategory ?? 'none',
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
  const budgeted = normalizeToolOutputBudget(toolName, output);
  const code = success ? 'OK' : mapErrorCode(error);
  const retryable = success ? false : isRetryableError(error);
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    success,
    output: budgeted.output,
    error,
    data: result.data ?? null,
    warnings,
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
    truncated: result.truncated || budgeted.truncated,
  };
}

function mapErrorCode(error?: string): string {
  const message = (error ?? '').toLowerCase();
  if (!message) return 'ERROR';
  if (message.includes('completion blocked by diagnostics')) return 'COMPLETION_BLOCKED_BY_DIAGNOSTICS';
  if (message.includes('retry exhausted')) return 'EDIT_RETRY_EXHAUSTED';
  if (message.includes('content changed on disk')) return 'EDIT_STALE_CONTENT';
  if (message.includes('timed out')) return 'TIMEOUT';
  if (message.includes('cancelled')) return 'CANCELLED';
  if (message.includes('no handler') || message.includes('unknown tool')) return 'TOOL_NOT_FOUND';
  if (message.includes('removed from strict profile')) return 'TOOL_DEPRECATED';
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
    category === 'diagnostics';
}

function getToolMaxAttempts(
  toolName: string,
  toolDef: ReturnType<typeof getToolByName>,
): number {
  if (!shouldRetryTool(toolName, toolDef)) return 1;
  const configured = TOOL_MAX_ATTEMPTS[toolName];
  if (typeof configured === 'number' && configured > 0) return configured;
  return 2;
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
  agentTelemetryStore.record({
    type: 'agent.tool.call',
    timestamp: Date.now(),
    toolName,
    success: result.success,
    durationMs,
    code: result.code,
    retryable: result.retryable,
    signature,
  });
  if (!result.success) {
    agentTelemetryStore.record({
      type: 'agent.tool.failure_signature',
      timestamp: Date.now(),
      toolName,
      signature,
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  const parity = getToolContractParity();
  if (parity.missingHandlers.length > 0 || parity.orphanHandlers.length > 0) {
    console.warn('[Tools] Contract parity warning', parity);
  }
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
