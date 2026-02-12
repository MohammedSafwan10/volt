/**
 * Auto-save service
 * Handles automatic file saving with debouncing
 * 
 * Triggers:
 * - After typing stops (configurable delay, default 1 second)
 * - On tab switch
 * - On window blur
 * 
 * Features:
 * - Optional format on save using Prettier
 */

import { editorStore } from '$lib/stores/editor.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';
import { writeFile } from '$lib/services/file-system';
import { formatBeforeSave, isPrettierFile } from '$lib/services/prettier';
import { getModelValue, setModelValue } from '$lib/services/monaco-models';

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isInitialized = false;

/**
 * Save a specific file if it has unsaved changes
 * Optionally formats the file before saving if format on save is enabled
 */
async function saveFile(path: string, skipFormat = false): Promise<boolean> {
  const file = editorStore.openFiles.find(f => f.path === path);
  if (!file) return false;
  
  // Only save if dirty
  if (!editorStore.isDirty(path)) return true;
  
  // Get the latest content from Monaco model if available.
  let contentToSave = file.content;
  const modelValue = getModelValue(path);
  if (typeof modelValue === 'string') {
    contentToSave = modelValue;
  }

  // Format on save if enabled and file is supported.
  if (!skipFormat && settingsStore.formatOnSaveEnabled && isPrettierFile(path)) {
    const formatted = await formatBeforeSave(contentToSave, path);
    if (formatted !== contentToSave) {
      contentToSave = formatted;
      setModelValue(path, formatted);
    }
  }

  editorStore.updateContent(path, contentToSave);
  
  const success = await writeFile(path, contentToSave);
  if (success) {
    editorStore.markSaved(path);
  }
  return success;
}

/**
 * Save the currently active file if it has unsaved changes
 */
async function saveActiveFile(): Promise<void> {
  if (!settingsStore.autoSaveEnabled) return;
  
  const activePath = editorStore.activeFilePath;
  if (!activePath) return;
  
  await saveFile(activePath);
}

/**
 * Save all dirty files
 */
async function saveAllDirtyFiles(): Promise<void> {
  if (!settingsStore.autoSaveEnabled) return;
  
  const dirtyFiles = editorStore.openFiles.filter(f => editorStore.isDirty(f.path));
  
  for (const file of dirtyFiles) {
    await saveFile(file.path);
  }
}

/**
 * Schedule an auto-save after the configured delay
 * Cancels any pending save timer
 */
export function scheduleAutoSave(): void {
  if (!settingsStore.autoSaveEnabled) return;
  
  // Clear existing timer
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  
  // Schedule new save
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveActiveFile();
  }, settingsStore.autoSaveDelay);
}

/**
 * Cancel any pending auto-save
 */
export function cancelAutoSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/**
 * Trigger immediate auto-save (for tab switch, window blur)
 */
export function triggerImmediateAutoSave(): void {
  if (!settingsStore.autoSaveEnabled) return;
  
  // Cancel pending timer
  cancelAutoSave();
  
  // Save immediately
  void saveActiveFile();
}

/**
 * Handle window blur event - save all dirty files
 */
function handleWindowBlur(): void {
  if (!settingsStore.autoSaveEnabled) return;
  
  // Cancel pending timer
  cancelAutoSave();
  
  // Save all dirty files when window loses focus
  void saveAllDirtyFiles();
}

/**
 * Handle visibility change - save when tab becomes hidden
 */
function handleVisibilityChange(): void {
  if (document.hidden) {
    handleWindowBlur();
  }
}

/**
 * Initialize auto-save event listeners
 * Should be called once when the app starts
 */
export function initAutoSave(): void {
  if (isInitialized) return;
  if (typeof window === 'undefined') return;
  
  window.addEventListener('blur', handleWindowBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  isInitialized = true;
}

/**
 * Cleanup auto-save event listeners
 * Should be called when the app is destroyed
 */
export function destroyAutoSave(): void {
  if (!isInitialized) return;
  if (typeof window === 'undefined') return;
  
  cancelAutoSave();
  
  window.removeEventListener('blur', handleWindowBlur);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  
  isInitialized = false;
}
