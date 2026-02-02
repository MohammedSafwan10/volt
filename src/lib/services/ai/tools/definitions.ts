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
import { getMcpToolDefinitions } from './handlers/mcp';

export type ToolCategory =
  | 'workspace_read'
  | 'workspace_search'
  | 'editor_context'
  | 'file_write'
  | 'terminal'
  | 'diagnostics'
  | 'browser';

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
    description: 'Read file contents. Use start_line/end_line for partial reads. Provide explanation for smarter content pruning.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. "src/app.ts"' },
        start_line: { type: 'number', description: 'Start line (1-based)' },
        end_line: { type: 'number', description: 'End line (inclusive)' },
        explanation: { type: 'string', description: 'Why you need this file - helps prune irrelevant content' }
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
  {
    name: 'read_code',
    description: 'Smart code file reader. Shows file structure (functions, classes, exports) and can read specific symbols by name. Better than read_file for code.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. "src/utils.ts"' },
        symbol: { type: 'string', description: 'Read specific symbol by name (function, class, etc.)' },
        structure: { type: 'boolean', description: 'Show structure summary (default: true)' }
      },
      required: ['path']
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
        caseSensitive: { type: 'boolean', description: 'Case sensitive (default: false)' },
        explanation: { type: 'string', description: 'Why you are searching - helps understand context' }
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
  {
    name: 'search_symbols',
    description: 'Search for functions, classes, variables, types by name. Uses LSP for accurate results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name to search (e.g. "handleSubmit", "UserService", "useState")' },
        kind: { type: 'string', description: 'Filter by kind: "function", "class", "variable", "type", "interface" (optional)' }
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
    description: 'Create or overwrite a file. Set force to true to overwrite even if content appears identical.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. "src/utils.ts"' },
        text: { type: 'string', description: 'File contents' },
        force: { type: 'boolean', description: 'Force overwrite even if identical to current content (useful if file is corrupted/broken)' }
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
Set force to true to overwrite even if content appears identical.

To delete code: set newStr to ""
If match fails: use read_file to get exact content first.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        oldStr: { type: 'string', description: 'Exact text to find' },
        newStr: { type: 'string', description: 'Replacement text' },
        force: { type: 'boolean', description: 'Force overwrite even if identical (rarely needed for this tool)' }
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
Set force to true to overwrite even if content appears identical.

Example: replace_lines(path, 10, 20, "new content") replaces lines 10-20 with new content.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        start_line: { type: 'number', description: 'First line to replace (1-based)' },
        end_line: { type: 'number', description: 'Last line to replace (inclusive)' },
        content: { type: 'string', description: 'New content to insert' },
        force: { type: 'boolean', description: 'Force overwrite even if identical' }
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
  {
    name: 'format_file',
    description: `Format a file using Prettier. Respects workspace .prettierrc config.

Supports: .ts, .tsx, .js, .jsx, .json, .css, .scss, .less, .html, .md, .svelte, .vue, .yaml

Use after writing/editing files to ensure consistent code style.
Requires Prettier installed in project (npm install -D prettier).`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to format' }
      },
      required: ['path']
    },
    category: 'file_write',
    requiresApproval: false,
    allowedModes: ['agent']
  },

  // ============================================
  // TERMINAL TOOLS
  // ============================================
  {
    name: 'run_command',
    description: `Run a shell command and wait for its completion. 
Executes in an isolated terminal to prevent interference with other processes.

CRITICAL RULES:
1. Supports command chaining (&&, ||, ;)
2. Each run_command executes independently
3. Use only for short-running tasks (install, git, mkdir, etc.)
4. For interactive prompts after start, use "send_terminal_input"`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
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
    description: `Start a long-running background process (dev servers, watchers, etc.).
Runs in its own persistent terminal instance.

Use this for:
- npm run dev, yarn start, pnpm dev
- webpack --watch, vite
- any command that doesn't exit immediately

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
  {
    name: 'send_terminal_input',
    description: 'Send raw text input to an active terminal process (e.g. answering "y/n" prompts, interacting with a REPL).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to send (e.g. "y", "n", "exit")' },
        processId: { type: 'number', description: 'Process ID to send input to (optional, defaults to last started process)' }
      },
      required: ['text']
    },
    category: 'terminal',
    requiresApproval: false,
    allowedModes: ['agent']
  },

  // ============================================
  // LSP CODE INTELLIGENCE (Semantic, not text-based!)
  // Supports: TypeScript, JavaScript, Svelte, HTML, CSS, JSON, Dart
  // ============================================
  {
    name: 'lsp_go_to_definition',
    description: `Jump to where a symbol is defined. BETTER than text search - understands imports/aliases.

Supported: .ts, .tsx, .js, .jsx, .svelte, .html, .css, .scss, .less, .dart

Use when: "Where is X defined?", "Go to definition of Y"

Can use EITHER:
- symbol: Just pass the symbol name, tool finds it automatically
- line + column: Exact position (1-based)

Returns: File path, line, and surrounding code context.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the symbol reference' },
        symbol: { type: 'string', description: 'Symbol name to find (e.g. "handleSubmit")' },
        line: { type: 'number', description: 'Line number (1-based) - optional if symbol provided' },
        column: { type: 'number', description: 'Column number (1-based) - optional if symbol provided' }
      },
      required: ['path']
    },
    category: 'diagnostics',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'lsp_find_references',
    description: `Find ALL usages of a symbol across the project. BETTER than text search - finds renamed imports, aliases, etc.

Supported: .ts, .tsx, .js, .jsx, .svelte, .html, .css, .scss, .less, .dart

Use when: "What uses X?", "Find all references to Y", "Who calls this function?"

Can use EITHER:
- symbol: Just pass the symbol name, tool finds it automatically
- line + column: Exact position (1-based)

Returns: List of all files and lines that reference the symbol.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the symbol' },
        symbol: { type: 'string', description: 'Symbol name to find (e.g. "UserService")' },
        line: { type: 'number', description: 'Line number (1-based) - optional if symbol provided' },
        column: { type: 'number', description: 'Column number (1-based) - optional if symbol provided' },
        include_declaration: { type: 'boolean', description: 'Include the definition itself (default: true)' }
      },
      required: ['path']
    },
    category: 'diagnostics',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'lsp_get_hover',
    description: `Get type information and documentation for a symbol. Shows inferred types, function signatures, JSDoc/DartDoc.

