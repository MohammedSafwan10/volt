import type { AgentLoopState } from '$features/assistant/stores/assistant/loop-state';
import type { ToolCallStatus } from '$features/assistant/types/tool-call';

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

function baseModelId(model: string): string {
  return model.endsWith('|thinking') ? model.slice(0, -'|thinking'.length) : model;
}

export function formatModelDisplayName(
  model: string,
  options: { showReasoningTag?: boolean } = {},
): string {
  const thinking = model.endsWith('|thinking');
  const base = baseModelId(model);

  let displayName = base;

  if (base.includes('/')) {
    const parts = base.split('/');
    const modelPart = parts[parts.length - 1];
    displayName = modelPart
      .replace(':free', '')
      .replace(/-/g, ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    if (model.includes(':free')) displayName += ' (free)';
    return thinking && options.showReasoningTag ? `${displayName} (Reasoning)` : displayName;
  }

  if (base.startsWith('gpt-')) {
    displayName = base
      .replace('gpt-5.4', 'GPT 5.4')
      .replace('gpt-5.2 pro', 'GPT 5.2 Pro')
      .replace('gpt-5.2', 'GPT 5.2')
      .replace('gpt-5.1-chat-latest', 'GPT 5.1 (Instant)')
      .replace('gpt-5.1', 'GPT 5.1')
      .replace('gpt-5.3-codex', 'GPT 5.3 Codex')
      .replace('gpt-5-mini', 'GPT 5 Mini')
      .replace('gpt-5-nano', 'GPT 5 Nano')
      .replace('gpt-4o', 'GPT 4o');
    return thinking && options.showReasoningTag ? `${displayName} (Reasoning)` : displayName;
  }

  if (base.startsWith('claude-')) {
    displayName = base
      .replace('claude-', 'Claude ')
      .replace('-4-6', ' 4.6')
      .replace('opus', 'Opus')
      .replace('sonnet-4-5-20250929', 'Sonnet 4.5')
      .replace('sonnet-latest', '3.5 Sonnet')
      .replace('opus-latest', '3.5 Opus');
    return thinking && options.showReasoningTag ? `${displayName} (Reasoning)` : displayName;
  }

  if (base.startsWith('gemini-')) {
    displayName = base
      .replace('gemini-3.1-pro-preview', 'Gemini 3.1 Pro')
      .replace('gemini-3-flash-preview', 'Gemini 3 Flash')
      .replace('gemini-2.5-flash', 'Gemini 2.5 Flash')
      .replace('gemini-2.0-flash-exp', 'Gemini 2.0 Flash')
      .replace('gemini-1.5-pro-latest', 'Gemini 1.5 Pro')
      .replace('gemini-1.5-flash-latest', 'Gemini 1.5 Flash')
      .replace('gemini-2.0-pro-exp-02-05', 'Gemini 2.0 Pro');
    return thinking && options.showReasoningTag ? `${displayName} (Reasoning)` : displayName;
  }

  if (base.startsWith('devstral-') || base.startsWith('codestral-')) {
    displayName = base
      .replace('devstral-latest', 'Devstral (latest, v25.12)')
      .replace('codestral-latest', 'Codestral (latest, v25.08)')
      .replace('devstral-medium-latest', 'Devstral Medium (v25.07)');
    return thinking && options.showReasoningTag ? `${displayName} (Reasoning)` : displayName;
  }

  return thinking && options.showReasoningTag ? `${base} (Reasoning)` : base;
}

export function getRuntimeActivityLabel(params: {
  agentLoopState?: AgentLoopState | null;
  activeToolCallName?: string | null;
  activeToolStatus?: ToolCallStatus | null;
  activeToolRequiresApproval?: boolean;
  pendingApprovalCount?: number;
  runningToolCount?: number;
}): string | null {
  const loopState = params.agentLoopState ?? null;
  const activeToolName = params.activeToolCallName ?? null;
  const activeToolStatus = params.activeToolStatus ?? null;
  const pendingApprovalCount = params.pendingApprovalCount ?? 0;
  const runningToolCount = params.runningToolCount ?? 0;

  if (loopState === 'waiting_approval' || pendingApprovalCount > 0) {
    return 'Waiting for approval';
  }

  if (activeToolStatus === 'running' && activeToolName) {
    if (FILE_MUTATING_TOOLS.has(activeToolName)) {
      return 'Applying edits';
    }
    if (activeToolName === 'run_command' || activeToolName === 'start_process') {
      return 'Running command';
    }
    return 'Running tools';
  }

  if (loopState === 'waiting_tool') {
    return runningToolCount > 0 ? 'Running tools' : 'Applying changes';
  }

  if (loopState === 'completing') {
    return 'Finalizing';
  }

  if (loopState === 'running') {
    return 'Thinking';
  }

  return null;
}
