export interface EditorLifecycleTarget {
  matches: (path: string) => boolean;
  close?: (path: string) => Promise<void>;
  save?: (path: string, content: string) => Promise<void>;
}

export function notifyEditorDidClose(
  path: string,
  targets: EditorLifecycleTarget[],
  onError: (label: string, error: unknown) => void,
): void {
  for (const target of targets) {
    if (!target.close || !target.matches(path)) continue;
    void target.close(path).catch((error) => onError(`didClose ${path}`, error));
  }
}

export function notifyEditorDidSave(
  path: string,
  content: string,
  targets: EditorLifecycleTarget[],
  onError: (label: string, error: unknown) => void,
): void {
  for (const target of targets) {
    if (!target.save || !target.matches(path)) continue;
    void target.save(path, content).catch((error) => onError(`didSave ${path}`, error));
  }
}
