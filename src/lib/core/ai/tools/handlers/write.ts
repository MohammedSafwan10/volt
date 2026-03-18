/**
 * File write tool handlers - write_file, append_file, str_replace, apply_patch, create_dir, delete_file, rename_path
 *
 * SaaS-Ready Architecture:
 * - Uses UnifiedFileService as single source of truth
 * - Version-based conflict detection (optimistic locking)
 * - Event-driven updates to all components
 * - Auto-diagnostics after edits
 * - Zero desync between components
 */

import { invoke } from "@tauri-apps/api/core";
import { projectStore } from "$shared/stores/project.svelte";
import { editorStore } from "$features/editor/stores/editor.svelte";
import { fileService, type FileDocument } from "$core/services/file-service";
import { revealLine, setModelValue, setReviewHighlight } from "$core/services/monaco-models";
import { notifyDocumentChanged as notifyTsDocumentChanged } from "$core/lsp/typescript-sidecar";
import { notifyEslintDocumentChanged } from "$core/lsp/eslint-sidecar";
import { notifySvelteDocumentChanged } from "$core/lsp/svelte-sidecar";
import { notifyHtmlDocumentChanged } from "$core/lsp/html-sidecar";
import { notifyCssDocumentChanged } from "$core/lsp/css-sidecar";
import { notifyJsonDocumentChanged } from "$core/lsp/json-sidecar";
import {
  isDartLspRunning,
  notifyDocumentChanged as notifyDartDocumentChanged,
} from "$core/lsp/dart-sidecar";
import {
  isYamlLspRunning,
  notifyDocumentChanged as notifyYamlDocumentChanged,
} from "$core/lsp/yaml-sidecar";
import {
  isXmlLspRunning,
  notifyDocumentChanged as notifyXmlDocumentChanged,
} from "$core/lsp/xml-sidecar";
import { isTailwindLspConnected, notifyTailwindDocumentChanged } from "$core/lsp/tailwind-sidecar";
import {
  resolvePath,
  extractErrorMessage,
  isSameOrSuffixPath,
  calculateDiffStats,
  type ToolResult,
} from "$core/ai/tools/utils";
import {
  calculateChangedLines,
  findBestMatch,
  fixEscapedNewlines,
  validateSyntax,
} from "$core/ai/tools/handlers/write-utils";
import {
  applyCodexPatch,
  getCodexPatchLineStats,
  parseCodexPatch,
} from "$core/ai/tools/handlers/write-patch";
import type { ToolRuntimeContext } from "$core/ai/tools/runtime";

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
const postEditDiagnosticsCache = new Map<
  string,
  {
    timestamp: number;
    result: PostEditDiagnosticsResult;
    inFlight?: Promise<PostEditDiagnosticsResult>;
  }
>();

async function readFileDocumentFresh(path: string): Promise<FileDocument> {
  const doc = await fileService.read(path, true);
  if (!doc) {
    throw new Error(`File not found: ${path}`);
  }
  return doc;
}

/**
 * Write file using unified file service with verification
 * Returns result with version tracking
 */
async function writeFileWithSync(
  path: string,
  content: string,
  expectedVersion?: number,
  baseContent?: string,
): Promise<{ success: boolean; error?: string; newVersion?: number }> {
  const result = await fileService.write(path, content, {
    expectedVersion,
    source: "ai",
    force: expectedVersion === undefined, // Force only when no optimistic version is available
  });

  if (!result.success) {
    if ((result.error ?? "").toLowerCase().includes("version conflict")) {
      try {
        const latestDoc = await readFileDocumentFresh(path);
        if (latestDoc.content === content) {
          return {
            success: true,
            newVersion: latestDoc.version,
          };
        }

        if (baseContent !== undefined && latestDoc.content === baseContent) {
          const retry = await fileService.write(path, content, {
            expectedVersion: latestDoc.version,
            source: "ai",
          });
          if (retry.success) {
            return {
              success: true,
              newVersion: retry.newVersion,
            };
          }
        }
      } catch {
        // Fall through to the standard conflict message.
      }
      return {
        success: false,
        error: "Content changed on disk; refresh file state if needed and retry.",
      };
    }
    return { success: false, error: result.error };
  }

  return { success: true, newVersion: result.newVersion };
}

