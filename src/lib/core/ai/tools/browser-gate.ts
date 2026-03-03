export function isBrowserToolBlocked(
  toolName: string,
  browserToolsEnabled: boolean,
): boolean {
  return toolName.startsWith('browser_') && !browserToolsEnabled;
}
