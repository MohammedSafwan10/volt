/**
 * AI Tool Definitions
 *
 * Design: Each tool does ONE distinct thing. No overlap between tools.
 * 16 core tools + browser tools (gated behind CDP connection).
 */

import type { ToolDefinition } from '$core/ai/types';
import { getMcpToolDefinitions } from '$core/ai/tools/handlers/mcp';

export type ToolCategory =
  | 'workspace_read'
  | 'workspace_search'
  | 'file_write'
  | 'terminal'
  | 'diagnostics'
  | 'browser';

export interface VoltToolDefinition extends ToolDefinition {
  category: ToolCategory;
  requiresApproval: boolean;
  allowedModes: ('ask' | 'plan' | 'agent')[];
}

// Browser tools are only exposed when CDP devtools connection is active.
let browserToolsEnabled = false;

export function setBrowserToolsEnabled(enabled: boolean): void {
  browserToolsEnabled = enabled;
}

export const TOOL_DEFINITIONS: VoltToolDefinition[] = [
  // ── READ ──────────────────────────────────────
  {
    name: 'list_dir',
    description: 'List files and subdirectories in a directory. Returns names, types, and sizes. Use for path discovery before reading files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root, e.g. "src" or "."' }
      },
      required: ['path']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'read_file',
    description: 'Read file contents. Use offset/limit for large files. Prefer focused reads when exact evidence is needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        offset: { type: 'number', description: 'Start line, 0-based (default: 0)' },
        limit: { type: 'number', description: 'Number of lines to read (default: full file, max: 2000)' },
        explanation: { type: 'string', description: 'Why you are reading this file (optional, helps with focused extraction)' }
      },
      required: ['path']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'file_outline',
    description: 'Get file structure (functions, classes, types with line ranges) without loading content. ~100x more token-efficient than read_file for understanding file layout.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' }
      },
      required: ['path']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },

  // ── SEARCH ────────────────────────────────────
  {
    name: 'workspace_search',
    description: 'Search file contents with ripgrep-backed workspace search. Defaults to literal text search; set isRegex: true only for explicit regex patterns. Preserves the requested scope exactly and only allows one safe case-insensitive retry when explicitly needed.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text. Literal by default unless isRegex is true.' },
        isRegex: { type: 'boolean', description: 'Interpret query as regex (default: false)' },
        includePattern: { type: 'string', description: 'Glob filter, e.g. "**/*.ts" or "src/**"' },
        includeHidden: { type: 'boolean', description: 'Include hidden files and directories such as .git or .next (default: false)' },
        caseSensitive: { type: 'boolean', description: 'Case sensitive search (default: false)' },
        explanation: { type: 'string', description: 'Why you are searching (optional)' }
      },
      required: ['query']
    },
    category: 'workspace_search',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'find_files',
    description: 'Find files by filename or path fragment using the backend search path. Use when you know the filename but not its location. Results should come from the backend search engine, not a hidden frontend fallback.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'File name or path fragment to search for' },
        includePattern: { type: 'string', description: 'Optional glob filter, e.g. "**/*.ts"' },
        excludePattern: { type: 'string', description: 'Optional glob exclude filter' },
        includeHidden: { type: 'boolean', description: 'Include hidden files (default: false)' }
      },
      required: ['query']
    },
    category: 'workspace_search',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },

  // ── WRITE ─────────────────────────────────────
  {
    name: 'write_file',
    description: 'Create a new file or overwrite an existing file entirely. Omit text to create an empty file. For editing existing files, prefer str_replace or apply_patch.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        text: { type: 'string', description: 'Complete file contents. Optional for empty-file creation.' },
        force: { type: 'boolean', description: 'Force overwrite even if content appears identical' }
      },
      required: ['path']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'str_replace',
    description: `Find and replace exact text in a file. oldStr must match EXACTLY including whitespace.
To delete code: set newStr to empty string.
If match fails: use read_file to verify the exact content first.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        oldStr: { type: 'string', description: 'Exact text to find (must match exactly)' },
        newStr: { type: 'string', description: 'Replacement text' },
        force: { type: 'boolean', description: 'Force even if content appears identical' }
      },
      required: ['path', 'oldStr', 'newStr']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'apply_patch',
    description: `Apply a Codex patch atomically. Supports multiple hunks for complex edits.
