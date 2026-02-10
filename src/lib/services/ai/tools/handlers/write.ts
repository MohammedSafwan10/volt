/**
 * File write tool handlers - write_file, append_file, str_replace, create_dir, delete_file, rename_path
 * 
 * SaaS-Ready Architecture:
 * - Uses UnifiedFileService as single source of truth
 * - Version-based conflict detection (optimistic locking)
 * - Event-driven updates to all components
 * - Auto-diagnostics after edits
 * - Zero desync between components
 */

import { invoke } from '@tauri-apps/api/core';
import { projectStore } from '$lib/stores/project.svelte';
import { editorStore } from '$lib/stores/editor.svelte';
import { fileService } from '$lib/services/file-service';
import { resolvePath, extractErrorMessage, isSameOrSuffixPath, calculateDiffStats, type ToolResult } from '../utils';

interface PostEditProblem {
  id: string;
  file: string;
  fileName: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: string;
  source: string;
  code?: string;
  relativePath: string;
}

interface PostEditDiagnosticsResult {
  errorCount: number;
  warningCount: number;
  fileCount: number;
  problems: PostEditProblem[];
}

const POST_EDIT_DIAGNOSTICS_CACHE_MS = 4000;
const EMPTY_DIAGNOSTICS: PostEditDiagnosticsResult = {
  errorCount: 0,
  warningCount: 0,
  fileCount: 0,
  problems: [],
};
const postEditDiagnosticsCache = new Map<string, {
  timestamp: number;
  result: PostEditDiagnosticsResult;
  inFlight?: Promise<PostEditDiagnosticsResult>;
}>();

/**
 * Read file using unified file service
 * Ensures we always get the latest content from single source of truth
 */
async function readFileFresh(path: string): Promise<string> {
  const doc = await fileService.read(path, true);  // Force refresh from disk
  if (!doc) {
    throw new Error(`File not found: ${path}`);
  }
  return doc.content;
}

/**
 * Write file using unified file service with verification
 * Returns result with version tracking
 */