function emitRuntimeUpdate(
  runtime: ToolRuntimeContext | undefined,
  liveStatus: string,
  meta?: Record<string, unknown>,
): void {
  runtime?.onUpdate?.({
    liveStatus,
    meta,
  });
}

function findOpenEditorPath(path: string, normalizedPath: string, relativePath?: string): string | null {
  const fileName = relativePath?.split(/[/\\]/).pop() ?? path.split(/[/\\]/).pop() ?? "";
  const existing = editorStore.openFiles.find(
    (f) =>
      f.path === path ||
      f.path === normalizedPath ||
      (relativePath ? f.path.endsWith("/" + relativePath) || f.path.endsWith("\\" + relativePath) : false) ||
      (fileName ? f.path.endsWith("/" + fileName) || f.path.endsWith("\\" + fileName) : false),
  );
  return existing?.path ?? null;
}

interface EditorSyncOptions {
  relativePath?: string;
  firstChangedLine?: number;
  lastChangedLine?: number;
}

/**
 * Sync editor with file service (lightweight - file service handles the heavy lifting)
 */
async function syncEditorWithDisk(
  path: string,
  normalizedPath: string,
  content: string,
  options: EditorSyncOptions = {},
  runtime?: ToolRuntimeContext,
): Promise<void> {
  try {
    emitRuntimeUpdate(runtime, "Syncing editor...");
    let existingPath = findOpenEditorPath(path, normalizedPath, options.relativePath);
    if (!existingPath) {
      emitRuntimeUpdate(runtime, "Opening file...");
      const opened = await editorStore.openFile(path);
      if (opened) {
        existingPath = findOpenEditorPath(path, normalizedPath, options.relativePath);
      }
    }
    setModelValue(normalizedPath, content);
    const syncedPath = existingPath ?? normalizedPath;
    if (existingPath) {
      editorStore.setActiveFile(existingPath);
      editorStore.updateContent(existingPath, content);
      editorStore.markSaved(existingPath);
    } else {
      const existing = editorStore.openFiles.find((f) => f.path === normalizedPath || f.path === path);
      if (existing) {
        existing.content = content;
        existing.originalContent = content;
        editorStore.markSaved(existing.path);
      }
    }

    if (
      typeof options.firstChangedLine === "number" &&
      typeof options.lastChangedLine === "number"
    ) {
      emitRuntimeUpdate(runtime, "Highlighting changes...");
      setReviewHighlight(syncedPath, options.firstChangedLine, options.lastChangedLine);
      if (editorStore.activeFile?.path === syncedPath) {
        revealLine(syncedPath, options.firstChangedLine);
      }
    }
  } catch (err) {
    console.error("[write] Error syncing editor:", err);
  }
}

/**
 * Get diagnostics for a file after edit
 * Returns error count for UI and detailed errors for AI
 * Includes TypeScript, ESLint, Svelte, Dart, and other LSP diagnostics
 */