Format: *** Begin Patch ... *** End Patch
Re-read the file first if the previous patch failed or content may be stale.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        patch: { type: 'string', description: 'Codex patch with diff hunks' },
        expected_version: { type: 'number', description: 'Optimistic version guard (optional)' },
        postEditDiagnostics: { type: 'boolean', description: 'Run diagnostics after patch (default: true)' }
      },
      required: ['path', 'patch']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'create_dir',
    description: 'Create a directory (and parent directories if needed).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to create' }
      },
      required: ['path']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory. Requires user approval. Deletion is permanent.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete (relative to workspace root)' },
        explanation: { type: 'string', description: 'Why this file is being deleted' }
      },
      required: ['path', 'explanation']
    },
    category: 'file_write',
    requiresApproval: true,
    allowedModes: ['agent']
  },

  // ── TERMINAL ──────────────────────────────────
  {
    name: 'run_command',
    description: `Execute a shell command and wait for completion. Use for short-running tasks: install, build, git, test.
For long-running processes (dev servers, watchers), use start_process instead.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to workspace root)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 60000)' }
      },
      required: ['command']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'start_process',
    description: `Start a long-running background process (dev servers, watchers).
Returns a processId. Use get_process_output to read its output afterward.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run in background' },
        cwd: { type: 'string', description: 'Working directory (optional)' }
      },
      required: ['command']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'get_process_output',
    description: 'Read output from a background process. Returns recent output lines and detected localhost URL if present.',
    parameters: {
      type: 'object',
      properties: {
        processId: { type: 'number', description: 'Process ID returned by start_process' },
        maxLines: { type: 'number', description: 'Lines to return (default: 100)' }
      },
      required: ['processId']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },

  // ── DIAGNOSTICS ───────────────────────────────
  {
    name: 'get_diagnostics',
    description: 'Get compiler/LSP errors and warnings. Use after edits to verify correctness. Diagnostics are the source of truth.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to check (optional, checks all if omitted)'
        }
      }
    },
    category: 'diagnostics',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'attempt_completion',
    description: 'Signal that the task is complete. Include a result summary. Only call after edits and diagnostics are verified.',
    parameters: {
      type: 'object',
      properties: {
        result: { type: 'string', description: 'Summary of what was accomplished' },
        summary: { type: 'string', description: 'Short metadata summary (optional)' }
      },
      required: ['result']
    },
    category: 'diagnostics',
    requiresApproval: false,
    allowedModes: ['agent']
  },

  // ── BROWSER (only exposed when CDP devtools are connected) ──
  {
    name: 'browser_get_console_logs',
    description: 'Get console logs from the browser. Filter by level (log/warn/error/info/debug) or time.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max logs to return (default: 50)' },
        level: { type: 'string', description: 'Filter by level: log, info, warn, error, debug' },
        since_minutes: { type: 'number', description: 'Only logs from last N minutes' }
      }
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'browser_get_errors',
    description: 'Get JavaScript errors from the browser including stack traces.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max errors to return (default: 20)' },
        include_console_errors: { type: 'boolean', description: 'Include console.error logs (default: true)' }
      }
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'browser_get_network_requests',
    description: 'Get network requests from the browser. Filter by method, status, or URL.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max requests to return (default: 50)' },
        method: { type: 'string', description: 'Filter by HTTP method (GET, POST, etc.)' },
        status: { type: 'number', description: 'Filter by status code' },
        failed_only: { type: 'boolean', description: 'Only show failed requests' },
        url_contains: { type: 'string', description: 'Filter by URL substring' }
      }
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' }
      },
      required: ['url']
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'browser_click',
    description: 'Click an element in the browser by CSS selector.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to click' }
      },
      required: ['selector']
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'browser_type',
    description: 'Type text into an input element in the browser.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of input element (optional - types into focused element if omitted)' },
        text: { type: 'string', description: 'Text to type' }
      },
      required: ['text']
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the page or a specific element.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to screenshot (optional - full page if omitted)' },
        full_page: { type: 'boolean', description: 'Capture full scrollable page (default: false)' }
      }
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the browser and return the result.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate' }
      },
      required: ['expression']
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page to an element or by pixel amount.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to scroll to (optional)' },
        x: { type: 'number', description: 'Pixels to scroll horizontally (optional)' },
        y: { type: 'number', description: 'Pixels to scroll vertically (optional)' }
      }
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for an element to appear on the page.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout_ms: { type: 'number', description: 'Max wait time in ms (default: 5000)' }
      },
      required: ['selector']
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'browser_get_element',
    description: 'Get detailed info about elements matching a CSS selector (tag, id, classes, text, dimensions).',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        limit: { type: 'number', description: 'Max elements to return (default: 10)' }
      },
      required: ['selector']
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
];