async function writeFileWithSync(path: string, content: string, expectedVersion?: number): Promise<{ success: boolean; error?: string; newVersion?: number }> {
  const result = await fileService.write(path, content, {
    expectedVersion,
    source: 'ai',
    force: expectedVersion === undefined  // Force if no version check requested
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true, newVersion: result.newVersion };
}

/**
 * Sync editor with file service (lightweight - file service handles the heavy lifting)
 */
async function syncEditorWithDisk(path: string, normalizedPath: string, content: string): Promise<void> {
  try {
    // Update Monaco model directly (handles disposed models)
    const { setModelValue } = await import('$lib/services/monaco-models');
    setModelValue(normalizedPath, content);

    // Reload in editor store
    const existing = editorStore.openFiles.find(f =>
      f.path === path || f.path === normalizedPath ||
      f.path.endsWith('/' + path.split(/[/\\]/).pop()) ||
      f.path.endsWith('\\' + path.split(/[/\\]/).pop())
    );

    if (existing) {
      existing.content = content;
      existing.originalContent = content;
      await editorStore.reloadFile(existing.path);
    }
  } catch (err) {
    console.error('[write] Error syncing editor:', err);
  }
}

/**
 * Get diagnostics for a file after edit
 * Returns error count for UI and detailed errors for AI
 * Includes TypeScript, ESLint, Svelte, Dart, and other LSP diagnostics
 */
async function getPostEditDiagnostics(absolutePath: string, relativePath: string): Promise<{
  errorCount: number;
  warningCount: number;
  fileCount: number;
  problems: PostEditProblem[];
}> {
  const now = Date.now();
  const cached = postEditDiagnosticsCache.get(absolutePath);
  if (cached?.inFlight) {
    return cached.inFlight;
  }
  if (cached && now - cached.timestamp < POST_EDIT_DIAGNOSTICS_CACHE_MS) {
    return cached.result;
  }

  const run = async (): Promise<PostEditDiagnosticsResult> => {
  try {
    // Notify LSPs of the file change based on file type
    const ext = absolutePath.split('.').pop()?.toLowerCase() || '';
    const doc = await fileService.read(absolutePath, true);
    const latestContent = doc?.content;

    // 1. Notify TypeScript/JavaScript/ESLint
    if (latestContent && ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext)) {
      try {
        // TypeScript
        const { notifyDocumentChanged } = await import('$lib/services/lsp/typescript-sidecar');
        await notifyDocumentChanged(absolutePath, latestContent);

        // ESLint
        const { notifyEslintDocumentChanged } = await import('$lib/services/lsp/eslint-sidecar');
        await notifyEslintDocumentChanged(absolutePath, latestContent);
      } catch {
        // Continue anyway
      }
    }

    // 2. Notify Svelte
    if (latestContent && ext === 'svelte') {
      try {
        const { notifySvelteDocumentChanged } = await import('$lib/services/lsp/svelte-sidecar');
        await notifySvelteDocumentChanged(absolutePath, latestContent);
      } catch { }
    }

    // 3. Notify HTML
    if (latestContent && ['html', 'htm'].includes(ext)) {
      try {
        const { notifyHtmlDocumentChanged } = await import('$lib/services/lsp/html-sidecar');
        await notifyHtmlDocumentChanged(absolutePath, latestContent);
      } catch { }
    }

    // 4. Notify CSS/SCSS/LESS
    if (latestContent && ['css', 'scss', 'less', 'sass'].includes(ext)) {
      try {
        const { notifyCssDocumentChanged } = await import('$lib/services/lsp/css-sidecar');
        await notifyCssDocumentChanged(absolutePath, latestContent);
      } catch { }
    }

    // 5. Notify JSON
    if (latestContent && ext === 'json') {
      try {
        const { notifyJsonDocumentChanged } = await import('$lib/services/lsp/json-sidecar');
        await notifyJsonDocumentChanged(absolutePath, latestContent);
      } catch { }
    }

    // 6. Notify Dart LSP for Dart files and pubspec.yaml
    if (latestContent && (ext === 'dart' || absolutePath.toLowerCase().endsWith('pubspec.yaml') || absolutePath.toLowerCase().endsWith('analysis_options.yaml'))) {
      try {
        const { notifyDocumentChanged, isDartLspRunning } = await import('$lib/services/lsp/dart-sidecar');
        if (isDartLspRunning()) {
          await notifyDocumentChanged(absolutePath, latestContent);
        }
      } catch { }
    }

    // 7. Notify YAML LSP for YAML files
    if (latestContent && ['yaml', 'yml'].includes(ext)) {
      try {
        const { notifyDocumentChanged, isYamlLspRunning } = await import('$lib/services/lsp/yaml-sidecar');
        if (isYamlLspRunning()) {
          await notifyDocumentChanged(absolutePath, latestContent);
        }
      } catch { }
    }

    // 8. Notify XML LSP for XML and plist files
    if (latestContent && ['xml', 'plist', 'xsd', 'xsl', 'xslt', 'svg'].includes(ext)) {
      try {
        const { notifyDocumentChanged, isXmlLspRunning } = await import('$lib/services/lsp/xml-sidecar');
        if (isXmlLspRunning()) {
          await notifyDocumentChanged(absolutePath, latestContent);
        }
      } catch { }
    }

    // 9. Notify Tailwind
    try {
      const { notifyTailwindDocumentChanged, isTailwindLspConnected } = await import('$lib/services/lsp/tailwind-sidecar');
      if (latestContent && isTailwindLspConnected()) {
        await notifyTailwindDocumentChanged(absolutePath, latestContent);
      }
    } catch { }

    const collectDiagnostics = async (): Promise<PostEditDiagnosticsResult> => {
      const { handleGetDiagnostics } = await import('./diagnostics');
      const result = await handleGetDiagnostics({ paths: [relativePath] });

      if (!result.success) {
        return { errorCount: 0, warningCount: 0, fileCount: 0, problems: [] };
      }

      const meta = (result.meta ?? {}) as {
        errorCount?: number;
        warningCount?: number;
        fileCount?: number;
        problems?: PostEditProblem[];
      };

      return {
        errorCount: meta.errorCount ?? 0,
        warningCount: meta.warningCount ?? 0,
        fileCount: meta.fileCount ?? 0,
        problems: meta.problems ?? [],
      };
    };

    return await collectDiagnostics();
  } catch {
    return EMPTY_DIAGNOSTICS;
  }
  };

  const inFlight = run()
    .then((result) => {
      postEditDiagnosticsCache.set(absolutePath, {
        timestamp: Date.now(),
        result,
      });
      return result;
    })
    .catch(() => EMPTY_DIAGNOSTICS)
    .finally(() => {
      const entry = postEditDiagnosticsCache.get(absolutePath);
      if (entry) {
        delete entry.inFlight;
        postEditDiagnosticsCache.set(absolutePath, entry);
      }
    });

  postEditDiagnosticsCache.set(absolutePath, {
    timestamp: now,
    result: cached?.result ?? EMPTY_DIAGNOSTICS,
    inFlight,
  });
  return inFlight;
}

/**
 * Fix escaped newlines from AI model output
 * Sometimes the AI sends literal "\n" as text instead of actual newlines
 * This converts them back to real newlines
 */
