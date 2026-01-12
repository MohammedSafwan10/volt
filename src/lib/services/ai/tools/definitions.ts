/**
 * AI Tool Definitions - Kiro-style
 * 
 * Design principles:
 * - Simple, short parameter names
 * - No meta required (optional for audit)
 * - Clear descriptions with examples
 * - Minimal required params
 */

import type { ToolDefinition } from '../types';

export type ToolCategory =
  | 'workspace_read'
  | 'workspace_search'
  | 'editor_context'
  | 'file_write'
  | 'terminal'
  | 'diagnostics';

export interface VoltToolDefinition extends ToolDefinition {
  category: ToolCategory;
  requiresApproval: boolean;
  allowedModes: ('ask' | 'plan' | 'agent')[];
}

export const TOOL_DEFINITIONS: VoltToolDefinition[] = [
  // ============================================
  // READ TOOLS
  // ============================================
  {
    name: 'list_dir',
    description: 'List directory contents. Returns names, types, sizes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, e.g. "src" or "."' }
      },
      required: ['path']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'read_file',
    description: 'Read file contents. Use start_line/end_line for partial reads.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. "src/app.ts"' },
        start_line: { type: 'number', description: 'Start line (1-based)' },
        end_line: { type: 'number', description: 'End line (inclusive)' }
      },
      required: ['path']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'read_files',
    description: 'Read multiple files at once.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'List of file paths' }
      },
      required: ['paths']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'get_file_tree',
    description: 'Get directory tree structure.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root path (default: ".")' },
        depth: { type: 'number', description: 'Max depth (default: 3)' }
      }
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },

  // ============================================
  // SEARCH TOOLS
  // ============================================
  {
    name: 'workspace_search',
    description: 'Search for text/regex in files. Returns matches with 2 lines of context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text or regex' },
        includePattern: { type: 'string', description: 'Glob filter, e.g. "**/*.ts"' },
        caseSensitive: { type: 'boolean', description: 'Case sensitive (default: false)' }
      },
      required: ['query']
    },
    category: 'workspace_search',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'find_files',
    description: 'Find files by name (fuzzy search).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'File name pattern' }
      },
      required: ['query']
    },
    category: 'workspace_search',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },

  // ============================================
  // EDITOR TOOLS
  // ============================================
  {
    name: 'get_active_file',
    description: 'Get currently open file path and content.',
    parameters: { type: 'object', properties: {} },
    category: 'editor_context',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'get_selection',
    description: 'Get selected text in editor.',
    parameters: { type: 'object', properties: {} },
    category: 'editor_context',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'get_open_files',
    description: 'Get list of open tabs.',
    parameters: { type: 'object', properties: {} },
    category: 'editor_context',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },

  // ============================================
  // FILE WRITE TOOLS
  // ============================================
  {
    name: 'write_file',
    description: 'Create or overwrite a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. "src/utils.ts"' },
        text: { type: 'string', description: 'File contents' }
      },
      required: ['path', 'text']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'append_file',
    description: 'Append text to end of existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        text: { type: 'string', description: 'Text to append' }
      },
      required: ['path', 'text']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'str_replace',
    description: `Replace text in a file. oldStr must match EXACTLY.

To delete code: set newStr to ""
If match fails: use read_file to get exact content first.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        oldStr: { type: 'string', description: 'Exact text to find' },
        newStr: { type: 'string', description: 'Replacement text' }
      },
      required: ['path', 'oldStr', 'newStr']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'replace_lines',
    description: `Replace lines in a file by line numbers. Use when str_replace fails or for large edits.

