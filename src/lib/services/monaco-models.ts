import type * as Monaco from 'monaco-editor';

import { loadMonaco } from '$lib/services/monaco-loader';

const models = new Map<string, Monaco.editor.ITextModel>();

function uriForPath(monaco: typeof Monaco, path: string): Monaco.Uri {
  // Use an in-memory URI so we don't have to deal with file:// + Windows path encoding.
  return monaco.Uri.parse(`inmemory://model/${encodeURIComponent(path)}`);
}

export interface ModelSpec {
  path: string;
  content: string;
  language: string;
}

export async function getOrCreateModel(spec: ModelSpec): Promise<Monaco.editor.ITextModel> {
  const monaco = await loadMonaco();

  const existing = models.get(spec.path);
  if (existing) {
    monaco.editor.setModelLanguage(existing, spec.language);
    return existing;
  }

  const uri = uriForPath(monaco, spec.path);
  const already = monaco.editor.getModel(uri);
  if (already) {
    models.set(spec.path, already);
    monaco.editor.setModelLanguage(already, spec.language);
    return already;
  }

  const model = monaco.editor.createModel(spec.content, spec.language, uri);
  models.set(spec.path, model);
  return model;
}

export function getModel(path: string): Monaco.editor.ITextModel | null {
  return models.get(path) ?? null;
}

export function getModelValue(path: string): string | null {
  const model = models.get(path);
  return model ? model.getValue() : null;
}

/**
 * Set the value of a model (used for formatting)
 * Preserves undo history by using pushEditOperations
 */
export function setModelValue(path: string, value: string): boolean {
  const model = models.get(path);
  if (!model) return false;
  
  // Use pushEditOperations to preserve undo history
  const fullRange = model.getFullModelRange();
  model.pushEditOperations(
    [],
    [{ range: fullRange, text: value }],
    () => null
  );
  
  return true;
}

export function disposeModel(path: string): void {
  const model = models.get(path);
  if (!model) return;
  model.dispose();
  models.delete(path);
}

export function disposeAllModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}

// Editor instance reference for go-to-line functionality
let activeEditor: Monaco.editor.IStandaloneCodeEditor | null = null;

/**
 * Set the active editor instance (called from MonacoEditor component)
 */
export function setActiveEditor(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
  activeEditor = editor;
}

/**
 * Run a Monaco editor action on the active editor.
 * Useful for invoking built-in UI like Quick Outline.
 */
export async function runEditorAction(actionId: string): Promise<boolean> {
  // Ensure Monaco is loaded (mainly so editor actions exist)
  await loadMonaco();
  if (!activeEditor) return false;

  const action = activeEditor.getAction(actionId);
  if (!action) return false;

  try {
    await action.run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the line count of a model
 */
export function getModelLineCount(path: string): number {
  const model = models.get(path);
  return model ? model.getLineCount() : 0;
}

/**
 * Reveal a specific line in the active editor
 */
export function revealLine(path: string, line: number): void {
  const model = models.get(path);
  if (!model || !activeEditor) return;
  
  // Ensure line is within bounds
  const maxLine = model.getLineCount();
  const targetLine = Math.max(1, Math.min(line, maxLine));
  
  // Set cursor position and reveal the line
  activeEditor.setPosition({ lineNumber: targetLine, column: 1 });
  activeEditor.revealLineInCenter(targetLine);
  activeEditor.focus();
}