function fixEscapedNewlines(text: string): string {
  // Only fix if the text contains literal \n but no actual newlines
  // This avoids breaking content that legitimately has both
  if (text.includes('\\n') && !text.includes('\n')) {
    return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  // Also handle case where there are very few real newlines but many escaped ones
  const realNewlines = (text.match(/\n/g) || []).length;
  const escapedNewlines = (text.match(/\\n/g) || []).length;
  if (escapedNewlines > realNewlines * 3 && escapedNewlines > 5) {
    return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  return text;
}

/**
 * Write/create a file
 */
export async function handleWriteFile(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, '/');
  const rawContent = String(args.text ?? args.content ?? '');
  const content = fixEscapedNewlines(rawContent);
  const force = args.force === true;

  // ALWAYS read fresh from disk to avoid stale cache issues
  let before = '';
  let isNewFile = false;
  try {
    before = await readFileFresh(path);
  } catch {
    isNewFile = true;
  }

  // Skip write if content is identical (unless force is set)
  // This uses disk content, not Monaco model, to avoid false positives
  if (!isNewFile && !force && before === content) {
    return {
      success: true,
      output: `No changes: ${relativePath}`,
      meta: {
        fileEdit: {
          relativePath,
          absolutePath: path,
          beforeContent: before.length <= 100_000 ? before : null,
          afterContent: content.length <= 100_000 ? content : null,
          isNewFile: false,
          errorCount: 0,
          warningCount: 0
        }
      }
    };
  }

  // Write with verification and retry logic
  const writeResult = await writeFileWithSync(path, content);
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  // Refresh tree if new file
  if (isNewFile) {
    try { await projectStore.refreshTree(); } catch { }
  }

  // Force sync editor with the new disk content
  await syncEditorWithDisk(path, normalizedPath, content);

  // If file wasn't open, open it now
  try {
    const existing = editorStore.openFiles.find(f =>
      f.path === path || f.path === normalizedPath ||
      f.path.endsWith('/' + relativePath) || f.path.endsWith('\\' + relativePath)
    );
    if (!existing) {
      await editorStore.openFile(path);
    }
  } catch { }

  const newLines = content.split('\n').length;
  const oldLines = before.split('\n').length;

  // Calculate changed line range for highlighting
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(before, content);
  const diffStats = calculateDiffStats(before, content);

  // Get diagnostics after edit (Kiro-style auto-check)
  const diagnostics = args.postEditDiagnostics === false
    ? EMPTY_DIAGNOSTICS
    : await getPostEditDiagnostics(path, relativePath);

  // Build output message
  let output = isNewFile
    ? `Created ${relativePath} (${newLines} lines)`
    : `Updated ${relativePath} (${oldLines} → ${newLines} lines)`;

  // Add error count to output (visible to user)
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }

  // Add detailed errors for AI (in meta, not visible to user)
  const aiErrors = diagnostics.problems.length > 0
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
      .filter((p) => p.severity === 'error')
      .slice(0, 5)
      .map((p) => `L${p.line}:${p.column} ${p.message}`)
      .join('\n')}`
    : '';

  return {
    success: true,
    output: output + aiErrors,
    meta: {
      fileEdit: {
        relativePath,
        absolutePath: path,
        beforeContent: before.length <= 100_000 ? before : null,
        afterContent: content.length <= 100_000 ? content : null,
        isNewFile,
        firstChangedLine,
        lastChangedLine,
        added: diffStats.added,
        removed: diffStats.removed,
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
    }
  };
}

/**
 * Append to existing file
 */
export async function handleAppendFile(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, '/');
  const rawText = String(args.text ?? args.content ?? '');
  const textToAppend = fixEscapedNewlines(rawText);

  // ALWAYS read fresh from disk
  let existing = '';
  try {
    existing = await readFileFresh(path);
  } catch {
    return { success: false, error: `File not found: ${relativePath}. Use write_file to create.` };
  }

  // Add newline if needed
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const newContent = existing + (needsNewline ? '\n' : '') + textToAppend;

  // Write with verification
  const writeResult = await writeFileWithSync(path, newContent);
  if (!writeResult.success) {
    return { success: false, error: `Failed to append: ${writeResult.error}` };
  }

  // Force sync editor with the new disk content
  await syncEditorWithDisk(path, normalizedPath, newContent);

  const addedLines = textToAppend.split('\n').length;
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(existing, newContent);
  const diffStats = calculateDiffStats(existing, newContent);

  // Get diagnostics after edit
  const diagnostics = args.postEditDiagnostics === false
    ? EMPTY_DIAGNOSTICS
    : await getPostEditDiagnostics(path, relativePath);

  let output = `Appended to ${relativePath} (+${addedLines} lines)`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }

  const aiErrors = diagnostics.problems.length > 0
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
      .filter((p) => p.severity === 'error')
      .slice(0, 5)
      .map((p) => `L${p.line}:${p.column} ${p.message}`)
      .join('\n')}`
    : '';

  return {
    success: true,
    output: output + aiErrors,
    meta: {
      fileEdit: {
        relativePath,
        absolutePath: path,
        beforeContent: existing.length <= 100_000 ? existing : null,
        afterContent: newContent.length <= 100_000 ? newContent : null,
        firstChangedLine,
        lastChangedLine,
        added: diffStats.added,
        removed: diffStats.removed,
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
    }
  };
}

/**
 * Replace text in file (str_replace / apply_edit)
 */
