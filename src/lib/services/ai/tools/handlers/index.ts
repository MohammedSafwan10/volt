/**
 * Tool handlers index - exports all handlers
 */

// Read tools
export {
  handleReadFile,
  handleReadFiles,
  handleListDir,
  handleGetFileTree,
  handleGetFileInfo,
  handleReadCode
} from './read';

// Search tools
export {
  handleWorkspaceSearch,
  handleFindFiles,
  handleSearchSymbols
} from './search';

// Editor tools
export {
  handleGetActiveFile,
  handleGetSelection,
  handleGetOpenFiles
} from './editor';

// Write tools
export {
  handleWriteFile,
  handleAppendFile,
  handleStrReplace,
  handleCreateDir,
  handleDeleteFile,
  handleRenamePath,
  handleWritePlanFile,
  handleReplaceLines,
  handleFormatFile
} from './write';

// Terminal tools
export {
  handleRunCommand,
  handleStartProcess,
  handleStopProcess,
  handleListProcesses,
  handleGetProcessOutput,
  handleReadTerminal,
  handleSendTerminalInput
} from './terminal';

// Diagnostics tools
export {
  handleGetDiagnostics
} from './diagnostics';

// LSP Code Intelligence tools
export {
  handleLspGoToDefinition,
  handleLspFindReferences,
  handleLspGetHover,
  handleLspRenameSymbol,
  handleLspPrepareRename
  // NOTE: handleLspGetCodeActions and handleLspApplyCodeAction REMOVED - use run_command with eslint instead
} from './lsp';

// Browser tools
export {
  browser_get_console_logs,
  browser_get_errors,
  browser_get_network_requests,
  browser_get_network_request_details,
  browser_get_performance,
  browser_get_selected_element,
  browser_get_summary,
  browser_screenshot,
  browser_navigate,
  browser_click,
  browser_type,
  browser_get_element,
  browser_get_elements,
  browser_evaluate,
  browser_scroll,
  browser_wait_for,
} from './browser';

/**
 * Tool handler map - maps tool names to handlers
 */
