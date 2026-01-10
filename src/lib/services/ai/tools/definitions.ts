/**
 * AI Tool Definitions
 * Defines all available tools for the AI assistant with JSON Schema validation
 * 
 * Docs consulted:
 * - Gemini API: function calling format with functionDeclarations
 * - JSON Schema patterns for tool arguments validation
 */

import type { ToolDefinition } from '../types';

/**
 * Tool metadata for UX and auditing
 */
export interface ToolMeta {
  why: string;      // One sentence explaining the purpose
  risk: 'low' | 'medium' | 'high';
  undo: string;     // One sentence describing rollback plan
}

/**
 * Tool categories for organization
 */
export type ToolCategory =
  | 'workspace_read'    // Read-only workspace operations
  | 'workspace_search'  // Search operations
  | 'editor_context'    // Editor state queries
  | 'file_write'        // File mutation operations
  | 'terminal'          // Terminal operations
  | 'diagnostics';      // Code checking operations

/**
 * Extended tool definition with category and approval info
 */
export interface VoltToolDefinition extends ToolDefinition {
  category: ToolCategory;
  requiresApproval: boolean;
  allowedModes: ('ask' | 'plan' | 'agent')[];
}

/**
 * All available tools for the AI assistant
 */
export const TOOL_DEFINITIONS: VoltToolDefinition[] = [
  // ============================================
  // WORKSPACE READ TOOLS (allowed in all modes)
  // ============================================
  {
    name: 'list_dir',
    description: 'List contents of a directory. Returns file names, types, and sizes.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          description: 'Metadata for UX and auditing',
          properties: {
            why: { type: 'string', description: 'One sentence explaining the purpose' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string', description: 'One sentence rollback plan' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root. Use "." for root.'
        }
      },
      required: ['meta', 'path']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content as text.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root'
        },
        startLine: {
          type: 'number',
          description: 'Optional: Start reading from this line (1-based)'
        },
        endLine: {
          type: 'number',
          description: 'Optional: Stop reading at this line (inclusive)'
        }
      },
      required: ['meta', 'path']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'get_file_info',
    description: 'Get detailed information about a file or directory (size, modified date, permissions).',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root'
        }
      },
      required: ['meta', 'path']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },

  // ============================================
  // WORKSPACE SEARCH TOOLS (allowed in all modes)
  // ============================================
  {
    name: 'workspace_search',
    description: 'Search for text or patterns across all files in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        query: {
          type: 'string',
          description: 'Search query (plain text or regex)'
        },
        useRegex: {
          type: 'boolean',
          description: 'Whether to treat query as regex pattern'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Whether search is case-sensitive'
        },
        includePatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to include (e.g., "*.ts")'
        },
        excludePatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to exclude'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return'
        }
      },
      required: ['meta', 'query']
    },
    category: 'workspace_search',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },

  // ============================================
  // EDITOR CONTEXT TOOLS (allowed in all modes)
  // ============================================
  {
    name: 'get_active_file',
    description: 'Get the currently active file in the editor (path and content).',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        }
      },
      required: ['meta']
    },
    category: 'editor_context',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'get_selection',
    description: 'Get the currently selected text in the editor.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        }
      },
      required: ['meta']
    },
    category: 'editor_context',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'get_open_files',
    description: 'Get a list of all currently open files in the editor.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        }
      },
      required: ['meta']
    },
    category: 'editor_context',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },

  // ============================================
  // FILE WRITE TOOLS (agent mode only)
  // ============================================
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root'
        },
        content: {
          type: 'string',
          description: 'Content to write to the file'
        }
      },
      required: ['meta', 'path', 'content']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'apply_edit',
    description: `Apply a targeted edit to a file by replacing a specific code snippet.

USE THIS FOR:
- Small, focused changes (1-50 lines)
- Adding, modifying, or DELETING code
- When you know the exact text to replace

HOW TO DELETE CODE:
- Set new_snippet to empty string "" to delete the original_snippet

REQUIREMENTS:
- original_snippet must EXACTLY match file content (whitespace matters!)
- Use content from context or read_file, never from memory
- Include 2-3 lines of context for unique matching

IF THIS FAILS:
- Check the error message for hints
- Use read_file to get exact current content
- After 2 failures on same file, use write_file instead`,
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root'
        },
        original_snippet: {
          type: 'string',
          description: 'The exact code snippet to replace (must match file content exactly, including whitespace)'
        },
        new_snippet: {
          type: 'string',
          description: 'The new code to insert. Use empty string "" to delete the original_snippet.'
        }
      },
      required: ['meta', 'path', 'original_snippet', 'new_snippet']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'create_file',
    description: 'Create a new empty file. To create a file WITH content, use write_file instead.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root'
        }
      },
      required: ['meta', 'path']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'multi_replace_file_content',
    description: 'Apply multiple, non-contiguous edits to a file. Use this for surgical changes in multiple locations in the same file.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root'
        },
        replacement_chunks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              startLine: { type: 'number', description: 'Starting line of the chunk (1-indexed)' },
              endLine: { type: 'number', description: 'Ending line of the chunk (1-indexed)' },
              targetContent: { type: 'string', description: 'Exact content to be replaced' },
              replacementContent: { type: 'string', description: 'New content to insert' }
            },
            required: ['startLine', 'endLine', 'targetContent', 'replacementContent']
          }
        }
      },
      required: ['meta', 'path', 'replacement_chunks']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'create_dir',
    description: 'Create a new directory.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root'
        }
      },
      required: ['meta', 'path']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'delete_path',
    description: 'Delete a file or directory. DESTRUCTIVE - requires approval.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Relative path from workspace root'
        }
      },
      required: ['meta', 'path']
    },
    category: 'file_write',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'delete_paths',
    description: 'Delete multiple files/directories in one operation. DESTRUCTIVE - requires approval.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        paths: {
          type: 'array',
          description: 'Relative paths from workspace root',
          items: {
            type: 'string'
          }
        }
      },
      required: ['meta', 'paths']
    },
    category: 'file_write',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'rename_path',
    description: 'Rename or move a file or directory. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        oldPath: {
          type: 'string',
          description: 'Current relative path from workspace root'
        },
        newPath: {
          type: 'string',
          description: 'New relative path from workspace root'
        }
      },
      required: ['meta', 'oldPath', 'newPath']
    },
    category: 'file_write',
    requiresApproval: true,
    allowedModes: ['agent']
  },

  // ============================================
  // TERMINAL TOOLS (agent mode only, requires approval)
  // ============================================
  {
    name: 'run_command',
    description: `Execute a shell command and wait for output. The command runs in the visible terminal panel.

PREREQUISITES (IMPORTANT):
- BEFORE running commands on files, use get_file_tree or read_file to verify the file exists
- Use forward slashes (/) in paths, even on Windows
- For paths with spaces, use quotes: "path/with spaces/file.js"

BEHAVIOR:
- By default, waits for command to complete (detects prompt return or output stabilization)
- For long-running commands (npm install, cargo build, etc.), uses longer stability thresholds
- Set wait=false to run in background and return immediately

WHEN TO USE:
- Running scripts, installing packages, checking versions
- Build commands, test runners, linters
- Any shell command that produces output

AFTER RUNNING:
- Check the output for errors or success messages
- If output says "may still be running", use read_terminal to get more output
- If command failed, explain the error and suggest fixes

Requires approval.`,
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        command: {
          type: 'string',
          description: 'Shell command to execute (e.g., "npm install", "python --version")'
        },
        cwd: {
          type: 'string',
          description: 'Optional: Working directory relative to workspace root'
        },
        timeout: {
          type: 'number',
          description: 'Optional: Timeout in milliseconds (default: 60000 = 60 seconds)'
        },
        wait: {
          type: 'boolean',
          description: 'Optional: Wait for command completion (default: true). Set false for background execution.'
        }
      },
      required: ['meta', 'command']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'terminal_create',
    description: 'Create a new terminal session. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the terminal (relative to workspace root)'
        }
      },
      required: ['meta']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'terminal_write',
    description: 'Write/execute a command in a terminal. DANGEROUS - requires approval.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        terminalId: {
          type: 'string',
          description: 'ID of the terminal to write to (optional; defaults to active terminal)'
        },
        sessionId: {
          type: 'string',
          description: 'Legacy alias for terminalId (optional)'
        },
        command: {
          type: 'string',
          description: 'Command to execute'
        },
        waitMs: {
          type: 'number',
          description: 'Optional: time to wait for initial output after sending (default ~800ms)'
        }
      },
      required: ['meta', 'command']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'terminal_kill',
    description: 'Kill a terminal session. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        terminalId: {
          type: 'string',
          description: 'ID of the terminal to kill'
        }
      },
      required: ['meta', 'terminalId']
    },
    category: 'terminal',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  {
    name: 'terminal_get_output',
    description: 'Get recent output from a terminal.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        terminalId: {
          type: 'string',
          description: 'ID of the terminal (optional - uses AI terminal if not specified)'
        },
        lines: {
          type: 'number',
          description: 'Number of recent lines to retrieve'
        }
      },
      required: ['meta']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'read_terminal',
    description: `Read output from a terminal session. Use this to:
- Check if a long-running command has completed
- Get more output after run_command timed out
- Monitor ongoing processes

Returns the recent terminal output with ANSI codes stripped.
If no terminalId specified, reads from the AI terminal.`,
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        terminalId: {
          type: 'string',
          description: 'ID of the terminal (optional - uses AI terminal if not specified)'
        },
        maxLines: {
          type: 'number',
          description: 'Maximum lines to return (default: 100)'
        }
      },
      required: ['meta']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'read_files',
    description: 'Read the content of multiple files at once. More efficient than multiple read_file calls.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of relative paths to read'
        }
      },
      required: ['meta', 'paths']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'find_files',
    description: 'Find files across the entire workspace using a fuzzy search pattern. Very efficient for locating modules.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        pattern: {
          type: 'string',
          description: 'Fuzzy search pattern (e.g. "assistant.svelte")'
        },
        maxResults: {
          type: 'number',
          description: 'Limit results (default: 50)'
        }
      },
      required: ['meta', 'pattern']
    },
    category: 'workspace_search',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'get_file_tree',
    description: 'Get the recursive file tree structure of a directory. useful for understanding architecture.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Root path for the tree (default: ".")'
        },
        depth: {
          type: 'number',
          description: 'Maximum recursion depth (default: 3)'
        }
      },
      required: ['meta']
    },
    category: 'workspace_read',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'search_symbols',
    description: 'Search for symbols (functions, classes, variables) across the workspace using grep-style matching.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        query: {
          type: 'string',
          description: 'Symbol name or search query'
        }
      },
      required: ['meta', 'query']
    },
    category: 'workspace_search',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'run_check',
    description: 'Run type checking or linting on the project (npm run check, cargo check, etc.).',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        checkType: {
          type: 'string',
          enum: ['npm_check', 'cargo_check', 'eslint', 'typescript'],
          description: 'Type of check to run'
        }
      },
      required: ['meta', 'checkType']
    },
    category: 'diagnostics',
    requiresApproval: false,
    allowedModes: ['agent']
  },
  {
    name: 'get_diagnostics',
    description: 'Get current errors, warnings, and hints from the IDE problems panel. Use this to see if your changes broke anything.',
    parameters: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            why: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            undo: { type: 'string' }
          },
          required: ['why', 'risk', 'undo']
        },
        path: {
          type: 'string',
          description: 'Optional: Only get problems for this specific file'
        }
      },
      required: ['meta']
    },
    category: 'diagnostics',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  }
];