Example: replace_lines(path, 10, 20, "new content") replaces lines 10-20 with new content.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        start_line: { type: 'number', description: 'First line to replace (1-based)' },
        end_line: { type: 'number', description: 'Last line to replace (inclusive)' },
        content: { type: 'string', description: 'New content to insert' }
      },
      required: ['path', 'start_line', 'end_line', 'content']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'create_dir',
    description: 'Create a directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' }
      },
      required: ['path']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory. Requires approval. Use with caution - deletion is permanent.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory path to delete (relative to workspace root)' },
        explanation: { type: 'string', description: 'One sentence explanation of why this file is being deleted and how it contributes to the goal' }
      },
      required: ['path', 'explanation']
    },
    category: 'file_write',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'rename_path',
    description: 'Rename or move a file/directory.',
    parameters: {
      type: 'object',
      properties: {
        oldPath: { type: 'string', description: 'Current path' },
        newPath: { type: 'string', description: 'New path' }
      },
      required: ['oldPath', 'newPath']
    },
    category: 'file_write',
    requiresApproval: true,
    allowedModes: ['agent']
  },

  // ============================================
  // TERMINAL TOOLS
  // ============================================
  {
    name: 'run_command',
    description: `Run a shell command and wait for completion.

IMPORTANT: Do NOT use for long-running commands like dev servers or watchers.
For those, use "start_process" instead.

Examples of commands to run here:
- npm install, npm run build
- git status, git commit
- mkdir, cp, mv, rm
- cargo build, go build`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
        timeout: { type: 'number', description: 'Timeout ms (default: 60000)' }
      },
      required: ['command']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'start_process',
    description: `Start a background process (dev servers, watchers, etc.).
Returns a processId to track the process.

Use this for:
- npm run dev, yarn start, pnpm dev
- webpack --watch, vite
- nodemon, ts-node-dev
- Any long-running command

After starting, use "get_process_output" to check status.`,
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
    name: 'stop_process',
    description: 'Stop a background process by its processId.',
    parameters: {
      type: 'object',
      properties: {
        processId: { type: 'number', description: 'Process ID from start_process' }
      },
      required: ['processId']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'list_processes',
    description: 'List all background processes started by start_process.',
    parameters: {
      type: 'object',
      properties: {}
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'get_process_output',
    description: 'Read output from a background process. Use to check if dev server started successfully or to debug errors.',
    parameters: {
      type: 'object',
      properties: {
        processId: { type: 'number', description: 'Process ID from start_process' },
        maxLines: { type: 'number', description: 'Lines to return (default: 100)' }
      },
      required: ['processId']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'read_terminal',
    description: 'Read recent output from the AI terminal session.',
    parameters: {
      type: 'object',
      properties: {
        maxLines: { type: 'number', description: 'Lines to return (default: 100)' }
      }
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },

  // ============================================
  // DIAGNOSTICS
  // ============================================
  {
    name: 'get_diagnostics',
    description: 'Get errors/warnings from IDE (TypeScript, ESLint, Svelte, etc.).',
    parameters: {
      type: 'object',
      properties: {
        paths: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Files to check, e.g. ["src/app.ts", "src/utils.ts"]' 
        }
      }
    },
    category: 'diagnostics',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  
  // Plan mode tool
  {
    name: 'write_plan_file',
    description: 'Write a plan/spec file to .volt/plans/ directory. Use this to save implementation plans that can be executed later in Agent mode.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Plan filename (without path), e.g. "refactor-auth.md"' },
        content: { type: 'string', description: 'Plan content in markdown format' }
      },
      required: ['filename', 'content']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['plan']
  }
];

// Keep old tool names as aliases for backward compatibility
const TOOL_ALIASES: Record<string, string> = {
  'apply_edit': 'str_replace',
  'delete_path': 'delete_file'
};

export function getToolsForMode(mode: 'ask' | 'plan' | 'agent'): ToolDefinition[] {
  return TOOL_DEFINITIONS
    .filter(tool => tool.allowedModes.includes(mode))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function getToolByName(name: string): VoltToolDefinition | undefined {
  const aliasedName = TOOL_ALIASES[name] || name;
  return TOOL_DEFINITIONS.find(tool => tool.name === aliasedName);
}

export function doesToolRequireApproval(toolName: string): boolean {
  return getToolByName(toolName)?.requiresApproval ?? false;
}

export function isToolAllowed(toolName: string, mode: 'ask' | 'plan' | 'agent'): boolean {
  return getToolByName(toolName)?.allowedModes.includes(mode) ?? false;
}
