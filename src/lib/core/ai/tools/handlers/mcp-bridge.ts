type McpStoreModule = typeof import('$features/mcp/stores/mcp.svelte');

async function getMcpStore() {
  const module: McpStoreModule = await import('$features/mcp/stores/mcp.svelte');
  return module.mcpStore;
}

export async function getMcpTools() {
  return (await getMcpStore()).tools;
}

export async function getMcpServerIds(): Promise<string[]> {
  const store = await getMcpStore();
  const ids = new Set<string>();
  for (const { serverId } of store.tools) ids.add(serverId);
  for (const id of store.servers.keys()) ids.add(id);
  for (const id of Object.keys(store.mergedConfig.mcpServers || {})) ids.add(id);
  return Array.from(ids);
}

export async function getMcpMergedConfig() {
  return (await getMcpStore()).mergedConfig;
}

export async function getMcpServer(serverId: string) {
  return (await getMcpStore()).servers.get(serverId);
}

export async function startMcpServer(serverId: string): Promise<void> {
  await (await getMcpStore()).startServer(serverId);
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return (await getMcpStore()).callTool(serverId, toolName, args);
}

export async function isMcpToolAutoApprovedForServer(
  serverId: string,
  toolName: string,
): Promise<boolean> {
  return (await getMcpStore()).isAutoApproved(serverId, toolName);
}
