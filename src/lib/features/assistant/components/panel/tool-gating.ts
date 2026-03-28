import type { ToolDefinition } from '$core/ai/types';
import { selectTopMcpTools } from '$core/ai/tools/mcp-selector';

export function filterToolsForChat(
  tools: ToolDefinition[],
  query = '',
): ToolDefinition[] {
  const nonMcp = tools.filter((tool) => !tool.name.startsWith('mcp_'));
  const selectedMcp = query.trim().length > 0 ? selectTopMcpTools(tools, query) : [];
  return [...nonMcp, ...selectedMcp];
}
