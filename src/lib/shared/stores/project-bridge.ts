export async function cleanupMcpStore(): Promise<void> {
  const { mcpStore } = await import('$features/mcp/stores/mcp.svelte');
  await mcpStore.cleanup();
}

export async function initializeMcpStore(rootPath: string): Promise<void> {
  const { mcpStore } = await import('$features/mcp/stores/mcp.svelte');
  await mcpStore.initialize(rootPath);
}

export async function closeAllEditorFiles(force = false): Promise<void> {
  const { editorStore } = await import('$features/editor/stores/editor.svelte');
  editorStore.closeAllFiles(force);
}

export async function cleanupEditorStore(): Promise<void> {
  const { disposeEditorStore } = await import('$features/editor/stores/editor.svelte');
  disposeEditorStore();
}

export async function reloadEditorFile(path: string): Promise<void> {
  const { editorStore } = await import('$features/editor/stores/editor.svelte');
  await editorStore.reloadFile(path);
}

export async function hasOpenEditorFile(path: string): Promise<boolean> {
  const { editorStore } = await import('$features/editor/stores/editor.svelte');
  return editorStore.openFiles.some((file) => file.path === path);
}

export async function resetGitStore(): Promise<void> {
  const { gitStore } = await import('$features/git/stores/git.svelte');
  gitStore.reset();
}

export async function initGitStore(rootPath: string): Promise<void> {
  const { gitStore } = await import('$features/git/stores/git.svelte');
  await gitStore.init(rootPath);
}
