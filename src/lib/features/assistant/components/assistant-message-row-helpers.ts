import type { ToolCall } from '$features/assistant/types/tool-call';

const TERMINAL_TOOL_NAMES = new Set(['run_command', 'start_process', 'get_process_output']);

export function isUnresolvedTerminalToolCall(
  toolCall: Pick<ToolCall, 'name' | 'status' | 'requiresApproval' | 'reviewStatus'>,
): boolean {
  if (!TERMINAL_TOOL_NAMES.has(toolCall.name)) return false;
  if (!toolCall.requiresApproval) return false;

  const isApprovedPending =
    toolCall.status === 'pending' && toolCall.reviewStatus === 'accepted';

  return toolCall.status === 'running' || toolCall.status === 'pending' || isApprovedPending;
}