async function getPostEditDiagnostics(
  absolutePath: string,
  relativePath: string,
  runtime?: ToolRuntimeContext,
): Promise<{
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
      const ext = absolutePath.split(".").pop()?.toLowerCase() || "";
      const doc = await fileService.read(absolutePath, true);
      const latestContent = doc?.content;

      // 1. Notify TypeScript/JavaScript/ESLint
      if (latestContent && ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"].includes(ext)) {
        try {
          await notifyTsDocumentChanged(absolutePath, latestContent);
          await notifyEslintDocumentChanged(absolutePath, latestContent);
        } catch {
          // Continue anyway
        }
      }

      // 2. Notify Svelte
      if (latestContent && ext === "svelte") {
        try {
          await notifySvelteDocumentChanged(absolutePath, latestContent);
        } catch {}
      }

      // 3. Notify HTML
      if (latestContent && ["html", "htm"].includes(ext)) {
        try {
          await notifyHtmlDocumentChanged(absolutePath, latestContent);
        } catch {}
      }

      // 4. Notify CSS/SCSS/LESS
      if (latestContent && ["css", "scss", "less", "sass"].includes(ext)) {
        try {
          await notifyCssDocumentChanged(absolutePath, latestContent);
        } catch {}
      }

      // 5. Notify JSON
      if (latestContent && ext === "json") {
        try {
          await notifyJsonDocumentChanged(absolutePath, latestContent);
        } catch {}
      }

      // 6. Notify Dart LSP for Dart files and pubspec.yaml
      if (
        latestContent &&
        (ext === "dart" ||
          absolutePath.toLowerCase().endsWith("pubspec.yaml") ||
          absolutePath.toLowerCase().endsWith("analysis_options.yaml"))
      ) {
        try {
          if (isDartLspRunning()) {
            await notifyDartDocumentChanged(absolutePath, latestContent);
          }
        } catch {}
      }

      // 7. Notify YAML LSP for YAML files
      if (latestContent && ["yaml", "yml"].includes(ext)) {
        try {
          if (isYamlLspRunning()) {
            await notifyYamlDocumentChanged(absolutePath, latestContent);
          }
        } catch {}
      }

      // 8. Notify XML LSP for XML and plist files
      if (latestContent && ["xml", "plist", "xsd", "xsl", "xslt", "svg"].includes(ext)) {
        try {
          if (isXmlLspRunning()) {
            await notifyXmlDocumentChanged(absolutePath, latestContent);
          }
        } catch {}
      }

      // 9. Notify Tailwind
      try {
        if (latestContent && isTailwindLspConnected()) {
          await notifyTailwindDocumentChanged(absolutePath, latestContent);
        }
      } catch {}

      const collectDiagnostics = async (): Promise<PostEditDiagnosticsResult> => {
        const { handleGetDiagnostics } = await import("$core/ai/tools/handlers/diagnostics");
        const result = await handleGetDiagnostics({ paths: [relativePath] }, runtime);

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
 * Write/create a file
 */
export async function handleWriteFile(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, "/");
  const rawContent = String(args.text ?? args.content ?? "");
  const content = fixEscapedNewlines(rawContent);
  const force = args.force === true;
  emitRuntimeUpdate(runtime, "Reading file...");

  // ALWAYS read fresh from disk to avoid stale cache issues
  let before = "";
  let expectedVersion: number | undefined;
  let isNewFile = false;
  try {
    const beforeDoc = await readFileDocumentFresh(path);
    before = beforeDoc.content;
    expectedVersion = beforeDoc.version;
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
          warningCount: 0,
        },
      },
    };
  }

  // Write with verification and retry logic
  emitRuntimeUpdate(runtime, isNewFile ? "Creating file..." : "Writing file...");
  const writeResult = await writeFileWithSync(
    path,
    content,
    isNewFile ? undefined : expectedVersion,
    isNewFile ? undefined : before,
  );
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  // Refresh tree if new file
  if (isNewFile) {
    try {
      await projectStore.refreshTree();
    } catch {}
  }

  const { firstChangedLine, lastChangedLine } = calculateChangedLines(before, content);

  // Force sync editor with the new disk content
  await syncEditorWithDisk(path, normalizedPath, content, {
    relativePath,
    firstChangedLine,
    lastChangedLine,
  }, runtime);

  // If file wasn't open, open it now
  try {
    const existing = editorStore.openFiles.find(
      (f) =>
        f.path === path ||
        f.path === normalizedPath ||
        f.path.endsWith("/" + relativePath) ||
        f.path.endsWith("\\" + relativePath),
    );
    if (!existing) {
      await editorStore.openFile(path);
    }
  } catch {}

  const newLines = content.split("\n").length;
  const oldLines = before.split("\n").length;

  const diffStats = calculateDiffStats(before, content);

  // Get diagnostics after edit (auto-check)
  const diagnostics =
    args.postEditDiagnostics === false
      ? EMPTY_DIAGNOSTICS
      : await getPostEditDiagnostics(path, relativePath, runtime);

  // Build output message
  let output = isNewFile
    ? `Created ${relativePath} (${newLines} lines)`
    : `Updated ${relativePath} (${oldLines} → ${newLines} lines)`;

  // Add error count to output (visible to user)
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? "s" : ""}`;
  }

  // Add detailed errors for AI (in meta, not visible to user)
  const aiErrors =
    diagnostics.problems.length > 0
      ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
          .filter((p) => p.severity === "error")
          .slice(0, 5)
          .map((p) => `L${p.line}:${p.column} ${p.message}`)
          .join("\n")}`
      : "";

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
        warningCount: diagnostics.warningCount,
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
    },
  };
}

/**
 * Append to existing file
 */
