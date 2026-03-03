export type PromptProvider = 'gemini' | 'openrouter' | 'anthropic' | 'openai' | 'mistral';

export interface McpToolInfo {
  serverId: string;
  toolName: string;
  description?: string;
  required?: string[];
  params?: string[];
}

export const PROVIDER_GEMINI = `# GEMINI GUIDELINES

- Call tools immediately when needed
- Always respond after tool results
- If incomplete, continue to next step
- Never go silent`;

export function buildProviderOverlay(provider: PromptProvider): string | null {
  return provider === 'gemini' ? PROVIDER_GEMINI : null;
}

export function buildMcpSection(mcpTools: McpToolInfo[]): string {
  const byServer = new Map<string, McpToolInfo[]>();

  for (const tool of mcpTools) {
    const existing = byServer.get(tool.serverId) || [];
    existing.push(tool);
    byServer.set(tool.serverId, existing);
  }

  let section = `# MCP TOOLS\n\nYou have access to ${mcpTools.length} external tools from MCP servers.\n\nMCP call rules:\n- Use exact tool names and exact parameter keys.\n- Never call an MCP tool with empty arguments when required fields exist.\n- If a required field is unknown, gather it first (list_dir/workspace_search/read_file), then call once with valid args.\n- Do not repeat the same invalid MCP call.\n\n`;

  for (const [serverId, tools] of byServer) {
    section += `### Server: ${serverId}\n`;
    for (const t of tools) {
      const toolFullName = `mcp_${serverId}_${t.toolName.replace(/-/g, '_')}`;
      const required = t.required && t.required.length > 0 ? t.required.join(', ') : 'none';
      const params = t.params && t.params.length > 0 ? t.params.join(', ') : 'none';
      section += `- **${toolFullName}**: ${t.description || 'No description provided.'}\n`;
      section += `  Required: ${required}\n`;
      section += `  Params: ${params}\n`;
    }
    section += '\n';
  }

  return section;
}
