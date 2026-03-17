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
  handleReadCode,
  handleFileOutline
} from '$core/ai/tools/handlers/read';

// Search tools
export {
  handleWorkspaceSearch,
  handleFindFiles,
  handleSearchSymbols
} from '$core/ai/tools/handlers/search';

// Editor tools
export {
  handleGetActiveFile,
  handleGetSelection,
  handleGetOpenFiles
} from '$core/ai/tools/handlers/editor';

// Write tools
export {
  handleWriteFile,
  handleAppendFile,
  handleStrReplace,
  handleApplyPatch,
  handleMultiReplace,
  handleCreateDir,
  handleDeleteFile,
  handleRenamePath,
  handleWritePlanFile,
  handleReplaceLines,
  handleFormatFile
} from '$core/ai/tools/handlers/write';

// Terminal tools
export {
  handleRunCommand,
  handleStartProcess,
  handleStopProcess,
  handleListProcesses,
  handleGetProcessOutput,
  handleCommandStatus,
  handleReadTerminal,
  handleSendTerminalInput
} from '$core/ai/tools/handlers/terminal';

// Diagnostics tools
export {
  handleGetDiagnostics,
  handleGetToolMetrics
} from '$core/ai/tools/handlers/diagnostics';

// Workflow tools
export {
  handleAttemptCompletion
} from '$core/ai/tools/handlers/workflow';

// LSP Code Intelligence tools
export {
  handleLspGoToDefinition,
  handleLspFindReferences,
  handleLspGetHover,
  handleLspRenameSymbol,
  handleLspPrepareRename
  // NOTE: handleLspGetCodeActions and handleLspApplyCodeAction REMOVED - use run_command with eslint instead
} from '$core/ai/tools/handlers/lsp';

// Browser tools
export {
  browser_get_console_logs,
  browser_get_errors,
  browser_get_network_requests,
  browser_get_network_request_details,
  browser_get_performance,
  browser_get_selected_element,
  browser_get_summary,
  browser_get_application_storage,
  browser_get_security_report,
  browser_propose_action,
  browser_preview_action,
  browser_execute_action,
  browser_screenshot,
  browser_navigate,
  browser_click,
  browser_type,
  browser_get_element,
  browser_get_elements,
  browser_evaluate,
  browser_scroll,
  browser_wait_for,
} from '$core/ai/tools/handlers/browser';

/**
 * Tool handler map - maps tool names to handlers
 */
import type { ToolResult } from '$core/ai/tools/utils';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';
import {
  handleCommandStatus,
  handleGetProcessOutput,
  handleListProcesses,
  handleReadTerminal,
  handleRunCommand,
  handleSendTerminalInput,
  handleStartProcess,
  handleStopProcess,
} from '$core/ai/tools/handlers/terminal';

type ToolHandler = (
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
) => Promise<ToolResult>;