export async function handleAppendFile(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, "/");
  const rawText = String(args.text ?? args.content ?? "");
  const textToAppend = fixEscapedNewlines(rawText);
  emitRuntimeUpdate(runtime, "Reading file...");

  // ALWAYS read fresh from disk
  let existing = "";
  let expectedVersion: number;
  try {
    const existingDoc = await readFileDocumentFresh(path);
    existing = existingDoc.content;
    expectedVersion = existingDoc.version;
  } catch {
    return { success: false, error: `File not found: ${relativePath}. Use write_file to create.` };
  }

  // Add newline if needed
  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  const newContent = existing + (needsNewline ? "\n" : "") + textToAppend;

  // Write with verification
  emitRuntimeUpdate(runtime, "Appending to file...");
  const writeResult = await writeFileWithSync(path, newContent, expectedVersion, existing);
  if (!writeResult.success) {
    return { success: false, error: `Failed to append: ${writeResult.error}` };
  }

  const addedLines = textToAppend.split("\n").length;
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(existing, newContent);
  // Force sync editor with the new disk content
  await syncEditorWithDisk(path, normalizedPath, newContent, {
    relativePath,
    firstChangedLine,
    lastChangedLine,
  }, runtime);
  const diffStats = calculateDiffStats(existing, newContent);

  // Get diagnostics after edit
  const diagnostics =
    args.postEditDiagnostics === false
      ? EMPTY_DIAGNOSTICS
      : await getPostEditDiagnostics(path, relativePath, runtime);

  let output = `Appended to ${relativePath} (+${addedLines} lines)`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? "s" : ""}`;
  }

  const aiErrors =
    diagnostics.problems.length > 0
      ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
          .filter((p) => p.severity === "error")
          .slice(0, 5)
          .map((p) => `L${p.line}:${p.column} ${p.message}`)
          .join("\n")}`
      : "";

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
        warningCount: diagnostics.warningCount,
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
    },
  };
}

/**
 * Replace text in file (str_replace / apply_edit)
 */