Supported: .ts, .tsx, .js, .jsx, .svelte, .html, .css, .scss, .less, .json, .dart

Use when: "What type is X?", "What are the parameters?", "Show signature"

Can use EITHER:
- symbol: Just pass the symbol name, tool finds it automatically
- line + column: Exact position (1-based)

Returns: Type signature, documentation, and JSDoc comments.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        symbol: { type: 'string', description: 'Symbol name to find (e.g. "handleSubmit")' },
        line: { type: 'number', description: 'Line number (1-based) - optional if symbol provided' },
        column: { type: 'number', description: 'Column number (1-based) - optional if symbol provided' }
      },
      required: ['path']
    },
    category: 'diagnostics',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'lsp_rename_symbol',
    description: `Rename a symbol across ALL files atomically. MUCH safer than str_replace - won't break strings/comments.

Supported: .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs, .dart (TypeScript/JavaScript and Dart)

Use when: "Rename X to Y", "Refactor name of Z"

Can use EITHER:
- old_name: Just pass the current name, tool finds it automatically  
- line + column: Exact position (1-based)

ALWAYS use this instead of str_replace for renaming! It:
- Updates all import statements
- Updates all usage sites
- Preserves strings and comments
- Handles re-exports correctly`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the symbol to rename' },
        old_name: { type: 'string', description: 'Current name of the symbol (e.g. "userId")' },
        new_name: { type: 'string', description: 'New name for the symbol (e.g. "memberId")' },
        line: { type: 'number', description: 'Line number (1-based) - optional if old_name provided' },
        column: { type: 'number', description: 'Column on the symbol (1-based) - optional if old_name provided' }
      },
      required: ['path', 'new_name']
    },
    category: 'diagnostics',
    requiresApproval: true,
    allowedModes: ['agent']
  },
  // NOTE: lsp_get_code_actions and lsp_apply_code_action REMOVED
  // These tools were unreliable due to slow LSP initialization.
  // AI should use: run_command({ command: "npx eslint --fix path/to/file.ts" }) instead.

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

  // ============================================
  // BROWSER DEVTOOLS (AI can access browser data via CDP)
  // ============================================
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
    name: 'browser_get_performance',
    description: 'Get page performance metrics (load time, paint timing, resource count).',
    parameters: {
      type: 'object',
      properties: {}
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'browser_get_selected_element',
    description: 'Get the currently selected element in the browser (if user selected one).',
    parameters: {
      type: 'object',
      properties: {}
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'browser_get_summary',
    description: 'Get a summary of browser state: URL, console stats, network stats, recent errors.',
    parameters: {
      type: 'object',
      properties: {}
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
    description: 'Click an element in the browser by CSS selector. Uses CDP for reliable automation.',
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
    description: 'Type text into an input element in the browser. Uses CDP for reliable automation.',
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
    name: 'browser_get_element',
    description: 'Get detailed info about an element by CSS selector (tag, id, classes, text, dimensions).',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element' }
      },
      required: ['selector']
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['ask', 'plan', 'agent']
  },
  {
    name: 'browser_get_elements',
    description: 'Get multiple elements matching a CSS selector.',
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
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the browser and return the result. Powerful for custom queries.',
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
    description: 'Scroll the page - either to an element or by pixel amount.',
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
    name: 'browser_screenshot',
    description: 'Take a screenshot of the page or a specific element.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to screenshot (optional - screenshots full page if omitted)' },
        full_page: { type: 'boolean', description: 'Capture full scrollable page (default: false)' }
      }
    },
    category: 'browser',
    requiresApproval: false,
    allowedModes: ['agent']
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

/**
 * Get all tools for a mode, including MCP tools (agent mode only)
 */
export function getAllToolsForMode(mode: 'ask' | 'plan' | 'agent'): ToolDefinition[] {
  const builtInTools = getToolsForMode(mode);

  // MCP tools only available in agent mode
  if (mode === 'agent') {
    const mcpTools = getMcpToolDefinitions();
    return [...builtInTools, ...mcpTools];
  }

  return builtInTools;
}