export async function handleStrReplace(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, '/');
  const rawOldStr = String(args.oldStr ?? args.original_snippet ?? '');
  const rawNewStr = String(args.newStr ?? args.new_snippet ?? '');
  const oldStr = fixEscapedNewlines(rawOldStr);
  const newStr = fixEscapedNewlines(rawNewStr);
  const force = args.force === true;

  // ALWAYS read fresh from disk
  let content = '';
  try {
    content = await readFileFresh(path);
  } catch {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  // Find match
  const match = findBestMatch(content, oldStr);
  if (!match) {
    const preview = oldStr.slice(0, 80).replace(/\n/g, '\\n');
    // Provide more helpful error with context about what the file actually contains
    const lines = content.split('\n');
    const lineCount = lines.length;
    const firstLines = lines.slice(0, 3).join('\n');
    return {
      success: false,
      error: `No match for: "${preview}..."

The file has ${lineCount} lines. First few lines:
${firstLines}

IMPORTANT: The file content may have changed from previous edits. Call read_file("${relativePath}") to get the current content before retrying.`
    };
  }

  // Apply replacement
  const newContent = content.slice(0, match.index) + newStr + content.slice(match.index + match.length);
  if (!force && newContent === content) {
    return {
      success: true,
      output: `No changes: ${relativePath}`,
      meta: {
        fileEdit: {
          relativePath,
          absolutePath: path,
          beforeContent: content.length <= 100_000 ? content : null,
          afterContent: newContent.length <= 100_000 ? newContent : null,
          errorCount: 0,
          warningCount: 0
        }
      }
    };
  }

  // Validate syntax
  const syntaxError = validateSyntax(content, newContent, relativePath);
  if (syntaxError) {
    return { success: false, error: syntaxError };
  }

  // Write with verification
  const writeResult = await writeFileWithSync(path, newContent);
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  // Force sync editor with the new disk content
  await syncEditorWithDisk(path, normalizedPath, newContent);

  const oldLines = oldStr.split('\n').length;
  const newLines = newStr.split('\n').length;
  const confidence = match.similarity < 1 ? ` (${Math.round(match.similarity * 100)}% match)` : '';

  // Calculate changed line range for highlighting
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(content, newContent);
  const diffStats = calculateDiffStats(content, newContent);

  // Get diagnostics after edit
  const diagnostics = args.postEditDiagnostics === false
    ? EMPTY_DIAGNOSTICS
    : await getPostEditDiagnostics(path, relativePath);

  let output = `Edited ${relativePath}: ${oldLines} → ${newLines} lines${confidence}`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }

  const aiErrors = diagnostics.problems.length > 0
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
      .filter((p) => p.severity === 'error')
      .slice(0, 5)
      .map((p) => `L${p.line}:${p.column} ${p.message}`)
      .join('\n')}`
    : '';

  return {
    success: true,
    output: output + aiErrors,
    meta: {
      fileEdit: {
        relativePath,
        absolutePath: path,
        beforeContent: content.length <= 100_000 ? content : null,
        afterContent: newContent.length <= 100_000 ? newContent : null,
        firstChangedLine,
        lastChangedLine,
        added: diffStats.added,
        removed: diffStats.removed,
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
    }
  };
}

// ============================================================================
// MULTI REPLACE - Batch non-contiguous edits in a single operation
// ============================================================================

/**
 * Handle multiple non-contiguous edits in a single file operation.
 * Edits are applied bottom-to-top so that earlier indices remain valid.
 * Rejects overlapping matches with a clear error.
 */
export async function handleMultiReplace(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, '/');
  const rawEdits = args.edits;

  // Validate edits array
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { success: false, error: 'Missing or empty "edits" array. Expected: [{ oldStr, newStr }, ...]' };
  }

  if (rawEdits.length > 50) {
    return { success: false, error: `Too many edits (${rawEdits.length}). Maximum 50 edits per call.` };
  }

  // Parse and validate each edit
  const edits: Array<{ oldStr: string; newStr: string }> = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const edit = rawEdits[i] as Record<string, unknown>;
    if (!edit || typeof edit !== 'object') {
      return { success: false, error: `Edit ${i}: expected object with oldStr and newStr` };
    }
    const oldStr = fixEscapedNewlines(String(edit.oldStr ?? edit.original_snippet ?? ''));
    const newStr = fixEscapedNewlines(String(edit.newStr ?? edit.new_snippet ?? ''));
    if (!oldStr) {
      return { success: false, error: `Edit ${i}: missing "oldStr"` };
    }
    edits.push({ oldStr, newStr });
  }

  // Read file fresh from disk
  let content = '';
  try {
    content = await readFileFresh(path);
  } catch {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  // Find all matches
  const matches: Array<{
    index: number;
    length: number;
    similarity: number;
    editIndex: number;
    oldStr: string;
    newStr: string;
  }> = [];

  for (let i = 0; i < edits.length; i++) {
    const match = findBestMatch(content, edits[i].oldStr);
    if (!match) {
      const preview = edits[i].oldStr.slice(0, 80).replace(/\n/g, '\\n');
      return {
        success: false,
        error: `Edit ${i}: no match for "${preview}..."\n\nCall read_file("${relativePath}") to see current content before retrying.`
      };
    }
    matches.push({
      ...match,
      editIndex: i,
      oldStr: edits[i].oldStr,
      newStr: edits[i].newStr,
    });
  }

  // Sort by position descending (bottom-to-top) so replacements don't shift indices
  matches.sort((a, b) => b.index - a.index);

  // Check for overlapping matches
  for (let i = 0; i < matches.length - 1; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const nextEnd = next.index + next.length;
    if (nextEnd > current.index) {
      return {
        success: false,
        error: `Overlapping edits: edit ${next.editIndex} overlaps with edit ${current.editIndex}. Split into separate calls.`
      };
    }
  }

  // Apply all replacements bottom-to-top
  let resultContent = content;
  for (const match of matches) {
    resultContent =
      resultContent.slice(0, match.index) +
      match.newStr +
      resultContent.slice(match.index + match.length);
  }

  // Skip if no changes
  if (resultContent === content) {
    return {
      success: true,
      output: `No changes: ${relativePath} (all ${edits.length} edits resulted in identical content)`,
    };
  }

  // Write with verification
  const writeResult = await writeFileWithSync(path, resultContent);
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  // Sync editor
  await syncEditorWithDisk(path, normalizedPath, resultContent);

  // Stats
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(content, resultContent);
  const diffStats = calculateDiffStats(content, resultContent);

  // Diagnostics
  const diagnostics = args.postEditDiagnostics === false
    ? EMPTY_DIAGNOSTICS
    : await getPostEditDiagnostics(path, relativePath);

  // Build summary
  const confidences = matches
    .filter(m => m.similarity < 1)
    .map(m => `edit ${m.editIndex}: ${Math.round(m.similarity * 100)}%`);
  const confidenceNote = confidences.length > 0 ? ` (fuzzy: ${confidences.join(', ')})` : '';

  let output = `Applied ${edits.length} edits to ${relativePath}${confidenceNote}`;
  output += ` | +${diffStats.added} -${diffStats.removed} lines`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }

  const aiErrors = diagnostics.problems.length > 0
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
      .filter((p) => p.severity === 'error')
      .slice(0, 5)
      .map((p) => `L${p.line}:${p.column} ${p.message}`)
      .join('\n')}`
    : '';

  return {
    success: true,
    output: output + aiErrors,
    meta: {
      fileEdit: {
        relativePath,
        absolutePath: path,
        beforeContent: content.length <= 100_000 ? content : null,
        afterContent: resultContent.length <= 100_000 ? resultContent : null,
        firstChangedLine,
        lastChangedLine,
        added: diffStats.added,
        removed: diffStats.removed,
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
      editCount: edits.length,
    }
  };
}

