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
    description: 'Apply a targeted edit to a file by replacing a specific code snippet. PREFERRED over write_file for small changes.',
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
          description: 'The exact code snippet to replace (must match file content exactly)'
        },
        new_snippet: {
          type: 'string',
          description: 'The new code to insert in place of the original snippet'
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
    description: 'Create a new empty file.',
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
    description: 'Execute a shell command and wait for output. The command runs in the visible terminal panel. Use this for running scripts, installing packages, checking versions, etc. Requires approval.',
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
          description: 'Optional: Timeout in milliseconds (default: 30000)'
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
          description: 'ID of the terminal to write to'
        },
        command: {
          type: 'string',
          description: 'Command to execute'
        }
      },
      required: ['meta', 'terminalId', 'command']
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
          description: 'ID of the terminal'
        },
        lines: {
          type: 'number',
          description: 'Number of recent lines to retrieve'
        }
      },
      required: ['meta', 'terminalId']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },

  // ============================================
  // DIAGNOSTICS TOOLS (agent mode recommended)
  // ============================================
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
