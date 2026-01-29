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
import { validatePathInWorkspace, type ToolResult } from './utils';
import { toolHandlers } from './handlers';
import { isMcpTool, executeMcpTool, isMcpToolAutoApproved, getMcpToolInfo } from './handlers/mcp';
import type { AIMode } from '$lib/stores/ai.svelte';

// Timeout for tool operations (30 seconds default)
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max

/**
 * Tool execution options
 */
export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

/**
 * Tool validation result
 */
export interface ToolValidation {
  valid: boolean;
  error?: string;
  requiresApproval: boolean;
}

// Re-export ToolResult for convenience
export type { ToolResult } from './utils';

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
  if (args.path && typeof args.path === 'string' && workspaceRoot) {
    const pathValidation = validatePathInWorkspace(args.path, workspaceRoot);
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error, requiresApproval: false };
    }
  }

  return { 
    valid: true, 
    requiresApproval: tool.requiresApproval 
  };
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
    
    // Terminal tools
    case 'run_command':
    case 'start_process':
      return requireString('command');
    
    case 'stop_process':
    case 'get_process_output':
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
): Promise<ToolResult> {
  const { signal } = options;

  if (isMcpTool(toolName)) {
    const result = await executeMcpTool(toolName, args);
    return normalizeToolResult(toolName, result);
  }

  const requestedTimeout = typeof args.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(0, requestedTimeout), MAX_TIMEOUT_MS);

  const handler = toolHandlers[toolName];
  if (!handler) {
    return normalizeToolResult(toolName, { success: false, error: `No handler for tool: ${toolName}` });
  }

  const toolDef = getToolByName(toolName);
  const maxAttempts = shouldRetryTool(toolDef) ? 2 : 1;
  let attempt = 0;

  while (attempt < maxAttempts) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ToolResult>((resolve) => {
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

      const normalized = normalizeToolResult(toolName, result);
      if (normalized.success || !shouldRetryResult(toolDef, normalized, attempt, maxAttempts)) {
        return normalized;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const normalized = normalizeToolResult(toolName, { success: false, error: message });
      if (!shouldRetryResult(toolDef, normalized, attempt, maxAttempts)) {
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

  return normalizeToolResult(toolName, { success: false, error: 'Tool execution failed' });
}

function normalizeToolResult(toolName: string, result: ToolResult): ToolResult {
  const normalized: ToolResult = { ...result };
  normalized.tool = toolName;
  normalized.timestamp = Date.now();

  if (!normalized.success) {
    if (!normalized.error && typeof normalized.output === 'string') {
      normalized.error = normalized.output;
    }
    normalized.code = mapErrorCode(normalized.error);
    normalized.retryable = isRetryableError(normalized.error);
  } else {
    normalized.code = 'OK';
    normalized.retryable = false;
  }

  return normalized;
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

function shouldRetryTool(toolDef: ReturnType<typeof getToolByName>): boolean {
  const category = toolDef?.category;
  return category === 'workspace_read' ||
    category === 'workspace_search' ||
    category === 'diagnostics' ||
    category === 'editor_context' ||
    category === 'browser';
}

function shouldRetryResult(
  toolDef: ReturnType<typeof getToolByName>,
  result: ToolResult,
  attempt: number,
  maxAttempts: number
): boolean {
  if (attempt >= maxAttempts - 1) return false;
  if (!shouldRetryTool(toolDef)) return false;
  if (!result.retryable) return false;
  return true;
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