/**
 * Create directory
 */
export async function handleCreateDir(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);

  try {
    // If it already exists, treat as success
    try {
      const info = await invoke<{ isDir?: boolean }>('get_file_info', { path });
      if (info?.isDir) {
        return { success: true, output: `Directory already exists: ${relativePath}` };
      }
    } catch {
      // Not found or invalid -> continue to create
    }

    await invoke('create_dir', { path });
  } catch (err) {
    const msg = extractErrorMessage(err);
    if (msg.toLowerCase().includes('already exists')) {
      return { success: true, output: `Directory already exists: ${relativePath}` };
    }
    return { success: false, error: `Failed to create: ${msg}` };
  }

  await projectStore.refreshTree();
  return { success: true, output: `Created directory: ${relativePath}` };
}

/**
 * Delete file or directory
 */
export async function handleDeleteFile(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const explanation = args.explanation ? String(args.explanation) : undefined;

  // Capture content before delete if it's a file for potential revert
  let beforeContent: string | null = null;
  let isDirectory = false;
  try {
    const doc = await fileService.read(path);
    beforeContent = doc?.content ?? null;
    if (!doc) isDirectory = true;
  } catch {
    isDirectory = true;
  }

  try {
    await invoke('delete_path', { path });
  } catch (err) {
    const errMsg = extractErrorMessage(err);
    if (errMsg.includes('not found') || errMsg.includes('No such file')) {
      return { success: false, error: `File not found: ${relativePath}` };
    }
    if (errMsg.includes('permission') || errMsg.includes('denied')) {
      return { success: false, error: `Permission denied: Cannot delete ${relativePath}` };
    }
    if (errMsg.includes('directory not empty')) {
      return { success: false, error: `Directory not empty: ${relativePath}` };
    }
    return { success: false, error: `Failed to delete ${relativePath}: ${errMsg}` };
  }

  // Close if open in editor
  const openFiles = editorStore.openFiles.filter(f => isSameOrSuffixPath(f.path, path, relativePath));
  for (const f of openFiles) {
    editorStore.closeFile(f.path, true);
  }

  projectStore.removeNode(path);

  const output = explanation
    ? `Deleted: ${relativePath}\nReason: ${explanation}`
    : `Deleted: ${relativePath}`;

  return {
    success: true,
    output,
    meta: {
      fileDeleted: {
        relativePath,
        absolutePath: path,
        beforeContent: beforeContent && beforeContent.length <= 100_000 ? beforeContent : null,
        isDirectory
      }
    }
  };
}

