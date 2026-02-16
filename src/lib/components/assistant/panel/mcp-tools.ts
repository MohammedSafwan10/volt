export interface MappedMcpToolInfo {
  serverId: string;
  toolName: string;
  description: string;
  required?: string[];
  params?: string[];
}

export async function getMcpToolsInfo(): Promise<MappedMcpToolInfo[]> {
  const { mcpStore } = await import('$lib/stores/mcp.svelte');
  return mcpStore.tools.map(({ serverId, tool }) => {
    const inputSchema = (tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> } | undefined) ?? {};
    const required = (inputSchema.required ?? []);
    const params = Object.keys(inputSchema.properties ?? {});
    const description = tool.description || `MCP tool from ${serverId}`;
    const fullDesc =
      required.length > 0
        ? `${description} (Required: ${required.join(', ')})`
        : description;
    return {
      serverId,
      toolName: tool.name,
      description: fullDesc,
      required,
      params,
    };
  });
}
