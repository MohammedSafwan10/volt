/**
 * File write tool handlers - write_file, append_file, str_replace, create_dir, delete_file, rename_path
 * 
 * Kiro-style improvements:
 * - Auto-diagnostics after edits (shows error count to user, sends details to AI)
 * - Includes ESLint issues alongside TypeScript/Svelte errors
 * - No pre-validation (trusts AI, lets LSP catch errors)
 * - Better fuzzy matching for str_replace
 * - Line-based edits with replace_lines
 */

import { invoke } from '@tauri-apps/api/core';
import { projectStore } from '$lib/stores/project.svelte';
import { editorStore } from '$lib/stores/editor.svelte';
import { resolvePath, extractErrorMessage, isSameOrSuffixPath, type ToolResult } from '../utils';

/**
 * Get diagnostics for a file after edit
 * Returns error count for UI and detailed errors for AI
 * Includes TypeScript, ESLint, Svelte, Dart, and other LSP diagnostics
 */
async function getPostEditDiagnostics(absolutePath: string, relativePath: string): Promise<{
  errorCount: number;
  warningCount: number;
  errors: string[]; // Detailed errors for AI (not shown to user)
}> {
  try {
    // Notify LSPs of the file change based on file type
    const ext = absolutePath.split('.').pop()?.toLowerCase() || '';
    
    // Notify ESLint for JS/TS files
    if (['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext)) {
      try {
        const content = await invoke<string>('read_file', { path: absolutePath });
        const { notifyEslintDocumentChanged } = await import('$lib/services/lsp/eslint-sidecar');
        await notifyEslintDocumentChanged(absolutePath, content);
      } catch {
        // ESLint notification failed, continue anyway
      }
    }
    
    // Notify Dart LSP for Dart files and pubspec.yaml
    if (ext === 'dart' || absolutePath.toLowerCase().endsWith('pubspec.yaml') || absolutePath.toLowerCase().endsWith('analysis_options.yaml')) {
      try {
        const content = await invoke<string>('read_file', { path: absolutePath });
        const { notifyDocumentChanged, isDartLspRunning } = await import('$lib/services/lsp/dart-sidecar');
        if (isDartLspRunning()) {
          await notifyDocumentChanged(absolutePath, content);
        }
      } catch {
        // Dart notification failed, continue anyway
      }
    }
    
    // Notify YAML LSP for YAML files
    if (['yaml', 'yml'].includes(ext)) {
      try {
        const content = await invoke<string>('read_file', { path: absolutePath });
        const { notifyDocumentChanged, isYamlLspRunning } = await import('$lib/services/lsp/yaml-sidecar');
        if (isYamlLspRunning()) {
          await notifyDocumentChanged(absolutePath, content);
        }
      } catch {
        // YAML notification failed, continue anyway
      }
    }
    
    // Notify XML LSP for XML and plist files
    if (['xml', 'plist', 'xsd', 'xsl', 'xslt', 'svg'].includes(ext)) {
      try {
        const content = await invoke<string>('read_file', { path: absolutePath });
        const { notifyDocumentChanged, isXmlLspRunning } = await import('$lib/services/lsp/xml-sidecar');
        if (isXmlLspRunning()) {
          await notifyDocumentChanged(absolutePath, content);
        }
      } catch {
        // XML notification failed, continue anyway
      }
    }
    
    // Wait for LSPs to process (ESLint/Dart need a bit more time)
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Import diagnostics handler dynamically to avoid circular deps
    const { handleGetDiagnostics } = await import('./diagnostics');
    const result = await handleGetDiagnostics({ paths: [relativePath] });
    
    if (!result.success || !result.output) {
      return { errorCount: 0, warningCount: 0, errors: [] };
    }
    
    // Parse the diagnostics output
    const output = result.output;
    const lines = output.split('\n');
    
    let errorCount = 0;
    let warningCount = 0;
    const errors: string[] = [];
    
    for (const line of lines) {
      if (line.includes('[error]') || line.includes('Error:')) {
        errorCount++;
        errors.push(line.trim());
      } else if (line.includes('[warning]') || line.includes('Warning:')) {
        warningCount++;
      }
    }
    
    return { errorCount, warningCount, errors };
  } catch {
    return { errorCount: 0, warningCount: 0, errors: [] };
  }
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
  const rawContent = String(args.text ?? args.content ?? '');
  const content = fixEscapedNewlines(rawContent);

  // Check if file exists
  let before = '';
  let isNewFile = false;
  try {
    before = await invoke<string>('read_file', { path });
  } catch {
    isNewFile = true;
  }

  // Write to disk
  try {
    await invoke('write_file', { path, content });
  } catch (err) {
    return { success: false, error: `Failed to write: ${extractErrorMessage(err)}` };
  }

  // Refresh tree if new file
  if (isNewFile) {
    try { await projectStore.refreshTree(); } catch {}
  }

  // Open/reload in editor
  try {
    const existing = editorStore.openFiles.find(f => 
      f.path === path || f.path === relativePath || 
      f.path.endsWith('/' + relativePath) || f.path.endsWith('\\' + relativePath)
    );
    if (existing) {
      await editorStore.reloadFile(existing.path);
    } else {
      await editorStore.openFile(path);
    }
  } catch {}

  const newLines = content.split('\n').length;
  const oldLines = before.split('\n').length;
  
  // Calculate changed line range for highlighting
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(before, content);
  
  // Get diagnostics after edit (Kiro-style auto-check)
  const diagnostics = await getPostEditDiagnostics(path, relativePath);
  
  // Build output message
  let output = isNewFile 
    ? `Created ${relativePath} (${newLines} lines)`
    : `Updated ${relativePath} (${oldLines} → ${newLines} lines)`;
  
  // Add error count to output (visible to user)
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }
  
  // Add detailed errors for AI (in meta, not visible to user)
  const aiErrors = diagnostics.errors.length > 0 
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.errors.slice(0, 5).join('\n')}`
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
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      }
    }
  };
}

/**
 * Append to existing file
 */
export async function handleAppendFile(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const rawText = String(args.text ?? args.content ?? '');
  const textToAppend = fixEscapedNewlines(rawText);

  // Read existing
  let existing = '';
  try {
    existing = await invoke<string>('read_file', { path });
  } catch {
    return { success: false, error: `File not found: ${relativePath}. Use write_file to create.` };
  }

  // Add newline if needed
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const newContent = existing + (needsNewline ? '\n' : '') + textToAppend;

  // Write
  try {
    await invoke('write_file', { path, content: newContent });
  } catch (err) {
    return { success: false, error: `Failed to append: ${extractErrorMessage(err)}` };
  }

  // Reload in editor
  try {
    const existingFile = editorStore.openFiles.find(f => 
      f.path === path || f.path.endsWith('/' + relativePath)
    );
    if (existingFile) {
      await editorStore.reloadFile(existingFile.path);
    }
  } catch {}

  const addedLines = textToAppend.split('\n').length;
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(existing, newContent);
  
  // Get diagnostics after edit
  const diagnostics = await getPostEditDiagnostics(path, relativePath);
  
  let output = `Appended to ${relativePath} (+${addedLines} lines)`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }
  
  const aiErrors = diagnostics.errors.length > 0 
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.errors.slice(0, 5).join('\n')}`
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
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      }
    }
  };
}