import type { ToolResult } from '../utils';

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export const toolHandlers: Record<string, ToolHandler> = {
  // Read
  'list_dir': (args) => import('./read').then(m => m.handleListDir(args)),
  'read_file': (args) => import('./read').then(m => m.handleReadFile(args)),
  'read_files': (args) => import('./read').then(m => m.handleReadFiles(args)),
  'read_code': (args) => import('./read').then(m => m.handleReadCode(args)),
  'get_file_tree': (args) => import('./read').then(m => m.handleGetFileTree(args)),
  'get_file_info': (args) => import('./read').then(m => m.handleGetFileInfo(args)),

  // Search
  'workspace_search': (args) => import('./search').then(m => m.handleWorkspaceSearch(args)),
  'find_files': (args) => import('./search').then(m => m.handleFindFiles(args)),
  'search_symbols': (args) => import('./search').then(m => m.handleSearchSymbols(args)),

  // Editor
  'get_active_file': () => import('./editor').then(m => m.handleGetActiveFile()),
  'get_selection': () => import('./editor').then(m => m.handleGetSelection()),
  'get_open_files': () => import('./editor').then(m => m.handleGetOpenFiles()),

  // Write
  'write_file': (args) => import('./write').then(m => m.handleWriteFile(args)),
  'append_file': (args) => import('./write').then(m => m.handleAppendFile(args)),
  'str_replace': (args) => import('./write').then(m => m.handleStrReplace(args)),
  'apply_edit': (args) => import('./write').then(m => m.handleStrReplace(args)), // alias
  'replace_lines': (args) => import('./write').then(m => m.handleReplaceLines(args)),
  'create_dir': (args) => import('./write').then(m => m.handleCreateDir(args)),
  'delete_file': (args) => import('./write').then(m => m.handleDeleteFile(args)),
  'delete_path': (args) => import('./write').then(m => m.handleDeleteFile(args)), // alias
  'rename_path': (args) => import('./write').then(m => m.handleRenamePath(args)),
  'format_file': (args) => import('./write').then(m => m.handleFormatFile(args)),

  // Plan mode
  'write_plan_file': (args) => import('./write').then(m => m.handleWritePlanFile(args)),

  // Terminal
  'run_command': (args) => import('./terminal').then(m => m.handleRunCommand(args)),
  'start_process': (args) => import('./terminal').then(m => m.handleStartProcess(args)),
  'stop_process': (args) => import('./terminal').then(m => m.handleStopProcess(args)),
  'list_processes': () => import('./terminal').then(m => m.handleListProcesses()),
  'get_process_output': (args) => import('./terminal').then(m => m.handleGetProcessOutput(args)),
  'read_terminal': (args) => import('./terminal').then(m => m.handleReadTerminal(args)),
  'send_terminal_input': (args) => import('./terminal').then(m => m.handleSendTerminalInput(args)),

  // Diagnostics
  'get_diagnostics': (args) => import('./diagnostics').then(m => m.handleGetDiagnostics(args)),

  // LSP Code Intelligence
  'lsp_go_to_definition': (args) => import('./lsp').then(m => m.handleLspGoToDefinition(args)),
  'lsp_find_references': (args) => import('./lsp').then(m => m.handleLspFindReferences(args)),
  'lsp_get_hover': (args) => import('./lsp').then(m => m.handleLspGetHover(args)),
  'lsp_rename_symbol': (args) => import('./lsp').then(m => m.handleLspRenameSymbol(args)),
  // NOTE: lsp_get_code_actions and lsp_apply_code_action REMOVED - use run_command with eslint instead

  // Browser DevTools
  'browser_get_console_logs': (args) => import('./browser').then(m => m.browser_get_console_logs(args as any).then(r => ({ success: true, data: r }))),
  'browser_get_errors': (args) => import('./browser').then(m => m.browser_get_errors(args as any).then(r => ({ success: true, data: r }))),
  'browser_get_network_requests': (args) => import('./browser').then(m => m.browser_get_network_requests(args as any).then(r => ({ success: true, data: r }))),
  'browser_get_performance': () => import('./browser').then(m => m.browser_get_performance().then(r => ({ success: true, data: r }))),
  'browser_get_selected_element': () => import('./browser').then(m => m.browser_get_selected_element().then(r => ({ success: true, data: r }))),
  'browser_get_summary': () => import('./browser').then(m => m.browser_get_summary().then(r => ({ success: true, data: r }))),
  'browser_navigate': (args) => import('./browser').then(m => m.browser_navigate(args as any).then(r => ({ success: r.success, data: r, error: r.error }))),
  'browser_click': (args) => import('./browser').then(m => m.browser_click(args as any).then(r => ({ success: r.success, error: r.error }))),
  'browser_type': (args) => import('./browser').then(m => m.browser_type(args as any).then(r => ({ success: r.success, error: r.error }))),
  'browser_get_element': (args) => import('./browser').then(m => m.browser_get_element(args as any).then(r => ({ success: r.found, data: r, error: r.error }))),
  'browser_get_elements': (args) => import('./browser').then(m => m.browser_get_elements(args as any).then(r => ({ success: true, data: r, error: r.error }))),
  'browser_evaluate': (args) => import('./browser').then(m => m.browser_evaluate(args as any).then(r => ({ success: r.success, data: r, error: r.error }))),
  'browser_scroll': (args) => import('./browser').then(m => m.browser_scroll(args as any).then(r => ({ success: r.success, error: r.error }))),
  'browser_wait_for': (args) => import('./browser').then(m => m.browser_wait_for(args as any).then(r => ({ success: r.found, data: r, error: r.error }))),
  'browser_screenshot': (args) => import('./browser').then(m => m.browser_screenshot(args as any).then(r => ({ success: r.success, data: r, error: r.error }))),
};
