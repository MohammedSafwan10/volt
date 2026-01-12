/**
 * Tool handlers index - exports all handlers
 */

// Read tools
export { 
  handleReadFile, 
  handleReadFiles, 
  handleListDir, 
  handleGetFileTree, 
  handleGetFileInfo 
} from './read';

// Search tools
export { 
  handleWorkspaceSearch, 
  handleFindFiles 
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
  handleReplaceLines
} from './write';

// Terminal tools
export { 
  handleRunCommand,
  handleStartProcess,
  handleStopProcess,
  handleListProcesses,
  handleGetProcessOutput,
  handleReadTerminal 
} from './terminal';

// Diagnostics tools
export { 
  handleGetDiagnostics 
} from './diagnostics';

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
  'get_file_tree': (args) => import('./read').then(m => m.handleGetFileTree(args)),
  'get_file_info': (args) => import('./read').then(m => m.handleGetFileInfo(args)),
  
  // Search
  'workspace_search': (args) => import('./search').then(m => m.handleWorkspaceSearch(args)),
  'find_files': (args) => import('./search').then(m => m.handleFindFiles(args)),
  
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
  
  // Plan mode
  'write_plan_file': (args) => import('./write').then(m => m.handleWritePlanFile(args)),
  
  // Terminal
  'run_command': (args) => import('./terminal').then(m => m.handleRunCommand(args)),
  'start_process': (args) => import('./terminal').then(m => m.handleStartProcess(args)),
  'stop_process': (args) => import('./terminal').then(m => m.handleStopProcess(args)),
  'list_processes': () => import('./terminal').then(m => m.handleListProcesses()),
  'get_process_output': (args) => import('./terminal').then(m => m.handleGetProcessOutput(args)),
  'read_terminal': (args) => import('./terminal').then(m => m.handleReadTerminal(args)),
  
  // Diagnostics
  'get_diagnostics': (args) => import('./diagnostics').then(m => m.handleGetDiagnostics(args)),
};
