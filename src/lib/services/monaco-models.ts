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
