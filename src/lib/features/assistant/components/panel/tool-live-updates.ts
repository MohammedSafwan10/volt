import { isFileMutatingTool } from '$core/ai/tools';
import type {
  ToolRuntimeContext,
  ToolRuntimeUpdate,
} from '$core/ai/tools/runtime';

export function getInitialToolLiveStatus(toolName: string): string | undefined {
  if (toolName === 'read_file' || toolName === 'read_files' || toolName === 'read_code') {
    return 'Reading file...';
  }
  if (toolName === 'workspace_search' || toolName === 'find_files') {
    return 'Searching workspace...';
  }
  if (toolName === 'get_diagnostics' || toolName.startsWith('lsp_')) {
    return 'Collecting diagnostics...';
  }
  if (toolName === 'delete_file') {
    return 'Deleting...';
  }
  if (toolName === 'rename_path') {
    return 'Renaming...';
  }
  if (toolName === 'create_dir') {
    return 'Creating directory...';
  }
  if (toolName === 'write_file') {
    return 'Writing file...';
  }
  if (toolName === 'append_file') {
    return 'Appending to file...';
  }
  if (toolName === 'apply_patch') {
    return 'Applying patch...';
  }
  if (toolName === 'replace_lines') {
    return 'Replacing lines...';
  }
  if (toolName === 'str_replace' || toolName === 'multi_replace') {
    return 'Updating file...';
  }
  if (isFileMutatingTool(toolName)) {
    return 'Applying edit...';
  }
  if (toolName === 'run_command' || toolName === 'start_process') {
    return 'Running command...';
  }
  if (toolName === 'list_dir' || toolName === 'get_file_tree' || toolName === 'get_file_info') {
    return 'Inspecting workspace...';
  }
  return undefined;
}

export function createToolRuntimeContext(
  applyPatch: (patch: Record<string, unknown>) => void,
): ToolRuntimeContext {
  return {
    onUpdate: (update: ToolRuntimeUpdate) => {
      const patch = toToolCallPatch(update);
      if (Object.keys(patch).length === 0) return;
      applyPatch(patch);
    },
  };
}

export function toToolCallPatch(
  update: ToolRuntimeUpdate,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const meta: Record<string, unknown> = {
    ...(update.meta ?? {}),
  };
  if (update.liveStatus) {
    meta.liveStatus = update.liveStatus;
  }
  if (Object.keys(meta).length > 0) {
    patch.meta = meta;
  }
  return patch;
}
