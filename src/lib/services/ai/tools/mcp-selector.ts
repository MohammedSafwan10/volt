import type { ToolDefinition } from '../types';

const DEFAULT_MAX_MCP_TOOLS = 12;

function normalize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreTool(queryTokens: string[], tool: ToolDefinition): number {
  if (queryTokens.length === 0) return 0;
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (tool.name.toLowerCase().includes(token)) score += 5;
    if (haystack.includes(token)) score += 2;
  }
  return score;
}

export function selectTopMcpTools(
  tools: ToolDefinition[],
  query: string,
  limit = DEFAULT_MAX_MCP_TOOLS,
): ToolDefinition[] {
  const mcpTools = tools.filter((tool) => tool.name.startsWith('mcp_'));
  if (mcpTools.length <= limit) {
    return mcpTools;
  }

  const q = query.trim();
  if (!q) {
    return mcpTools.slice(0, limit);
  }
  const tokens = normalize(q);
  const explicitMentions = new Set<string>();
  for (const tool of mcpTools) {
    if (q.includes(tool.name)) {
      explicitMentions.add(tool.name);
    }
  }

  const ranked = [...mcpTools].sort((a, b) => {
    const aExplicit = explicitMentions.has(a.name) ? 1 : 0;
    const bExplicit = explicitMentions.has(b.name) ? 1 : 0;
    if (aExplicit !== bExplicit) return bExplicit - aExplicit;
    const scoreDiff = scoreTool(tokens, b) - scoreTool(tokens, a);
    if (scoreDiff !== 0) return scoreDiff;
    return a.name.localeCompare(b.name);
  });

  const picked = ranked.slice(0, limit);
  for (const explicit of explicitMentions) {
    if (picked.some((tool) => tool.name === explicit)) continue;
    const idx = ranked.findIndex((tool) => tool.name === explicit);
    if (idx >= 0) {
      picked[picked.length - 1] = ranked[idx];
    }
  }
  return picked;
}