/**
 * Replace text in file (str_replace / apply_edit)
 */
export async function handleStrReplace(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const rawOldStr = String(args.oldStr ?? args.original_snippet ?? '');
  const rawNewStr = String(args.newStr ?? args.new_snippet ?? '');
  const oldStr = fixEscapedNewlines(rawOldStr);
  const newStr = fixEscapedNewlines(rawNewStr);

  // Read file
  let content = '';
  try {
    content = await invoke<string>('read_file', { path });
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

  // Validate syntax
  const syntaxError = validateSyntax(content, newContent, relativePath);
  if (syntaxError) {
    return { success: false, error: syntaxError };
  }

  // Write
  try {
    await invoke('write_file', { path, content: newContent });
  } catch (err) {
    return { success: false, error: `Failed to write: ${extractErrorMessage(err)}` };
  }

  // Reload in editor
  try {
    const existing = editorStore.openFiles.find(f => 
      f.path === path || f.path.endsWith('/' + relativePath)
    );
    if (existing) {
      await editorStore.reloadFile(existing.path);
    }
  } catch {}

  const oldLines = oldStr.split('\n').length;
  const newLines = newStr.split('\n').length;
  const confidence = match.similarity < 1 ? ` (${Math.round(match.similarity * 100)}% match)` : '';
  
  // Calculate changed line range for highlighting
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(content, newContent);
  
  // Get diagnostics after edit
  const diagnostics = await getPostEditDiagnostics(path, relativePath);
  
  let output = `Edited ${relativePath}: ${oldLines} → ${newLines} lines${confidence}`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }
  
  const aiErrors = diagnostics.errors.length > 0 
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.errors.slice(0, 5).join('\n')}`
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
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      }
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
    await invoke('create_dir', { path });
  } catch (err) {
    return { success: false, error: `Failed to create: ${extractErrorMessage(err)}` };
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

  // Check if file/directory exists first
  try {
    await invoke<string>('read_file', { path });
  } catch {
    // Try to check if it's a directory
    try {
      await invoke('list_dir', { path });
    } catch {
      // File/directory doesn't exist - might have been already deleted or moved
      return { 
        success: false, 
        error: `File not found: ${relativePath} (may have been moved or already deleted)` 
      };
    }
  }

  try {
    await invoke('delete_path', { path });
  } catch (err) {
    const errMsg = extractErrorMessage(err);
    // Provide more helpful error messages
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
    
  return { success: true, output };
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
  return { success: true, output: `Renamed: ${oldRelPath} → ${newRelPath}` };
}

/**
 * Replace lines in file by line numbers (Kiro-style line-based edit)
 */
export async function handleReplaceLines(args: Record<string, unknown>): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const startLine = Number(args.start_line);
  const endLine = Number(args.end_line);
  const rawContent = String(args.content ?? '');
  const newContent = fixEscapedNewlines(rawContent);

  // Validate line numbers
  if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
    return { success: false, error: `Invalid line range: ${startLine}-${endLine}` };
  }

  // Read file
  let content = '';
  try {
    content = await invoke<string>('read_file', { path });
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

  // Write
  try {
    await invoke('write_file', { path, content: resultContent });
  } catch (err) {
    return { success: false, error: `Failed to write: ${extractErrorMessage(err)}` };
  }

  // Reload in editor
  try {
    const existing = editorStore.openFiles.find(f => 
      f.path === path || f.path.endsWith('/' + relativePath)
    );
    if (existing) {
      await editorStore.reloadFile(existing.path);
    }
  } catch {}

  const replacedLines = actualEndLine - startLine + 1;
  const insertedLines = newLines.length;
  
  // Get diagnostics after edit
  const diagnostics = await getPostEditDiagnostics(path, relativePath);
  
  let output = `Replaced lines ${startLine}-${actualEndLine} (${replacedLines} lines → ${insertedLines} lines) in ${relativePath}`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? 's' : ''}`;
  }
  
  const aiErrors = diagnostics.errors.length > 0 
    ? `\n\n[ERRORS - fix these]:\n${diagnostics.errors.slice(0, 5).join('\n')}`
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
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount
      }
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
    await invoke('write_file', { path, content });
  } catch (err) {
    return { success: false, error: `Failed to write plan: ${extractErrorMessage(err)}` };
  }
  
  // Refresh tree to show new file
  try { await projectStore.refreshTree(); } catch {}
  
  // Open in editor
  try {
    await editorStore.openFile(path);
  } catch {}
  
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
    content = await invoke<string>('read_file', { path: absolutePath });
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
    await invoke('write_file', { path: absolutePath, content: formatted });
    
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