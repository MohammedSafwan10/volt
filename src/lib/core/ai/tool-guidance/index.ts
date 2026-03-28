import type { AIMode } from '$features/assistant/stores/ai.svelte';
import {
  getToolByName,
  getToolsForMode,
  type ToolCategory,
} from '$core/ai/tools/definitions';
import { DIAGNOSTICS_GUIDANCE } from '$core/ai/tool-guidance/diagnostics';
import { FILE_WRITE_GUIDANCE } from '$core/ai/tool-guidance/file-write';
import { TERMINAL_GUIDANCE } from '$core/ai/tool-guidance/terminal';
import { WORKFLOW_GUIDANCE } from '$core/ai/tool-guidance/workflow';
import { WORKSPACE_READ_GUIDANCE } from '$core/ai/tool-guidance/workspace-read';
import { WORKSPACE_SEARCH_GUIDANCE } from '$core/ai/tool-guidance/workspace-search';

const CATEGORY_ORDER: ToolCategory[] = [
  'workspace_read',
  'workspace_search',
  'file_write',
  'terminal',
  'diagnostics',
  'workflow',
];

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  workspace_read: 'Workspace Read',
  workspace_search: 'Workspace Search',
  file_write: 'File Write',
  terminal: 'Terminal',
  diagnostics: 'Diagnostics',
  workflow: 'Workflow',
};

const CATEGORY_GUIDANCE: Record<ToolCategory, string> = {
  workspace_read: WORKSPACE_READ_GUIDANCE,
  workspace_search: WORKSPACE_SEARCH_GUIDANCE,
  file_write: FILE_WRITE_GUIDANCE,
  terminal: TERMINAL_GUIDANCE,
  diagnostics: DIAGNOSTICS_GUIDANCE,
  workflow: WORKFLOW_GUIDANCE,
};

function getRequiredArgs(parameters: Record<string, unknown>): string[] {
  const required = parameters.required;
  if (!Array.isArray(required)) return [];
  return required.filter((x): x is string => typeof x === 'string');
}

function inferParamHint(paramSchema: unknown): string {
  if (!paramSchema || typeof paramSchema !== 'object') return 'value';
  const entry = paramSchema as Record<string, unknown>;
  const type = typeof entry.type === 'string' ? entry.type : 'value';
  if (type === 'string') return '"..."';
  if (type === 'number' || type === 'integer') return '0';
  if (type === 'boolean') return 'false';
  if (type === 'array') return '[...]';
  if (type === 'object') return '{...}';
  return 'value';
}

function buildToolExample(
  toolName: string,
  requiredArgs: string[],
  parameters: Record<string, unknown>,
): string | null {
  if (requiredArgs.length === 0) return `${toolName}()`;
  const properties =
    parameters.properties && typeof parameters.properties === 'object'
      ? (parameters.properties as Record<string, unknown>)
      : {};
  const args = requiredArgs
    .slice(0, 3)
    .map((arg) => `${arg}: ${inferParamHint(properties[arg])}`);
  return `${toolName}({ ${args.join(', ')} })`;
}

export function buildCategoryToolGuidance(mode: AIMode): string {
  const byCategory = new Map<
    ToolCategory,
    Array<{ name: string; required: string[]; example: string | null }>
  >();

  for (const tool of getToolsForMode(mode)) {
    const definition = getToolByName(tool.name);
    if (!definition) continue;

    const current = byCategory.get(definition.category) || [];
    const parameters = tool.parameters as Record<string, unknown>;
    const required = getRequiredArgs(parameters);
    current.push({
      name: tool.name,
      required,
      example: buildToolExample(tool.name, required, parameters),
    });
    byCategory.set(definition.category, current);
  }

  const parts: string[] = ['# CATEGORY TOOL GUIDANCE'];

  for (const category of CATEGORY_ORDER) {
    const tools = byCategory.get(category);
    if (!tools || tools.length === 0) continue;

    const formattedTools = tools
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => {
        const required =
          tool.required.length > 0 ? ` (required: ${tool.required.join(', ')})` : '';
        const example = tool.example ? ` e.g. \`${tool.example}\`` : '';
        return `- \`${tool.name}\`${required}${example}`;
      })
      .join('\n');

    parts.push(
      `## ${CATEGORY_LABELS[category]}\n${CATEGORY_GUIDANCE[category]}\n\nAvailable:\n${formattedTools}`,
    );
  }

  return parts.join('\n\n');
}
