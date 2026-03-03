import type { ToolDefinition } from '$core/ai/types';
import { selectTopMcpTools } from '$core/ai/tools/mcp-selector';

export function filterToolsForChat(
  tools: ToolDefinition[],
  browserToolsEnabled: boolean,
  query = '',
): ToolDefinition[] {
  const afterBrowserGate = browserToolsEnabled
    ? tools
    : tools.filter((tool) => !tool.name.startsWith('browser_'));

  const nonMcp = afterBrowserGate.filter((tool) => !tool.name.startsWith('mcp_'));
  const selectedMcp = selectTopMcpTools(afterBrowserGate, query);
  return [...nonMcp, ...selectedMcp];
}
