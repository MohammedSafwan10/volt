export interface MappedMcpToolInfo {
  serverId: string;
  toolName: string;
  description: string;
}

export async function getMcpToolsInfo(): Promise<MappedMcpToolInfo[]> {
  const { mcpStore } = await import('$lib/stores/mcp.svelte');
  return mcpStore.tools.map(({ serverId, tool }) => {
    const required = ((tool.inputSchema as { required?: string[] } | undefined)?.required ?? []);
    const description = tool.description || `MCP tool from ${serverId}`;
    const fullDesc =
      required.length > 0
        ? `${description} (Required: ${required.join(', ')})`
        : description;
    return {
      serverId,
      toolName: tool.name,
      description: fullDesc,
    };
  });
}
