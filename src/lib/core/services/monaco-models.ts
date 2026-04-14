import type * as Monaco from 'monaco-editor';

import { loadMonaco, getMonaco } from '$core/services/monaco-loader';

// ============================================================================
// LRU Cache for Monaco Models
// ============================================================================

// Maximum number of models to keep in memory
// Beyond this, least recently used models are evicted
const MAX_MODELS = 50;

// Track model access order for LRU eviction
// Most recently accessed at the end
const accessOrder: string[] = [];

const models = new Map<string, Monaco.editor.ITextModel>();

const reviewDecorations = new Map<string, string[]>();

/**
 * Mark a model as recently accessed (move to end of LRU list)
 */
function touchModel(path: string): void {
  const idx = accessOrder.indexOf(path);
  if (idx !== -1) {
    accessOrder.splice(idx, 1);
  }
  accessOrder.push(path);
}

/**
 * Evict least recently used models if over capacity
 */
function evictIfNeeded(): void {
  while (models.size > MAX_MODELS && accessOrder.length > 0) {
    const oldest = accessOrder.shift();
    if (oldest) {
      const model = models.get(oldest);
      if (model) {
        // Don't evict if model has unsaved changes (dirty)
        // Monaco doesn't track dirty state, so we just evict
        // The editor store tracks dirty state separately
        model.dispose();
        models.delete(oldest);
      }
    }
  }
}

export function normalizeModelPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function uriForPath(monaco: typeof Monaco, path: string): Monaco.Uri {
  const normalizedPath = normalizeModelPath(path);
  // Use an in-memory URI so we don't have to deal with file:// + Windows path encoding.
  return monaco.Uri.parse(`inmemory://model/${encodeURIComponent(normalizedPath)}`);
}

export interface ModelSpec {
  path: string;
  content: string;
  language: string;
}

export async function getOrCreateModel(spec: ModelSpec): Promise<Monaco.editor.ITextModel> {
  const monaco = await loadMonaco();
  const normalizedPath = normalizeModelPath(spec.path);

  const existing = models.get(normalizedPath);
  if (existing) {
    if (existing.isDisposed()) {
      models.delete(normalizedPath);
    } else {
      monaco.editor.setModelLanguage(existing, spec.language);
      touchModel(normalizedPath);
      return existing;
    }
  }

  const uri = uriForPath(monaco, normalizedPath);
  const already = monaco.editor.getModel(uri);
  if (already) {
    if (already.isDisposed()) {
      models.delete(normalizedPath);
    } else {
      models.set(normalizedPath, already);
      touchModel(normalizedPath);
      monaco.editor.setModelLanguage(already, spec.language);
      return already;
    }
  }

  // Evict old models before creating new one
  evictIfNeeded();

  const model = monaco.editor.createModel(spec.content, spec.language, uri);
  models.set(normalizedPath, model);
  touchModel(normalizedPath);
  return model;
}

export function getModel(path: string): Monaco.editor.ITextModel | null {
  const normalizedPath = normalizeModelPath(path);
  const model = models.get(normalizedPath) ?? null;
  if (!model) return null;
  if (!model.isDisposed()) return model;

  models.delete(normalizedPath);
  return null;
}

export function getModelValue(path: string): string | null {
  const normalizedPath = normalizeModelPath(path);
  const model = models.get(normalizedPath);
  if (!model || model.isDisposed()) {
    if (model?.isDisposed()) models.delete(normalizedPath);
    return null;
  }
  return model.getValue();
}

/**
 * Set the value of a model (used for formatting)
 * Preserves undo history by using pushEditOperations
 */
export function setModelValue(path: string, value: string): boolean {
  const normalizedPath = normalizeModelPath(path);

  // Try to find model with various path formats
  let model = models.get(normalizedPath);

  if (!model) {
    // Try to find by suffix match
    for (const [modelPath, m] of models.entries()) {
      if (modelPath.endsWith(normalizedPath) || normalizedPath.endsWith(modelPath)) {
        model = m;
        break;
      }
    }
  }

  if (!model) {
    // Model doesn't exist - create it if we have Monaco available
    const monaco = getMonaco();
    if (!monaco) return false;

    const uri = uriForPath(monaco, normalizedPath);
    model = monaco.editor.createModel(value, undefined, uri);
    models.set(normalizedPath, model);
    touchModel(normalizedPath);
    console.log('[monaco-models] Created new model for:', normalizedPath);
    return true;
  }

  // Handle disposed models - recreate them
  if (model.isDisposed()) {
    models.delete(normalizedPath);
    const monaco = getMonaco();
    if (!monaco) return false;

    const uri = uriForPath(monaco, normalizedPath);
    model = monaco.editor.createModel(value, undefined, uri);
    models.set(normalizedPath, model);
    touchModel(normalizedPath);
    console.log('[monaco-models] Recreated disposed model for:', normalizedPath);
    return true;
  }

  if (model.getValue() === value) {
    return false;
  }

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
  const normalizedPath = normalizeModelPath(path);
  const model = models.get(normalizedPath);
  if (!model) return;
  model.dispose();
  models.delete(normalizedPath);

  // Remove from LRU tracking
  const idx = accessOrder.indexOf(normalizedPath);
  if (idx !== -1) {
    accessOrder.splice(idx, 1);
  }
}