/**
 * Rename/move file or directory
 */
export async function handleRenamePath(args: Record<string, unknown>): Promise<ToolResult> {
  const oldRelPath = String(args.oldPath);
  const newRelPath = String(args.newPath);
  const oldPath = resolvePath(oldRelPath);
  const newPath = resolvePath(newRelPath);

  try {
    await invoke('rename_path', { oldPath, newPath });
  } catch (err) {
    return { success: false, error: `Failed to rename: ${extractErrorMessage(err)}` };
  }

  // Update editor tabs
  const openFiles = editorStore.openFiles.filter(f => isSameOrSuffixPath(f.path, oldPath, oldRelPath));
  for (const f of openFiles) {
    editorStore.closeFile(f.path, true);
    await editorStore.openFile(newPath);
  }

  await projectStore.refreshTree();
  return {
    success: true,
    output: `Renamed: ${oldRelPath} → ${newRelPath}`,
    meta: {
      pathRenamed: {
        oldPath: oldRelPath,
        newPath: newRelPath,
        oldAbsolutePath: oldPath,
        newAbsolutePath: newPath
      }
    }
  };
}

/**
 * Replace a range of lines in a file
 */
export async function handleReplaceLines(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, '/');
  const startLine = Number(args.start_line);
  const endLine = Number(args.end_line);
  const rawContent = String(args.content ?? '');
  const newContent = fixEscapedNewlines(rawContent);
  const force = args.force === true;

  // Validate line numbers
  if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
    return { success: false, error: `Invalid line range: ${startLine}-${endLine}` };
  }

  // ALWAYS read fresh from disk
  let content = '';
  try {
    content = await readFileFresh(path);
  } catch {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  const lines = content.split('\n');
  const totalLines = lines.length;

  // Clamp end line to file length
  const actualEndLine = Math.min(endLine, totalLines);

  if (startLine > totalLines) {
    return { success: false, error: `Start line ${startLine} exceeds file length (${totalLines} lines)` };
  }

  // Build new content
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(actualEndLine);
  const newLines = newContent.split('\n');

  const resultContent = [...before, ...newLines, ...after].join('\n');
  if (!force && resultContent === content) {
    return {
      success: true,
      output: `No changes: ${relativePath}`,
      meta: {
        fileEdit: {
          relativePath,
          absolutePath: path,
          beforeContent: content.length <= 100_000 ? content : null,
          afterContent: resultContent.length <= 100_000 ? resultContent : null,
          errorCount: 0,
          warningCount: 0
        }
      }
    };
  }

  // Write with verification
  const writeResult = await writeFileWithSync(path, resultContent);
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  // Force sync editor with the new disk content
  await syncEditorWithDisk(path, normalizedPath, resultContent);

  const replacedLines = actualEndLine - startLine + 1;
  const insertedLines = newLines.length;
  const diffStats = calculateDiffStats(content, resultContent);

  // Get diagnostics after edit
  const diagnostics = args.postEditDiagnostics === false
    ? EMPTY_DIAGNOSTICS
    : await getPostEditDiagnostics(path, relativePath);

  let output = `Replaced lines ${startLine}-${actualEndLine} (${replacedLines} lines → ${insertedLines} lines) in ${relativePath}`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }

  const aiErrors = diagnostics.problems.length > 0
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
      .filter((p) => p.severity === 'error')
      .slice(0, 5)
      .map((p) => `L${p.line}:${p.column} ${p.message}`)
      .join('\n')}`
    : '';

  return {
    success: true,
    output: output + aiErrors,
    meta: {
      fileEdit: {
        relativePath,
        absolutePath: path,
        beforeContent: content.length <= 100_000 ? content : null,
        afterContent: resultContent.length <= 100_000 ? resultContent : null,
        firstChangedLine: startLine,
        lastChangedLine: startLine + insertedLines - 1,
        added: diffStats.added,
        removed: diffStats.removed,
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
    }
  };
}

// ============================================
// Helper functions
// ============================================

/**
 * Find best match for a snippet in file content
 * Kiro-style: More tolerant matching with multiple fallback strategies
 */
function findBestMatch(content: string, snippet: string): { index: number; length: number; similarity: number } | null {
  // 1. Exact match (fastest)
  const exactIndex = content.indexOf(snippet);
  if (exactIndex !== -1) {
    return { index: exactIndex, length: snippet.length, similarity: 1 };
  }

  // 2. Normalized match (handle CRLF and trim)
  const normalizedSnippet = snippet.replace(/\r\n/g, '\n');
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const normalizedIndex = normalizedContent.indexOf(normalizedSnippet);
  if (normalizedIndex !== -1) {
    return { index: normalizedIndex, length: normalizedSnippet.length, similarity: 0.99 };
  }

  // 3. Trimmed match (ignore leading/trailing whitespace on each line)
  const trimmedSnippet = normalizedSnippet.split('\n').map(l => l.trim()).join('\n');
  const trimmedContent = normalizedContent.split('\n').map(l => l.trim()).join('\n');
  const trimmedIndex = trimmedContent.indexOf(trimmedSnippet);
  if (trimmedIndex !== -1) {
    // Find actual position in original content
    const linesBefore = trimmedContent.slice(0, trimmedIndex).split('\n').length - 1;
    const contentLines = normalizedContent.split('\n');
    let actualIndex = 0;
    for (let i = 0; i < linesBefore; i++) {
      actualIndex += contentLines[i].length + 1;
    }
    // Find the actual length by counting lines in snippet
    const snippetLineCount = trimmedSnippet.split('\n').length;
    let actualLength = 0;
    for (let i = linesBefore; i < linesBefore + snippetLineCount && i < contentLines.length; i++) {
      actualLength += contentLines[i].length + 1;
    }
    actualLength = Math.max(1, actualLength - 1); // Remove trailing newline
    return { index: actualIndex, length: actualLength, similarity: 0.95 };
  }

  // 4. Indentation-insensitive match (normalize all indentation)
  const indentNormSnippet = normalizedSnippet.split('\n').map(l => l.replace(/^[\t ]+/, '')).join('\n');
  const indentNormContent = normalizedContent.split('\n').map(l => l.replace(/^[\t ]+/, '')).join('\n');
  const indentIndex = indentNormContent.indexOf(indentNormSnippet);
  if (indentIndex !== -1) {
    const linesBefore = indentNormContent.slice(0, indentIndex).split('\n').length - 1;
    const contentLines = normalizedContent.split('\n');
    let actualIndex = 0;
    for (let i = 0; i < linesBefore; i++) {
      actualIndex += contentLines[i].length + 1;
    }
    const snippetLineCount = indentNormSnippet.split('\n').length;
    let actualLength = 0;
    for (let i = linesBefore; i < linesBefore + snippetLineCount && i < contentLines.length; i++) {
      actualLength += contentLines[i].length + 1;
    }
    actualLength = Math.max(1, actualLength - 1);
    return { index: actualIndex, length: actualLength, similarity: 0.90 };
  }

  // 5. Fuzzy regex match (whitespace insensitive) - last resort
  try {
    const fuzzyRegex = buildFuzzyRegex(snippet);
    const fuzzyMatch = fuzzyRegex.exec(content);
    if (fuzzyMatch) {
      return { index: fuzzyMatch.index, length: fuzzyMatch[0].length, similarity: 0.80 };
    }
  } catch {
    // Regex might fail on complex patterns, ignore
  }

  return null;
}

/**
 * Build whitespace-insensitive regex
 */
function buildFuzzyRegex(snippet: string): RegExp {
  const parts = snippet.trim().split(/\s+/).filter(p => p.length > 0);
  const pattern = parts.map(p => escapeRegex(p)).join('\\s+');
  return new RegExp(pattern, 'm');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate syntax after edit
 * NOTE: Disabled by default - Kiro-style approach trusts the AI
 * Only warn, don't block edits
 */
function validateSyntax(before: string, after: string, path: string): string | null {
  // DISABLED: Don't block edits based on bracket validation
  // This was causing too many false positives with valid code
  // Let the LSP/diagnostics catch real errors after the edit
  return null;

  /* Original validation - kept for reference
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const codeExts = ['js', 'ts', 'jsx', 'tsx', 'svelte', 'vue', 'json'];
  if (!codeExts.includes(ext)) return null;

  const beforeErrors = countBracketErrors(before);
  const afterErrors = countBracketErrors(after);

  if (beforeErrors === 0 && afterErrors > 0) {
    return `Syntax error: unbalanced brackets. Edit NOT applied.`;
  }
  if (afterErrors > beforeErrors) {
    return `Edit would add syntax errors (${beforeErrors} → ${afterErrors}). NOT applied.`;
  }

  return null;
  */
}

/**
 * Write a plan file to .volt/plans/ directory
 */
export async function handleWritePlanFile(args: Record<string, unknown>): Promise<ToolResult> {
  const filename = String(args.filename ?? '');
  const content = String(args.content ?? '');

  if (!filename) {
    return { success: false, error: 'Missing filename' };
  }

  // Ensure filename ends with .md
  const planFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

  // Build path: .volt/plans/<filename>
  const relativePath = `.volt/plans/${planFilename}`;
  const path = resolvePath(relativePath);

  // Ensure .volt/plans directory exists
  const plansDir = resolvePath('.volt/plans');
  try {
    await invoke('create_dir', { path: plansDir });
  } catch {
    // Directory might already exist, that's fine
  }

  // Write the plan file
  try {
    const result = await fileService.write(path, content, { source: 'ai', createIfMissing: true });
    if (!result.success) {
      return { success: false, error: `Failed to write plan: ${result.error}` };
    }
  } catch (err) {
    return { success: false, error: `Failed to write plan: ${extractErrorMessage(err)}` };
  }

  // Refresh tree to show new file
  try { await projectStore.refreshTree(); } catch { }

  // Open in editor
  try {
    await editorStore.openFile(path);
  } catch { }

  return {
    success: true,
    output: `Created plan: ${relativePath}`,
    meta: {
      planFile: {
        relativePath,
        absolutePath: path,
        filename: planFilename
      }
    }
  };
}

/**
 * Count bracket imbalances
 */
function countBracketErrors(content: string): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let errors = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const prev = content[i - 1];

    // Skip strings
    if (!inString && (char === '"' || char === "'" || char === '`') && prev !== '\\') {
      inString = true;
      stringChar = char;
      continue;
    }
    if (inString && char === stringChar && prev !== '\\') {
      inString = false;
      continue;
    }
    if (inString) continue;

    // Check brackets
    if ('([{'.includes(char)) {
      stack.push(char);
    } else if (')]}'.includes(char)) {
      if (stack.pop() !== pairs[char]) errors++;
    }
  }

  return errors + stack.length;
}

