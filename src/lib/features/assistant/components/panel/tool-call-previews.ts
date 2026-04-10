import type { ToolCall } from '$features/assistant/types/tool-call';

import { classifyPlanningPhase } from './verification-profiles';
import { getInitialToolLiveStatus } from './tool-live-updates';

const FINAL_TOOL_STATUSES = new Set<ToolCall['status']>(['completed', 'failed', 'cancelled']);
const FILE_MUTATING_TOOLS = new Set([
  'delete_file',
  'rename_path',
  'create_dir',
  'write_file',
  'append_file',
  'apply_patch',
  'replace_lines',
  'str_replace',
  'multi_replace',
]);

export function buildPartialToolCallPreview(params: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  existingToolCall?: ToolCall;
}): ToolCall {
  const existing = params.existingToolCall;
  const existingStatus = existing?.status;
  const planningPhase = FILE_MUTATING_TOOLS.has(params.toolName)
    ? 'edit'
    : classifyPlanningPhase(params.toolName);

  return {
    id: params.toolCallId,
    name: params.toolName,
    arguments: params.toolArgs,
    status:
      existingStatus && FINAL_TOOL_STATUSES.has(existingStatus)
        ? existingStatus
        : (existingStatus ?? 'pending'),
    output: existing?.output,
    error: existingStatus === 'failed' ? existing?.error : undefined,
    requiresApproval: existing?.requiresApproval,
    reviewStatus: existing?.reviewStatus,
    thoughtSignature: existing?.thoughtSignature,
    startTime: existing?.startTime,
    endTime: existing?.endTime,
    data: existing?.data,
    streamingProgress: existing?.streamingProgress,
    meta: {
      ...(existing?.meta ?? {}),
      partialToolCall: true,
      planningPhase,
      liveStatus:
        getInitialToolLiveStatus(params.toolName) ??
        (existing?.meta as Record<string, unknown> | undefined)?.liveStatus,
    },
  };
}
