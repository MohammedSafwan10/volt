import type { AIMode } from '$lib/stores/ai.svelte';
import { buildAgentPrompt } from './prompt-agent';
import { buildAskPrompt } from './prompt-ask';
import { buildPlanPrompt } from './prompt-plan';
import {
  buildMcpSection,
  PROVIDER_GEMINI,
  type McpToolInfo,
  type PromptProvider,
} from './prompt-shared';

export type AIProvider = PromptProvider;
export type { McpToolInfo };
export { buildMcpSection, PROVIDER_GEMINI };

export interface SystemPromptOptions {
  mode: AIMode;
  provider: AIProvider;
  model: string;
  workspaceRoot?: string;
  mcpTools?: McpToolInfo[];
}

export function getSystemPrompt(options: SystemPromptOptions): string {
  const { mode, provider, workspaceRoot, mcpTools } = options;

  if (mode === 'ask') {
    return buildAskPrompt({ provider, workspaceRoot, mcpTools });
  }
  if (mode === 'plan') {
    return buildPlanPrompt({ provider, workspaceRoot, mcpTools });
  }

  return buildAgentPrompt({ provider, workspaceRoot, mcpTools });
}

export function getModeDescription(mode: AIMode): string {
  switch (mode) {
    case 'ask':
      return 'Read-only for questions';
    case 'plan':
      return 'Planning mode';
    case 'agent':
      return 'Full agent access';
    default:
      return '';
  }
}

export function isToolAllowedInMode(toolName: string, mode: AIMode): boolean {
  const askAndPlan = ['list_dir', 'read_file', 'workspace_search', 'get_diagnostics'];
  const agent = [
    ...askAndPlan,
    'apply_patch',
    'run_command',
    'attempt_completion',
  ];

  if (mode === 'ask' || mode === 'plan') return askAndPlan.includes(toolName);
  if (mode === 'agent') return agent.includes(toolName) || toolName.startsWith('mcp_');
  return false;
}

export function toolRequiresApproval(toolName: string, mode: AIMode): boolean {
  if (mode === 'ask' || mode === 'plan') return false;
  return toolName === 'run_command';
}

export function getToolRiskLevel(toolName: string): 'low' | 'medium' | 'high' {
  if (toolName === 'run_command') return 'high';
  if (toolName === 'apply_patch') return 'medium';
  return 'low';
}