/**
 * Calculate the range of changed lines between before and after content
 */
function calculateChangedLines(before: string, after: string): { firstChangedLine: number; lastChangedLine: number } {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Find first different line
  let firstChangedLine = 1;
  for (let i = 0; i < Math.min(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] !== afterLines[i]) {
      firstChangedLine = i + 1;
      break;
    }
    firstChangedLine = i + 2; // If all compared lines are equal, start after them
  }

  // Find last different line (from the end)
  let lastChangedLine = afterLines.length;
  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;

  while (beforeEnd >= firstChangedLine - 1 && afterEnd >= firstChangedLine - 1) {
    if (beforeLines[beforeEnd] !== afterLines[afterEnd]) {
      lastChangedLine = afterEnd + 1;
      break;
    }
    beforeEnd--;
    afterEnd--;
    lastChangedLine = afterEnd + 1;
  }

  // Ensure valid range
  if (lastChangedLine < firstChangedLine) {
    lastChangedLine = firstChangedLine;
  }

  // Clamp to file bounds
  firstChangedLine = Math.max(1, firstChangedLine);
  lastChangedLine = Math.min(afterLines.length, Math.max(lastChangedLine, firstChangedLine));

  return { firstChangedLine, lastChangedLine };
}
// ============================================================================
// FORMAT FILE - Prettier formatting
// ============================================================================