function browserResult(result: unknown, success = true, error?: string): ToolResult {
  const warnings =
    result && typeof result === 'object' && Array.isArray((result as any).warnings)
      ? ((result as any).warnings as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
  const output =
    typeof result === 'string'
      ? result
      : JSON.stringify(result, null, 2);
  return { success, output, data: result, error, warnings };
}

export const toolHandlers: Record<string, ToolHandler> = {
  // Read
  'list_dir': (args) => import('$core/ai/tools/handlers/read').then(m => m.handleListDir(args)),
  'read_file': (args, runtime) => import('$core/ai/tools/handlers/read').then(m => m.handleReadFile(args, runtime)),
  'read_files': (args, runtime) => import('$core/ai/tools/handlers/read').then(m => m.handleReadFiles(args, runtime)),
  'read_code': (args, runtime) => import('$core/ai/tools/handlers/read').then(m => m.handleReadCode(args, runtime)),
  'file_outline': (args) => import('$core/ai/tools/handlers/read').then(m => m.handleFileOutline(args)),
  'get_file_tree': (args) => import('$core/ai/tools/handlers/read').then(m => m.handleGetFileTree(args)),
  'get_file_info': (args) => import('$core/ai/tools/handlers/read').then(m => m.handleGetFileInfo(args)),

  // Search
  'workspace_search': (args) => import('$core/ai/tools/handlers/search').then(m => m.handleWorkspaceSearch(args)),
  'find_files': (args) => import('$core/ai/tools/handlers/search').then(m => m.handleFindFiles(args)),

  // Editor
  'get_active_file': () => import('$core/ai/tools/handlers/editor').then(m => m.handleGetActiveFile()),
  'get_selection': () => import('$core/ai/tools/handlers/editor').then(m => m.handleGetSelection()),
  'get_open_files': () => import('$core/ai/tools/handlers/editor').then(m => m.handleGetOpenFiles()),

  // Write
  'write_file': (args, runtime) => import('$core/ai/tools/handlers/write').then(m => m.handleWriteFile(args, runtime)),
  'append_file': (args, runtime) => import('$core/ai/tools/handlers/write').then(m => m.handleAppendFile(args, runtime)),
  'str_replace': (args, runtime) => import('$core/ai/tools/handlers/write').then(m => m.handleStrReplace(args, runtime)),
  'apply_patch': (args, runtime) => import('$core/ai/tools/handlers/write').then(m => m.handleApplyPatch(args, runtime)),
  'multi_replace': (args, runtime) => import('$core/ai/tools/handlers/write').then(m => m.handleMultiReplace(args, runtime)),
  'replace_lines': (args, runtime) => import('$core/ai/tools/handlers/write').then(m => m.handleReplaceLines(args, runtime)),
  'create_dir': (args) => import('$core/ai/tools/handlers/write').then(m => m.handleCreateDir(args)),
  'delete_file': (args) => import('$core/ai/tools/handlers/write').then(m => m.handleDeleteFile(args)),
  'rename_path': (args) => import('$core/ai/tools/handlers/write').then(m => m.handleRenamePath(args)),
  'format_file': (args) => import('$core/ai/tools/handlers/write').then(m => m.handleFormatFile(args)),

  // Plan mode
  'write_plan_file': (args) => import('$core/ai/tools/handlers/write').then(m => m.handleWritePlanFile(args)),

  // Terminal
  'run_command': (args) => handleRunCommand(args),
  'start_process': (args) => handleStartProcess(args),
  'stop_process': (args) => handleStopProcess(args),
  'list_processes': () => handleListProcesses(),
  'get_process_output': (args) => handleGetProcessOutput(args),
  'command_status': (args) => handleCommandStatus(args),
  'read_terminal': (args) => handleReadTerminal(args),
  'send_terminal_input': (args) => handleSendTerminalInput(args),

  // Diagnostics
  'get_diagnostics': (args, runtime) => import('$core/ai/tools/handlers/diagnostics').then(m => m.handleGetDiagnostics(args, runtime)),
  'get_tool_metrics': (_args, runtime) => import('$core/ai/tools/handlers/diagnostics').then(m => m.handleGetToolMetrics(runtime)),
  'attempt_completion': (args) => import('$core/ai/tools/handlers/workflow').then(m => m.handleAttemptCompletion(args)),

  // LSP Code Intelligence
  'lsp_go_to_definition': (args) => import('$core/ai/tools/handlers/lsp').then(m => m.handleLspGoToDefinition(args)),
  'lsp_find_references': (args) => import('$core/ai/tools/handlers/lsp').then(m => m.handleLspFindReferences(args)),
  'lsp_get_hover': (args) => import('$core/ai/tools/handlers/lsp').then(m => m.handleLspGetHover(args)),
  'lsp_rename_symbol': (args) => import('$core/ai/tools/handlers/lsp').then(m => m.handleLspRenameSymbol(args)),
  // NOTE: lsp_get_code_actions and lsp_apply_code_action REMOVED - use run_command with eslint instead

  // Browser DevTools
  'browser_get_console_logs': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_console_logs(args as any).then(r => browserResult(r, true))),
  'browser_get_errors': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_errors(args as any).then(r => browserResult(r, true))),
  'browser_get_network_requests': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_network_requests(args as any).then(r => browserResult(r, true))),
  'browser_get_network_request_details': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_network_request_details(args as any).then(r => browserResult(r, true))),
  'browser_get_performance': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_performance(args as any).then(r => browserResult(r, true))),
  'browser_get_selected_element': () => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_selected_element().then(r => browserResult(r, true))),
  'browser_get_summary': () => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_summary().then(r => browserResult(r, true))),
  'browser_get_application_storage': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_application_storage(args as any).then(r => browserResult(r, true))),
  'browser_get_security_report': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_security_report(args as any).then(r => browserResult(r, true))),
  'browser_propose_action': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_propose_action(args as any).then(r => browserResult(r, true))),
  'browser_preview_action': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_preview_action(args as any).then(r => browserResult(r, r.success))),
  'browser_execute_action': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_execute_action(args as any).then(r => browserResult(r, r.success))),
  'browser_navigate': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_navigate(args as any).then(r => browserResult(r, r.success, r.error))),
  'browser_click': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_click(args as any).then(r => browserResult(r, r.success, r.error))),
  'browser_type': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_type(args as any).then(r => browserResult(r, r.success, r.error))),
  'browser_get_element': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_element(args as any).then(r => browserResult(r, r.found, r.error))),
  'browser_get_elements': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_get_elements(args as any).then(r => browserResult(r, true, r.error))),
  'browser_evaluate': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_evaluate(args as any).then(r => browserResult(r, r.success, r.error))),
  'browser_scroll': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_scroll(args as any).then(r => browserResult(r, r.success, r.error))),
  'browser_wait_for': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_wait_for(args as any).then(r => browserResult(r, r.found, r.error))),
  'browser_screenshot': (args) => import('$core/ai/tools/handlers/browser').then(m => m.browser_screenshot(args as any).then(r => browserResult(r, r.success, r.error))),
};
