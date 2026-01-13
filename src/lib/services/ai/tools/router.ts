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

  // Handle MCP tools
  if (isMcpTool(toolName)) {
    return executeMcpTool(toolName, args);
  }

  // Get timeout from args or use default
  const requestedTimeout = typeof args.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(0, requestedTimeout), MAX_TIMEOUT_MS);

  // Get handler
  const handler = toolHandlers[toolName];
  if (!handler) {
    return { success: false, error: `No handler for tool: ${toolName}` };
  }

  // Create timeout promise
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ToolResult>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ success: false, error: 'Tool execution timed out' });
    }, timeoutMs);
  });

  // Create abort promise
  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<ToolResult>((resolve) => {
    if (!signal) return;
    abortHandler = () => resolve({ success: false, error: 'Tool execution cancelled' });
    signal.addEventListener('abort', abortHandler, { once: true });
  });

  try {
    // Execute with timeout and abort handling
    const result = await Promise.race([
      handler(args),
      timeoutPromise,
      ...(signal ? [abortPromise] : [])
    ]);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
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