export async function handleStrReplace(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, "/");
  const rawOldStr = String(args.oldStr ?? args.original_snippet ?? "");
  const rawNewStr = String(args.newStr ?? args.new_snippet ?? "");
  const oldStr = fixEscapedNewlines(rawOldStr);
  const newStr = fixEscapedNewlines(rawNewStr);
  const force = args.force === true;
  emitRuntimeUpdate(runtime, "Reading file...");

  // ALWAYS read fresh from disk
  let content = "";
  let expectedVersion: number;
  try {
    const contentDoc = await readFileDocumentFresh(path);
    content = contentDoc.content;
    expectedVersion = contentDoc.version;
  } catch {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  // Find match
  emitRuntimeUpdate(runtime, "Matching snippet...");
  const match = findBestMatch(content, oldStr);
  if (!match) {
    const preview = oldStr.slice(0, 80).replace(/\n/g, "\\n");
    // Provide more helpful error with context about what the file actually contains
    const lines = content.split("\n");
    const lineCount = lines.length;
    const firstLines = lines.slice(0, 3).join("\n");
    return {
      success: false,
      error: `No match for: "${preview}..."

The file has ${lineCount} lines. First few lines:
${firstLines}

IMPORTANT: The file content may have changed from previous edits. Regenerate with tighter anchors, or refresh file state if needed before retrying.`,
    };
  }

  // Apply replacement
  const newContent =
    content.slice(0, match.index) + newStr + content.slice(match.index + match.length);
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
          warningCount: 0,
        },
      },
    };
  }

  // Validate syntax
  const syntaxError = validateSyntax(content, newContent, relativePath);
  if (syntaxError) {
    return { success: false, error: syntaxError };
  }

  // Write with verification
  emitRuntimeUpdate(runtime, "Applying replacement...");
  const writeResult = await writeFileWithSync(path, newContent, expectedVersion, content);
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  const oldLines = oldStr.split("\n").length;
  const newLines = newStr.split("\n").length;
  const confidence = match.similarity < 1 ? ` (${Math.round(match.similarity * 100)}% match)` : "";

  // Calculate changed line range for highlighting
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(content, newContent);
  // Force sync editor with the new disk content
  await syncEditorWithDisk(path, normalizedPath, newContent, {
    relativePath,
    firstChangedLine,
    lastChangedLine,
  }, runtime);
  const diffStats = calculateDiffStats(content, newContent);

  // Get diagnostics after edit
  const diagnostics =
    args.postEditDiagnostics === false
      ? EMPTY_DIAGNOSTICS
      : await getPostEditDiagnostics(path, relativePath, runtime);

  let output = `Edited ${relativePath}: ${oldLines} → ${newLines} lines${confidence}`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? "s" : ""}`;
  }

  const aiErrors =
    diagnostics.problems.length > 0
      ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
          .filter((p) => p.severity === "error")
          .slice(0, 5)
          .map((p) => `L${p.line}:${p.column} ${p.message}`)
          .join("\n")}`
      : "";

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
        warningCount: diagnostics.warningCount,
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
    },
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
export async function handleMultiReplace(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, "/");
  const rawEdits = args.edits;
  emitRuntimeUpdate(runtime, "Applying batched edits...");

  // Validate edits array
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return {
      success: false,
      error: 'Missing or empty "edits" array. Expected: [{ oldStr, newStr }, ...]',
    };
  }

  if (rawEdits.length > 50) {
    return {
      success: false,
      error: `Too many edits (${rawEdits.length}). Maximum 50 edits per call.`,
    };
  }

  // Parse and validate each edit
  const edits: Array<{ oldStr: string; newStr: string }> = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const edit = rawEdits[i] as Record<string, unknown>;
    if (!edit || typeof edit !== "object") {
      return { success: false, error: `Edit ${i}: expected object with oldStr and newStr` };
    }
    const oldStr = fixEscapedNewlines(String(edit.oldStr ?? edit.original_snippet ?? ""));
    const newStr = fixEscapedNewlines(String(edit.newStr ?? edit.new_snippet ?? ""));
    if (!oldStr) {
      return { success: false, error: `Edit ${i}: missing "oldStr"` };
    }
    edits.push({ oldStr, newStr });
  }

  // Read file fresh from disk
  let content = "";
  let expectedVersion: number;
  try {
    const contentDoc = await readFileDocumentFresh(path);
    content = contentDoc.content;
    expectedVersion = contentDoc.version;
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
      const preview = edits[i].oldStr.slice(0, 80).replace(/\n/g, "\\n");
      return {
        success: false,
        error: `Edit ${i}: no match for "${preview}..."\n\nRegenerate the edit with tighter anchors, or refresh file state if needed before retrying.`,
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
        error: `Overlapping edits: edit ${next.editIndex} overlaps with edit ${current.editIndex}. Split into separate calls.`,
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
  const writeResult = await writeFileWithSync(path, resultContent, expectedVersion, content);
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  // Stats
  const { firstChangedLine, lastChangedLine } = calculateChangedLines(content, resultContent);
  // Sync editor
  await syncEditorWithDisk(path, normalizedPath, resultContent, {
    relativePath,
    firstChangedLine,
    lastChangedLine,
  });
  const diffStats = calculateDiffStats(content, resultContent);

  // Diagnostics
  const diagnostics =
    args.postEditDiagnostics === false
      ? EMPTY_DIAGNOSTICS
      : await getPostEditDiagnostics(path, relativePath, runtime);

  // Build summary
  const confidences = matches
    .filter((m) => m.similarity < 1)
    .map((m) => `edit ${m.editIndex}: ${Math.round(m.similarity * 100)}%`);
  const confidenceNote = confidences.length > 0 ? ` (fuzzy: ${confidences.join(", ")})` : "";

  let output = `Applied ${edits.length} edits to ${relativePath}${confidenceNote}`;
  output += ` | +${diffStats.added} -${diffStats.removed} lines`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? "s" : ""}`;
  }

  const aiErrors =
    diagnostics.problems.length > 0
      ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
          .filter((p) => p.severity === "error")
          .slice(0, 5)
          .map((p) => `L${p.line}:${p.column} ${p.message}`)
          .join("\n")}`
      : "";

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
        warningCount: diagnostics.warningCount,
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
      editCount: edits.length,
    },
  };
}

/**
 * Apply Codex patch hunks to one file atomically.
 */
