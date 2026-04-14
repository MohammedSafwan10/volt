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

// Terminal tools (v2 - unified surface)
export {
  handleRunInTerminal,
  handleGetTerminalOutput,
  handleSendToTerminal,
  handleKillTerminal,
  handleRunCommandV2,
} from '$core/ai/tools/handlers/terminal-v2';

// Terminal tools (v1 - legacy, used by backward compat handler map)
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

// Spec workflow tools
export {
  handleGetSpecState,
  handleStageSpecRequirements,
  handleWriteSpecPhase
} from '$core/ai/tools/handlers/spec';

// LSP Code Intelligence tools
export {
  handleLspGoToDefinition,
  handleLspFindReferences,
  handleLspGetHover,
  handleLspRenameSymbol,
  handleLspPrepareRename
  // NOTE: handleLspGetCodeActions and handleLspApplyCodeAction REMOVED - use run_command with eslint instead
} from '$core/ai/tools/handlers/lsp';

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
import {
  handleRunInTerminal,
  handleGetTerminalOutput,
  handleSendToTerminal,
  handleKillTerminal,
  handleRunCommandV2,
} from '$core/ai/tools/handlers/terminal-v2';

type ToolHandler = (
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
) => Promise<ToolResult>;

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

  // Terminal (v2 - unified surface)
  'run_in_terminal': (args, runtime) => handleRunInTerminal(args, runtime),
  'get_terminal_output': (args) => handleGetTerminalOutput(args),
  'send_to_terminal': (args) => handleSendToTerminal(args),
  'kill_terminal': (args) => handleKillTerminal(args),

  // Terminal (v1 backward compat aliases)
  'run_command': (args, runtime) => handleRunCommandV2(args, runtime),
  'start_process': (args, runtime) => handleRunInTerminal({ ...args, mode: 'async' }, runtime),
  'stop_process': (args) => handleStopProcess(args),
  'list_processes': () => handleListProcesses(),
  'get_process_output': (args) => handleGetProcessOutput(args),
  'command_status': (args) => handleCommandStatus(args),
  'read_terminal': (args) => handleReadTerminal(args),
  'send_terminal_input': (args) => handleSendTerminalInput(args),

  // Diagnostics
  'get_diagnostics': (args, runtime) => import('$core/ai/tools/handlers/diagnostics').then(m => m.handleGetDiagnostics(args, runtime)),
  'get_tool_metrics': (_args, runtime) => import('$core/ai/tools/handlers/diagnostics').then(m => m.handleGetToolMetrics(runtime)),
  'get_spec_state': () => import('$core/ai/tools/handlers/spec').then(m => m.handleGetSpecState()),
  'stage_spec_requirements': (args) => import('$core/ai/tools/handlers/spec').then(m => m.handleStageSpecRequirements(args)),
  'write_spec_phase': (args) => import('$core/ai/tools/handlers/spec').then(m => m.handleWriteSpecPhase(args)),

  // LSP Code Intelligence
  'lsp_go_to_definition': (args) => import('$core/ai/tools/handlers/lsp').then(m => m.handleLspGoToDefinition(args)),
  'lsp_find_references': (args) => import('$core/ai/tools/handlers/lsp').then(m => m.handleLspFindReferences(args)),
  'lsp_get_hover': (args) => import('$core/ai/tools/handlers/lsp').then(m => m.handleLspGetHover(args)),
  'lsp_rename_symbol': (args) => import('$core/ai/tools/handlers/lsp').then(m => m.handleLspRenameSymbol(args)),
  // NOTE: lsp_get_code_actions and lsp_apply_code_action REMOVED - use run_command with eslint instead
};
