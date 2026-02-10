import { getToolByName } from './definitions';
import { isMcpTool, isMcpToolAutoApproved } from './handlers/mcp';

export interface ToolCapabilities {
  isMutating: boolean;
  isLongRunning: boolean;
  requiresWorkspacePathValidation: boolean;
  requiresApproval: boolean;
}

const LONG_RUNNING_TERMINAL_TOOLS = new Set([
  'run_command',
  'start_process',
  'stop_process',
  'get_process_output',
  'command_status',
  'list_processes',
  'read_terminal',
  'send_terminal_input',
]);

const PATH_VALIDATED_TOOLS = new Set([
  'list_dir',
  'read_file',
  'read_files',
  'get_file_tree',
  'read_code',
  'file_outline',
  'get_file_info',
  'workspace_search',
  'find_files',
  'search_symbols',
  'write_file',
  'append_file',
  'str_replace',
  'apply_edit',
  'replace_lines',
  'multi_replace',
  'create_dir',
  'delete_file',
  'delete_path',
  'rename_path',
  'format_file',
  'run_command',
  'start_process',
]);

const MUTATING_TOOL_OVERRIDES = new Set([
  'run_command',
  'start_process',
  'stop_process',
  'send_terminal_input',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_evaluate',
  'lsp_rename_symbol',
]);

export function getToolCapabilities(toolName: string): ToolCapabilities {
  if (isMcpTool(toolName)) {
    return {
      isMutating: false,
      isLongRunning: false,
      requiresWorkspacePathValidation: false,
      requiresApproval: !isMcpToolAutoApproved(toolName),
    };
  }

  const tool = getToolByName(toolName);
  const category = tool?.category;

  const isMutatingByCategory = category === 'file_write';
  const isMutating = isMutatingByCategory || MUTATING_TOOL_OVERRIDES.has(toolName);

  const isLongRunning =
    category === 'terminal' && LONG_RUNNING_TERMINAL_TOOLS.has(toolName);

  const requiresWorkspacePathValidation = PATH_VALIDATED_TOOLS.has(toolName);
  const requiresApproval = tool?.requiresApproval ?? false;

  return {
    isMutating,
    isLongRunning,
    requiresWorkspacePathValidation,
    requiresApproval,
  };
}

export function isFileMutatingTool(toolName: string): boolean {
  const tool = getToolByName(toolName);
  return tool?.category === 'file_write' && getToolCapabilities(toolName).isMutating;
}

export function isTerminalTool(toolName: string): boolean {
  const tool = getToolByName(toolName);
  return tool?.category === 'terminal' || toolName === 'terminal_write';
}