export async function handleApplyPatch(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, "/");
  const patch = String(args.patch ?? "");
  const expectedVersionArg =
    typeof args.expected_version === "number" && Number.isFinite(args.expected_version)
      ? Math.floor(args.expected_version)
      : undefined;
  emitRuntimeUpdate(runtime, "Parsing patch...");

  let parsedPatch: {
    path: string;
    hunks: Array<{ lines: Array<{ op: "context" | "remove" | "add"; text: string }> }>;
  };
  try {
    parsedPatch = parseCodexPatch(patch);
  } catch (err) {
    return { success: false, error: extractErrorMessage(err) };
  }
  if (parsedPatch.path !== relativePath) {
    return {
      success: false,
      error: `Patch target mismatch: expected "${relativePath}" but patch references "${parsedPatch.path}".`,
    };
  }

  let before = "";
  let expectedVersion: number | undefined = expectedVersionArg;
  emitRuntimeUpdate(runtime, "Reading file...");
  try {
    const contentDoc = await readFileDocumentFresh(path);
    before = contentDoc.content;
    expectedVersion = expectedVersionArg ?? contentDoc.version;
  } catch {
    // Missing file is allowed only for "add-only" patch hunks.
    const hasNonAddLines = parsedPatch.hunks.some((hunk) =>
      hunk.lines.some((line) => line.op !== "add"),
    );
    if (hasNonAddLines) {
      return {
        success: false,
        error: `File not found: ${relativePath}. For new files, use add-only patch hunks or write_file.`,
      };
    }
    before = "";
    expectedVersion = undefined;
  }

  let after: string;
  try {
    emitRuntimeUpdate(runtime, "Applying patch...");
    after = applyCodexPatch(before, parsedPatch.hunks);
  } catch (err) {
    return { success: false, error: extractErrorMessage(err) };
  }

  if (after === before) {
    return { success: true, output: `No changes: ${relativePath}` };
  }

  const syntaxError = validateSyntax(before, after, relativePath);
  if (syntaxError) {
    return { success: false, error: syntaxError };
  }

  const writeResult = await writeFileWithSync(path, after, expectedVersion, before);
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  const { firstChangedLine, lastChangedLine } = calculateChangedLines(before, after);
  await syncEditorWithDisk(path, normalizedPath, after, {
    relativePath,
    firstChangedLine,
    lastChangedLine,
  }, runtime);
  const diffStats = calculateDiffStats(before, after);
  const patchStats = getCodexPatchLineStats(parsedPatch.hunks);
  const diagnostics =
    args.postEditDiagnostics === false
      ? EMPTY_DIAGNOSTICS
      : await getPostEditDiagnostics(path, relativePath, runtime);

  let output = `Applied ${parsedPatch.hunks.length} patch hunk${parsedPatch.hunks.length > 1 ? "s" : ""} to ${relativePath}`;
  output += ` | +${patchStats.added} -${patchStats.removed} lines`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? "s" : ""}`;
  }

  const aiErrors =
    diagnostics.problems.length > 0
      ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
          .filter((p) => p.severity === "error")
          .slice(0, 5)
          .map((p) => `L${p.line}:${p.column} ${p.message}`)
          .join("\n")}`
      : "";

  return {
    success: true,
    output: output + aiErrors,
    meta: {
      fileEdit: {
        relativePath,
        absolutePath: path,
        beforeContent: before.length <= 100_000 ? before : null,
        afterContent: after.length <= 100_000 ? after : null,
        firstChangedLine,
        lastChangedLine,
        added: patchStats.added,
        removed: patchStats.removed,
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
      patch: {
        hunkCount: parsedPatch.hunks.length,
      },
    },
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
      const info = await invoke<{ isDir?: boolean }>("get_file_info", { path });
      if (info?.isDir) {
        return { success: true, output: `Directory already exists: ${relativePath}` };
      }
    } catch {
      // Not found or invalid -> continue to create
    }

    await invoke("create_dir", { path });
  } catch (err) {
    const msg = extractErrorMessage(err);
    if (msg.toLowerCase().includes("already exists")) {
      return { success: true, output: `Directory already exists: ${relativePath}` };
    }
    return { success: false, error: `Failed to create: ${msg}` };
  }

  await projectStore.refreshTree();
  return {
    success: true,
    output: `Created directory: ${relativePath}`,
    meta: {
      fileEdit: {
        relativePath,
        absolutePath: path,
        beforeContent: null,
        afterContent: null,
        isNewFile: true,
        isDirectory: true,
      },
    },
  };
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
    await invoke("delete_path", { path });
  } catch (err) {
    const errMsg = extractErrorMessage(err);
    if (errMsg.includes("not found") || errMsg.includes("No such file")) {
      return { success: false, error: `File not found: ${relativePath}` };
    }
    if (errMsg.includes("permission") || errMsg.includes("denied")) {
      return { success: false, error: `Permission denied: Cannot delete ${relativePath}` };
    }
    if (errMsg.includes("directory not empty")) {
      return { success: false, error: `Directory not empty: ${relativePath}` };
    }
    return { success: false, error: `Failed to delete ${relativePath}: ${errMsg}` };
  }

  // Close if open in editor
  const openFiles = editorStore.openFiles.filter((f) =>
    isSameOrSuffixPath(f.path, path, relativePath),
  );
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
        isDirectory,
      },
    },
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
    await invoke("rename_path", { oldPath, newPath });
  } catch (err) {
    return { success: false, error: `Failed to rename: ${extractErrorMessage(err)}` };
  }

  // Update editor tabs
  const normalizeForCompare = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  const oldAbsNorm = normalizeForCompare(oldPath);
  const oldRelNorm = normalizeForCompare(oldRelPath);
  const newPathNormalized = newPath.replace(/\\/g, "/");
  const reopenPaths = new Set<string>();

  const openFiles = editorStore.openFiles.filter((f) =>
    isSameOrSuffixPath(f.path, oldPath, oldRelPath),
  );
  for (const f of openFiles) {
    const openNorm = normalizeForCompare(f.path);
    let reopenedPath = newPath;

    if (openNorm !== oldAbsNorm && openNorm !== oldRelNorm) {
      const matchedPrefix = openNorm.startsWith(`${oldAbsNorm}/`)
        ? oldAbsNorm
        : openNorm.startsWith(`${oldRelNorm}/`)
          ? oldRelNorm
          : null;

      if (matchedPrefix) {
        const suffix = f.path.replace(/\\/g, "/").slice(matchedPrefix.length);
        reopenedPath = `${newPathNormalized}${suffix}`.replace(/\//g, "\\");
      }
    }

    editorStore.closeFile(f.path, true);
    reopenPaths.add(reopenedPath);
  }

  for (const reopenedPath of reopenPaths) {
    await editorStore.openFile(reopenedPath);
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
        newAbsolutePath: newPath,
      },
    },
  };
}

