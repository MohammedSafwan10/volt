import type { AIMode } from '$lib/stores/ai.svelte';
import {
  getToolByName,
  getToolsForMode,
  type ToolCategory,
} from '../tools/definitions';
import { BROWSER_GUIDANCE } from './browser';
import { DIAGNOSTICS_GUIDANCE } from './diagnostics';
import { EDITOR_CONTEXT_GUIDANCE } from './editor-context';
import { FILE_WRITE_GUIDANCE } from './file-write';
import { TERMINAL_GUIDANCE } from './terminal';
import { WORKSPACE_READ_GUIDANCE } from './workspace-read';
import { WORKSPACE_SEARCH_GUIDANCE } from './workspace-search';

const CATEGORY_ORDER: ToolCategory[] = [
  'workspace_read',
  'workspace_search',
  'editor_context',
  'file_write',
  'terminal',
  'diagnostics',
  'browser',
];

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  workspace_read: 'Workspace Read',
  workspace_search: 'Workspace Search',
  editor_context: 'Editor Context',
  file_write: 'File Write',
  terminal: 'Terminal',
  diagnostics: 'Diagnostics',
  browser: 'Browser',
};

const CATEGORY_GUIDANCE: Record<ToolCategory, string> = {
  workspace_read: WORKSPACE_READ_GUIDANCE,
  workspace_search: WORKSPACE_SEARCH_GUIDANCE,
  editor_context: EDITOR_CONTEXT_GUIDANCE,
  file_write: FILE_WRITE_GUIDANCE,
  terminal: TERMINAL_GUIDANCE,
  diagnostics: DIAGNOSTICS_GUIDANCE,
  browser: BROWSER_GUIDANCE,
};

function getRequiredArgs(parameters: Record<string, unknown>): string[] {
  const required = parameters.required;
  if (!Array.isArray(required)) return [];
  return required.filter((x): x is string => typeof x === 'string');
}

export function buildCategoryToolGuidance(mode: AIMode): string {
  const byCategory = new Map<ToolCategory, Array<{ name: string; required: string[] }>>();

  for (const tool of getToolsForMode(mode)) {
    const definition = getToolByName(tool.name);
    if (!definition) continue;

    const current = byCategory.get(definition.category) || [];
    current.push({
      name: tool.name,
      required: getRequiredArgs(tool.parameters as Record<string, unknown>),
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
        return `- \`${tool.name}\`${required}`;
      })
      .join('\n');

    parts.push(
      `## ${CATEGORY_LABELS[category]}\n${CATEGORY_GUIDANCE[category]}\n\nAvailable:\n${formattedTools}`,
    );
  }

  return parts.join('\n\n');
}