// ── Helper Functions ────────────────────────────

/**
 * Get tools available for the given mode.
 * All non-browser tools are always available (filtered by mode).
 * Browser tools are only available when CDP devtools are connected.
 */
export function getToolsForMode(mode: 'ask' | 'plan' | 'agent'): ToolDefinition[] {
  return TOOL_DEFINITIONS
    .filter(tool => tool.allowedModes.includes(mode))
    .filter(tool => tool.category !== 'browser' || browserToolsEnabled)
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function getToolByName(name: string): VoltToolDefinition | undefined {
  return TOOL_DEFINITIONS.find(tool => tool.name === name);
}

export function doesToolRequireApproval(toolName: string): boolean {
  return getToolByName(toolName)?.requiresApproval ?? false;
}

export function isToolAllowed(toolName: string, mode: 'ask' | 'plan' | 'agent'): boolean {
  return getToolByName(toolName)?.allowedModes.includes(mode) ?? false;
}

export function getAllToolsForMode(mode: 'ask' | 'plan' | 'agent'): ToolDefinition[] {
  const builtInTools = getToolsForMode(mode);
  const mcpTools = mode === 'agent' ? getMcpToolDefinitions() : [];
  return [...builtInTools, ...mcpTools];
}

/**
 * Strict canonical tools — the minimal reliable set.
 * Used as a fallback profile when extended tools should be disabled.
 */
export const STRICT_CANONICAL_TOOL_NAMES = new Set<string>([
  'list_dir',
  'read_file',
  'workspace_search',
  'apply_patch',
  'run_command',
  'get_diagnostics',
  'attempt_completion',
]);

/**
 * Names of tools that have been removed but may still be referenced
 * by cached conversations or old model outputs. The router uses this
 * to return a helpful error instead of "unknown tool".
 *
 * IMPORTANT: Do NOT add currently active tool names here.
 */
export const RETIRED_TOOL_NAMES = new Set<string>([
  // Removed read tools (use read_file or file_outline instead)
  'read_files',
  'get_file_tree',
  'read_code',

  // Removed editor context tools (info now in system prompt)
  'get_active_file',
  'get_selection',
  'get_open_files',

  // Removed write tools (use write_file, str_replace, or apply_patch)
  'append_file',
  'replace_lines',
  'multi_replace',
  'rename_path',
  'format_file',
  'write_plan_file',

  // Removed terminal tools (use run_command, start_process, get_process_output)
  'stop_process',
  'list_processes',
  'command_status',
  'read_terminal',
  'send_terminal_input',

  // Removed diagnostics (moved to internal dashboard or redundant)
  'get_tool_metrics',
  'get_file_info',

  // Removed browser tools (consolidated)
  'browser_get_network_request_details',
  'browser_get_performance',
  'browser_get_selected_element',
  'browser_get_summary',
  'browser_get_application_storage',
  'browser_get_security_report',
  'browser_propose_action',
  'browser_preview_action',
  'browser_execute_action',
  'browser_get_elements',

  // Legacy names from very old versions
  'grep_files',
  'view_image',
  'update_plan',
  'request_user_input',
  'spawn_agent',
  'send_input',
  'resume_agent',
  'wait',
  'close_agent',
]);