/**
 * Replace a range of lines in a file
 */
export async function handleReplaceLines(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const relativePath = String(args.path);
  const path = resolvePath(relativePath);
  const normalizedPath = path.replace(/\\/g, "/");
  const startLine = Number(args.start_line);
  const endLine = Number(args.end_line);
  const rawContent = String(args.content ?? "");
  const newContent = fixEscapedNewlines(rawContent);
  const force = args.force === true;
  emitRuntimeUpdate(runtime, "Reading file...");

  // Validate line numbers
  if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
    return { success: false, error: `Invalid line range: ${startLine}-${endLine}` };
  }

  // ALWAYS read fresh from disk
  let content = "";
  let expectedVersion: number;
  try {
    const contentDoc = await readFileDocumentFresh(path);
    content = contentDoc.content;
    expectedVersion = contentDoc.version;
  } catch {
    return { success: false, error: `File not found: ${relativePath}` };
  }

  const lines = content.split("\n");
  const totalLines = lines.length;

  // Clamp end line to file length
  const actualEndLine = Math.min(endLine, totalLines);

  if (startLine > totalLines) {
    return {
      success: false,
      error: `Start line ${startLine} exceeds file length (${totalLines} lines)`,
    };
  }

  // Build new content
  emitRuntimeUpdate(runtime, "Replacing lines...");
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(actualEndLine);
  const newLines = newContent.split("\n");

  const resultContent = [...before, ...newLines, ...after].join("\n");
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
          warningCount: 0,
        },
      },
    };
  }

  // Write with verification
  const writeResult = await writeFileWithSync(path, resultContent, expectedVersion, content);
  if (!writeResult.success) {
    return { success: false, error: `Failed to write: ${writeResult.error}` };
  }

  const replacedLines = actualEndLine - startLine + 1;
  const insertedLines = newLines.length;
  // Force sync editor with the new disk content
  await syncEditorWithDisk(path, normalizedPath, resultContent, {
    relativePath,
    firstChangedLine: startLine,
    lastChangedLine: startLine + insertedLines - 1,
  }, runtime);
  const diffStats = calculateDiffStats(content, resultContent);

  // Get diagnostics after edit
  const diagnostics =
    args.postEditDiagnostics === false
      ? EMPTY_DIAGNOSTICS
      : await getPostEditDiagnostics(path, relativePath, runtime);

  let output = `Replaced lines ${startLine}-${actualEndLine} (${replacedLines} lines → ${insertedLines} lines) in ${relativePath}`;
  if (diagnostics.errorCount > 0) {
    output += ` ⚠️ ${diagnostics.errorCount} error${diagnostics.errorCount > 1 ? "s" : ""}`;
  }

  const aiErrors =
    diagnostics.problems.length > 0
      ? `\n\n[ERRORS - fix these]:\n${diagnostics.problems
          .filter((p) => p.severity === "error")
          .slice(0, 5)
          .map((p) => `L${p.line}:${p.column} ${p.message}`)
          .join("\n")}`
      : "";

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
        warningCount: diagnostics.warningCount,
      },
      diagnostics: {
        errorCount: diagnostics.errorCount,
        warningCount: diagnostics.warningCount,
        fileCount: diagnostics.fileCount,
        problems: diagnostics.problems,
      },
    },
  };
}