/**
 * Format a file using Prettier
 */
export async function handleFormatFile(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const absolutePath = resolvePath(relativePath);

  // Import Prettier service
  const { formatWithPrettier, isPrettierFile } = await import('$lib/services/prettier');

  // Check if file type is supported
  if (!isPrettierFile(absolutePath)) {
    const ext = absolutePath.split('.').pop() || '';
    return {
      success: false,
      error: `Unsupported file type: .${ext}. Prettier supports: ts, tsx, js, jsx, json, css, scss, less, html, md, svelte, vue, yaml`
    };
  }

  // Read current content
  let content: string;
  try {
    const doc = await fileService.read(absolutePath, true);
    if (!doc) {
      return { success: false, error: `File not found: ${relativePath}` };
    }
    content = doc.content;
  } catch (err) {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  // Format with Prettier
  const formatted = await formatWithPrettier(content, absolutePath);

  if (formatted === null) {
    return {
      success: false,
      error: `Formatting failed. Make sure Prettier is installed: npm install -D prettier`
    };
  }

  // Check if content changed
  if (formatted === content) {
    return { success: true, output: `✓ ${relativePath} already formatted` };
  }

  // Write formatted content
  try {
    const result = await fileService.write(absolutePath, formatted, { source: 'ai' });
    if (!result.success) {
      return { success: false, error: `Failed to write: ${result.error}` };
    }

    // Update editor if file is open
    const openFiles = editorStore.openFiles.filter(f =>
      f.path === absolutePath ||
      f.path.endsWith('/' + relativePath) ||
      f.path.endsWith('\\' + relativePath)
    );

    if (openFiles.length > 0) {
      editorStore.updateContent(openFiles[0].path, formatted);
    }

    const linesBefore = content.split('\n').length;
    const linesAfter = formatted.split('\n').length;
    const lineDiff = linesAfter - linesBefore;
    const lineDiffStr = lineDiff === 0 ? '' : lineDiff > 0 ? ` (+${lineDiff} lines)` : ` (${lineDiff} lines)`;

    return {
      success: true,
      output: `✓ Formatted ${relativePath}${lineDiffStr}`
    };
  } catch (err) {
    return { success: false, error: `Failed to write formatted file: ${extractErrorMessage(err)}` };
  }
}
