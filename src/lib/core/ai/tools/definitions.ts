/**
 * AI Tool Definitions
 *
 * Design: Each tool does ONE distinct thing. No overlap between tools.
 */

import type { ToolDefinition } from '$core/ai/types';
import type { AIMode } from '$features/assistant/stores/ai.svelte';
import { getMcpToolDefinitions } from '$core/ai/tools/handlers/mcp';

export type ToolCategory =
  | 'workspace_read'
  | 'workspace_search'
  | 'file_write'
  | 'terminal'
  | 'diagnostics'
  | 'workflow';

export interface VoltToolDefinition extends ToolDefinition {
  category: ToolCategory;
  requiresApproval: boolean;
  allowedModes: AIMode[];
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
    allowedModes: ['ask', 'plan', 'spec', 'agent']
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
    allowedModes: ['ask', 'plan', 'spec', 'agent']
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
    allowedModes: ['ask', 'plan', 'spec', 'agent']
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
    allowedModes: ['ask', 'plan', 'spec', 'agent']
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
    allowedModes: ['ask', 'plan', 'spec', 'agent']
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
    name: 'run_in_terminal',
    description: `Execute a command in a terminal session. Supports two modes:
- mode "sync" (default): Waits for completion and returns output + exit code. Use for bounded tasks (install, build, git, test).
- mode "async": Starts the command and returns a terminal ID immediately. Use for long-running processes (dev servers, watchers) or interactive commands.
After async execution, use get_terminal_output to read output, send_to_terminal to provide input, or kill_terminal to stop.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to workspace root)' },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'Execution mode (default: sync)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 90000 sync, 30000 async)' }
      },
      required: ['command']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'get_terminal_output',
    description: 'Read output from a persistent terminal session started with run_in_terminal in async mode. Returns recent output lines, detected URL, and any waiting-for-input indicators.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal ID returned by run_in_terminal in async mode' },
        maxLines: { type: 'number', description: 'Max output lines to return (default: 200)' }
      },
      required: ['id']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'send_to_terminal',
    description: 'Send input text to a persistent terminal session. Use to answer interactive prompts (Y/n, selections, passwords) or send follow-up commands. Text is sent followed by Enter.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal ID returned by run_in_terminal in async mode' },
        input: { type: 'string', description: 'Text to send to the terminal (followed by Enter)' }
      },
      required: ['id', 'input']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'kill_terminal',
    description: 'Kill a persistent terminal session by ID. Use to clean up terminals when done (e.g. after stopping a server). Returns final output before termination.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal ID returned by run_in_terminal in async mode' }
      },
      required: ['id']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  // Backward compat alias — models trained on the old surface can still call run_command
  {
    name: 'run_command',
    description: `[Alias for run_in_terminal mode=sync] Execute a shell command and wait for completion. Prefer run_in_terminal for new usage.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to workspace root)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 90000)' }
      },
      required: ['command']
    },
    category: 'terminal',
    requiresApproval: true,
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
    allowedModes: ['ask', 'plan', 'spec', 'agent']
  },
  {
    name: 'get_spec_state',
    description: 'Get the current Spec Mode workspace state: active spec, current phase, pending draft, and task summary. Use before deciding whether to ask questions, draft requirements, update a phase, or start a task.',
    parameters: {
      type: 'object',
      properties: {}
    },
    category: 'workflow',
    requiresApproval: false,
    allowedModes: ['spec']
  },
  {
    name: 'stage_spec_requirements',
    description: 'Stage the first requirements draft for user confirmation without writing files yet. Use this after clarifying enough detail for a real feature spec.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable spec title' },
        slug: { type: 'string', description: 'Slug for the spec folder under .volt/specs' },
        requirementsMarkdown: { type: 'string', description: 'Requirements markdown with stable ids like REQ-1, REQ-2' }
      },
      required: ['title', 'slug', 'requirementsMarkdown']
    },
    category: 'workflow',
    requiresApproval: false,
    allowedModes: ['spec']
  },
  {
    name: 'write_spec_phase',
    description: 'Create or update a spec phase in .volt/specs. Use for confirmed requirements creation, design generation, or task-list updates.',
    parameters: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['requirements', 'design', 'tasks'], description: 'Spec phase to write' },
        title: { type: 'string', description: 'Spec title. Required when creating a new requirements phase.' },
        slug: { type: 'string', description: 'Spec slug. Required when creating a new requirements phase without an active spec.' },
        requirementsMarkdown: { type: 'string', description: 'Requirements markdown for the requirements phase' },
        designMarkdown: { type: 'string', description: 'Design markdown for the design phase' },
        tasks: {
          type: 'array',
          description: 'Task definitions for the tasks phase',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              summary: { type: 'string' },
              requirementIds: { type: 'array', items: { type: 'string' } },
              dependencyIds: { type: 'array', items: { type: 'string' } },
              scopeHints: { type: 'array', items: { type: 'string' } },
              verification: { type: 'string' }
            }
          }
        }
      },
      required: ['phase']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['spec']
  },
];

// ── Helper Functions ────────────────────────────

/**
 * Get tools available for the given mode.
 */
export function getToolsForMode(mode: AIMode): ToolDefinition[] {
  return TOOL_DEFINITIONS
    .filter(tool => tool.allowedModes.includes(mode))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function getToolByName(name: string): VoltToolDefinition | undefined {
  return TOOL_DEFINITIONS.find(tool => tool.name === name);
}

export function doesToolRequireApproval(toolName: string): boolean {
  return getToolByName(toolName)?.requiresApproval ?? false;
}

export function isToolAllowed(toolName: string, mode: AIMode): boolean {
  return getToolByName(toolName)?.allowedModes.includes(mode) ?? false;
}

export function getAllToolsForMode(mode: AIMode): ToolDefinition[] {
  const builtInTools = getToolsForMode(mode);
  const mcpTools = mode === 'agent' || mode === 'spec' ? getMcpToolDefinitions() : [];
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
  'run_in_terminal',
  'run_command',
  'get_diagnostics',
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

  // Removed terminal tools (use run_in_terminal, get_terminal_output, send_to_terminal, kill_terminal)
  'start_process',
  'get_process_output',
  'stop_process',
  'list_processes',
  'command_status',
  'read_terminal',
  'send_terminal_input',

  // Removed diagnostics (moved to internal dashboard or redundant)
  'get_tool_metrics',
  'get_file_info',
  'attempt_completion',

  // Removed browser tools
  'browser_get_console_logs',
  'browser_get_errors',
  'browser_get_network_requests',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_evaluate',
  'browser_scroll',
  'browser_wait_for',
  'browser_get_element',
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