export function disposeAllModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();

  // Clear LRU tracking
  accessOrder.length = 0;
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
 * Get the active editor instance
 */
export function getActiveEditor(): Monaco.editor.IStandaloneCodeEditor | null {
  return activeEditor;
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
  const normalizedPath = normalizeModelPath(path);
  const model = models.get(normalizedPath);
  if (!model || model.isDisposed()) {
    if (model?.isDisposed()) models.delete(normalizedPath);
    return 0;
  }
  return model.getLineCount();
}

/**
 * Reveal a specific line in the active editor
 */
export function revealLine(path: string, line: number): void {
  const normalizedPath = normalizeModelPath(path);
  const model = models.get(normalizedPath);
  if (!model || model.isDisposed() || !activeEditor) {
    if (model?.isDisposed()) models.delete(normalizedPath);
    return;
  }

  // Ensure line is within bounds
  const maxLine = model.getLineCount();
  const targetLine = Math.max(1, Math.min(line, maxLine));

  // Set cursor position and reveal the line
  activeEditor.setPosition({ lineNumber: targetLine, column: 1 });
  activeEditor.revealLineInCenter(targetLine);
  activeEditor.focus();
}

/**
 * Set the selection in the active editor
 */
export function setSelection(path: string, range: {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}): void {
  const normalizedPath = normalizeModelPath(path);
  const model = models.get(normalizedPath);
  if (!model || model.isDisposed() || !activeEditor) {
    if (model?.isDisposed()) models.delete(normalizedPath);
    return;
  }

  const maxLine = model.getLineCount();
  const startLine = Math.max(1, Math.min(range.startLine, maxLine));
  const endLine = Math.max(1, Math.min(range.endLine, maxLine));

  activeEditor.setSelection({
    startLineNumber: startLine,
    startColumn: range.startColumn,
    endLineNumber: endLine,
    endColumn: range.endColumn
  });
  activeEditor.revealRangeInCenter({
    startLineNumber: startLine,
    startColumn: range.startColumn,
    endLineNumber: endLine,
    endColumn: range.endColumn
  });
  activeEditor.focus();
}

export function setReviewHighlight(path: string, startLine: number, endLine: number): boolean {
  // Try to find model with various path formats
  const normalizedPath = normalizeModelPath(path);
  let model = models.get(normalizedPath);
  let actualPath = normalizedPath;

  if (!model) {
    // Try to find by suffix match
    for (const [modelPath, m] of models.entries()) {
      if (modelPath.endsWith(normalizedPath) || normalizedPath.endsWith(modelPath)) {
        model = m;
        actualPath = modelPath;
        break;
      }
    }
  }

  if (!model || model.isDisposed()) {
    if (model?.isDisposed()) models.delete(actualPath);
    if (models.size > 0) {
      console.debug('[setReviewHighlight] Model not ready for path:', path);
    }
    return false;
  }

  const maxLine = model.getLineCount();
  const start = Math.max(1, Math.min(startLine, maxLine));
  const end = Math.max(start, Math.min(endLine, maxLine));
  const old = reviewDecorations.get(actualPath) ?? [];

  const endCol = model.getLineMaxColumn(end);
  const next = model.deltaDecorations(old, [
    {
      range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: endCol },
      options: {
        isWholeLine: true,
        className: 'ai-edit-highlight',
        // Also add line decoration for better visibility
        linesDecorationsClassName: 'ai-edit-line-decoration'
      }
    }
  ]);

  reviewDecorations.set(actualPath, next);
  console.log('[setReviewHighlight] Applied highlight to', actualPath, 'lines', start, '-', end, 'decorationIds:', next);
  return true;
}

export function clearReviewHighlight(path: string): void {
  // Try to find model with various path formats
  const normalizedPath = normalizeModelPath(path);
  let model = models.get(normalizedPath);
  let actualPath = normalizedPath;

  if (!model) {
    for (const [modelPath, m] of models.entries()) {
      if (modelPath.endsWith(normalizedPath) || normalizedPath.endsWith(modelPath)) {
        model = m;
        actualPath = modelPath;
        break;
      }
    }
  }

  const old = reviewDecorations.get(actualPath);
  if (model && old && old.length > 0) {
    model.deltaDecorations(old, []);
  }
  reviewDecorations.delete(actualPath);
}

/**
 * Get the current selection from the active editor
 * Returns the selected text, file path, and selection range
 */
export function getEditorSelection(): {
  text: string;
  path: string | null;
  range?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
} | null {
  if (!activeEditor) return null;

  const selection = activeEditor.getSelection();
  if (!selection || selection.isEmpty()) return null;

  const model = activeEditor.getModel();
  if (!model || model.isDisposed()) return null;

  const text = model.getValueInRange(selection);

  // Find the path for this model
  let path: string | null = null;
  for (const [p, m] of models.entries()) {
    if (m === model) {
      path = p;
      break;
    }
  }

  return {
    text,
    path,
    range: {
      startLineNumber: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLineNumber: selection.endLineNumber,
      endColumn: selection.endColumn
    }
  };
}
