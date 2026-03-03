/**
 * TypeScript LSP Service
 * 
 * Monaco Editor has built-in TypeScript support through its TypeScript worker.
 * This module provides additional TypeScript-specific functionality:
 * - Go to definition
 * - Find references
 * - Hover information
 * - Quick fixes
 * 
 * Note: Monaco's built-in TypeScript features work automatically.
 * This module provides programmatic access to these features.
 */

import type * as Monaco from 'monaco-editor';
import { getMonaco } from '$core/services/monaco-loader';

/**
 * Go to definition for the current cursor position
 * Uses Monaco's built-in editor action
 */
export function goToDefinition(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.revealDefinition', {});
}

/**
 * Peek definition (shows inline preview)
 */
export function peekDefinition(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.peekDefinition', {});
}

/**
 * Go to type definition
 */
export function goToTypeDefinition(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.goToTypeDefinition', {});
}

/**
 * Go to implementation
 */
export function goToImplementation(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.goToImplementation', {});
}

/**
 * Find all references
 */
export function findReferences(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.referenceSearch.trigger', {});
}

/**
 * Peek references (shows inline preview)
 */
export function peekReferences(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.peekReferences', {});
}

/**
 * Trigger autocomplete at the current position
 */
export function triggerAutocomplete(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
}

/**
 * Trigger parameter hints
 */
export function triggerParameterHints(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.triggerParameterHints', {});
}

/**
 * Show hover information
 */
export function showHover(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.showHover', {});
}

/**
 * Format the document
 */
export async function formatDocument(
  editor: Monaco.editor.IStandaloneCodeEditor
): Promise<void> {
  await editor.getAction('editor.action.formatDocument')?.run();
}

/**
 * Format the selection
 */
export async function formatSelection(
  editor: Monaco.editor.IStandaloneCodeEditor
): Promise<void> {
  await editor.getAction('editor.action.formatSelection')?.run();
}

/**
 * Rename symbol at current position
 */
export function triggerRename(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.rename', {});
}

/**
 * Show quick fixes (code actions)
 */
export function showQuickFixes(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.quickFix', {});
}

/**
 * Organize imports
 */
export async function organizeImports(
  editor: Monaco.editor.IStandaloneCodeEditor
): Promise<void> {
  await editor.getAction('editor.action.organizeImports')?.run();
}

/**
 * Add missing imports
 */
export async function addMissingImports(
  editor: Monaco.editor.IStandaloneCodeEditor
): Promise<void> {
  await editor.getAction('source.addMissingImports')?.run();
}

/**
 * Navigate to a specific position in the editor
 */
export function navigateToPosition(
  editor: Monaco.editor.IStandaloneCodeEditor,
  line: number,
  column: number
): void {
  editor.setPosition({ lineNumber: line, column });
  editor.revealPositionInCenter({ lineNumber: line, column });
  editor.focus();
}

/**
 * Get the current word at cursor position
 */
export function getWordAtPosition(
  editor: Monaco.editor.IStandaloneCodeEditor
): string | null {
  const monaco = getMonaco();
  if (!monaco) return null;

  const model = editor.getModel();
  if (!model) return null;

  const position = editor.getPosition();
  if (!position) return null;

  const word = model.getWordAtPosition(position);
  return word?.word ?? null;
}

/**
 * Get all markers (diagnostics) for the current model
 */
export function getModelMarkers(
  editor: Monaco.editor.IStandaloneCodeEditor
): Monaco.editor.IMarker[] {
  const monaco = getMonaco();
  if (!monaco) return [];

  const model = editor.getModel();
  if (!model) return [];

  return monaco.editor.getModelMarkers({ resource: model.uri });
}

/**
 * Check if the current file is a TypeScript/JavaScript file
 */
export function isTypeScriptFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext);
}
