export async function openFileInEditor(path: string): Promise<boolean> {
  const { editorStore } = await import('./editor.svelte');
  return editorStore.openFile(path);
}