/**
 * Get tool definitions filtered by mode
 */
export function getToolsForMode(mode: 'ask' | 'plan' | 'agent'): ToolDefinition[] {
  const relaxMetaRequirement = (schema: unknown): unknown => {
    if (!schema || typeof schema !== 'object') return schema;

    if (Array.isArray(schema)) {
      return schema.map(relaxMetaRequirement);
    }

    // Clone so we don't mutate the canonical TOOL_DEFINITIONS.
    const cloned: Record<string, unknown> = { ...(schema as Record<string, unknown>) };

    // Strip `meta` from required list at the top level.
    if (Array.isArray(cloned.required)) {
      const filtered = (cloned.required as unknown[]).filter((x) => x !== 'meta');
      if (filtered.length === 0) {
        delete cloned.required;
      } else {
        cloned.required = filtered;
      }
    }

    // Recursively relax nested schemas (best-effort).
    for (const [key, value] of Object.entries(cloned)) {
      if (key === 'required') continue;
      if (value && typeof value === 'object') {
        cloned[key] = relaxMetaRequirement(value);
      }
    }

    return cloned;
  };

  return TOOL_DEFINITIONS
    .filter(tool => tool.allowedModes.includes(mode))
    .map(({ name, description, parameters }) => ({
      name,
      description,
      parameters: relaxMetaRequirement(parameters) as ToolDefinition['parameters']
    }));
}

/**
 * Get a tool definition by name
 */
export function getToolByName(name: string): VoltToolDefinition | undefined {
  return TOOL_DEFINITIONS.find(tool => tool.name === name);
}

/**
 * Check if a tool requires approval
 */
export function doesToolRequireApproval(toolName: string): boolean {
  const tool = getToolByName(toolName);
  return tool?.requiresApproval ?? false;
}

/**
 * Check if a tool is allowed in a given mode
 */
export function isToolAllowed(toolName: string, mode: 'ask' | 'plan' | 'agent'): boolean {
  const tool = getToolByName(toolName);
  return tool?.allowedModes.includes(mode) ?? false;
}