/**
 * Write a plan file to .volt/plans/ directory
 */
export async function handleWritePlanFile(args: Record<string, unknown>): Promise<ToolResult> {
  const filename = String(args.filename ?? "");
  const content = String(args.content ?? "");

  if (!filename) {
    return { success: false, error: "Missing filename" };
  }

  // Ensure filename ends with .md
  const planFilename = filename.endsWith(".md") ? filename : `${filename}.md`;

  // Build path: .volt/plans/<filename>
  const relativePath = `.volt/plans/${planFilename}`;
  const path = resolvePath(relativePath);

  // Ensure .volt/plans directory exists
  const plansDir = resolvePath(".volt/plans");
  try {
    await invoke("create_dir", { path: plansDir });
  } catch {
    // Directory might already exist, that's fine
  }

  // Write the plan file
  try {
    const result = await fileService.write(path, content, { source: "ai", createIfMissing: true });
    if (!result.success) {
      return { success: false, error: `Failed to write plan: ${result.error}` };
    }
  } catch (err) {
    return { success: false, error: `Failed to write plan: ${extractErrorMessage(err)}` };
  }

  // Refresh tree to show new file
  try {
    await projectStore.refreshTree();
  } catch {}

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
        filename: planFilename,
      },
    },
  };
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
  const { formatWithPrettier, isPrettierFile } = await import("$core/services/prettier");

  // Check if file type is supported
  if (!isPrettierFile(absolutePath)) {
    const ext = absolutePath.split(".").pop() || "";
    return {
      success: false,
      error: `Unsupported file type: .${ext}. Prettier supports: ts, tsx, js, jsx, json, css, scss, less, html, md, svelte, vue, yaml`,
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
      error: `Formatting failed. Make sure Prettier is installed: npm install -D prettier`,
    };
  }

  // Check if content changed
  if (formatted === content) {
    return { success: true, output: `✓ ${relativePath} already formatted` };
  }

  // Write formatted content
  try {
    const result = await fileService.write(absolutePath, formatted, { source: "ai" });
    if (!result.success) {
      return { success: false, error: `Failed to write: ${result.error}` };
    }

    // Update editor if file is open
    const openFiles = editorStore.openFiles.filter(
      (f) =>
        f.path === absolutePath ||
        f.path.endsWith("/" + relativePath) ||
        f.path.endsWith("\\" + relativePath),
    );

    if (openFiles.length > 0) {
      editorStore.updateContent(openFiles[0].path, formatted);
    }

    const linesBefore = content.split("\n").length;
    const linesAfter = formatted.split("\n").length;
    const lineDiff = linesAfter - linesBefore;
    const lineDiffStr =
      lineDiff === 0 ? "" : lineDiff > 0 ? ` (+${lineDiff} lines)` : ` (${lineDiff} lines)`;

    return {
      success: true,
      output: `✓ Formatted ${relativePath}${lineDiffStr}`,
    };
  } catch (err) {
    return { success: false, error: `Failed to write formatted file: ${extractErrorMessage(err)}` };
  }
}
