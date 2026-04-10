/**
 * Diagnostics tool handlers - get_diagnostics
 * 
 * Gets real diagnostics from IDE (TypeScript, Svelte, ESLint, Tailwind)
 * via the problemsStore which collects from all language servers.
 */

import { fileService } from '$core/services/file-service';
import { problemsStore } from '$shared/stores/problems.svelte';
import { projectStore } from '$shared/stores/project.svelte';
import { toolObservabilityStore } from '$features/assistant/stores/tool-observability.svelte';
import { resolvePath, truncateOutput, type ToolResult } from '$core/ai/tools/utils';
import { matchesRequestedDiagnosticPath } from './diagnostics-paths';
import type { ToolRuntimeContext } from '$core/ai/tools/runtime';
import type { Problem } from '$shared/stores/problems.svelte';

const TS_FALLBACK_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_FALLBACK_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const FALLBACK_DIAGNOSTIC_SOURCES = ['typescript (fallback)', 'javascript (fallback)'] as const;

function getFileExtension(path: string): string {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1) return '';
  return normalized.slice(lastDot);
}

function flattenDiagnosticMessage(messageText: string | { messageText: string; next?: unknown[] }): string {
  if (typeof messageText === 'string') {
    return messageText;
  }
  const base = messageText.messageText;
  const next = Array.isArray(messageText.next)
    ? messageText.next
        .map((child) =>
          child && typeof child === 'object' && 'messageText' in child
            ? flattenDiagnosticMessage(child as { messageText: string; next?: unknown[] })
            : '',
        )
        .filter(Boolean)
    : [];
  return next.length > 0 ? `${base} ${next.join(' ')}` : base;
}

async function collectFallbackDiagnostics(
  requestedPaths: string[],
  workspaceRoot: string,
): Promise<Problem[]> {
  if (requestedPaths.length === 0) {
    return [];
  }

  const ts = await import('typescript');
  const fallbackProblems: Problem[] = [];

  for (const requestedPath of requestedPaths) {
    const absolutePath = resolvePath(requestedPath).replace(/\\/g, '/');
    const extension = getFileExtension(absolutePath);
    const isTypeScriptFile = TS_FALLBACK_EXTENSIONS.has(extension);
    const isJavaScriptFile = JS_FALLBACK_EXTENSIONS.has(extension);
    if (!isTypeScriptFile && !isJavaScriptFile) {
      continue;
    }

    const doc = await fileService.read(absolutePath, true);
    if (!doc) {
      continue;
    }

    const compilerOptions: import('typescript').CompilerOptions = {
      allowJs: isJavaScriptFile,
      checkJs: false,
      noLib: true,
      noEmit: true,
      noResolve: true,
      skipLibCheck: true,
      strict: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: extension === '.tsx' || extension === '.jsx' ? ts.JsxEmit.Preserve : undefined,
    };

    const normalizedTarget = absolutePath.toLowerCase();
    const sourceFile = ts.createSourceFile(
      absolutePath,
      doc.content,
      ts.ScriptTarget.Latest,
      true,
      extension === '.tsx'
        ? ts.ScriptKind.TSX
        : extension === '.ts'
          ? ts.ScriptKind.TS
          : extension === '.jsx'
            ? ts.ScriptKind.JSX
            : ts.ScriptKind.JS,
    );
    const system = ts.sys;
    const useCaseSensitiveFileNames = system?.useCaseSensitiveFileNames ?? true;
    const getCanonicalFileName = (fileName: string) =>
      useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();

    const host: import('typescript').CompilerHost = {
      getSourceFile(fileName, languageVersion) {
        if (fileName.replace(/\\/g, '/').toLowerCase() === normalizedTarget) {
          return sourceFile;
        }
        const text = system?.readFile?.(fileName);
        return typeof text === 'string'
          ? ts.createSourceFile(fileName, text, languageVersion, true)
          : undefined;
      },
      getDefaultLibFileName() {
        return 'lib.d.ts';
      },
      writeFile() {},
      getCurrentDirectory() {
        return workspaceRoot || '/';
      },
      getDirectories(dirName) {
        return system?.getDirectories?.(dirName) ?? [];
      },
      fileExists(fileName) {
        if (fileName.replace(/\\/g, '/').toLowerCase() === normalizedTarget) {
          return true;
        }
        return system?.fileExists?.(fileName) ?? false;
      },
      readFile(fileName) {
        if (fileName.replace(/\\/g, '/').toLowerCase() === normalizedTarget) {
          return doc.content;
        }
        return system?.readFile?.(fileName);
      },
      getCanonicalFileName,
      useCaseSensitiveFileNames() {
        return useCaseSensitiveFileNames;
      },
      getNewLine() {
        return system?.newLine ?? '\n';
      },
    };

    const program = ts.createProgram([absolutePath], compilerOptions, host);
    const diagnostics = isTypeScriptFile
      ? [
          ...program.getSyntacticDiagnostics(sourceFile),
          ...program.getSemanticDiagnostics(sourceFile),
        ]
      : program.getSyntacticDiagnostics(sourceFile);

    for (const diagnostic of diagnostics) {
      if (!diagnostic.file || diagnostic.file.fileName.replace(/\\/g, '/').toLowerCase() !== normalizedTarget) {
        continue;
      }

      const start = diagnostic.start ?? 0;
      const length = diagnostic.length ?? 1;
      const startPos = diagnostic.file.getLineAndCharacterOfPosition(start);
      const endPos = diagnostic.file.getLineAndCharacterOfPosition(start + length);
      const relativePath = requestedPath.replace(/\\/g, '/').replace(/^\/+/, '');
      fallbackProblems.push({
        id: `fallback-${relativePath}-${diagnostic.code}-${start}`,
        file: absolutePath,
        fileName: relativePath.split('/').pop() || relativePath,
        line: startPos.line + 1,
        column: startPos.character + 1,
        endLine: endPos.line + 1,
        endColumn: endPos.character + 1,
        message: flattenDiagnosticMessage(diagnostic.messageText),
        severity:
          diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
        source: isTypeScriptFile ? 'typescript (fallback)' : 'javascript (fallback)',
        code: `TS${diagnostic.code}`,
      });
    }
  }

  return fallbackProblems.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
}

function syncFallbackDiagnosticsToProblemsStore(
  requestedPaths: string[],
  fallbackProblems: Problem[],
): void {
  const requestedAbsolutePaths = requestedPaths.map((path) => resolvePath(path).replace(/\\/g, '/'));

  for (const absolutePath of requestedAbsolutePaths) {
    for (const source of FALLBACK_DIAGNOSTIC_SOURCES) {
      problemsStore.clearProblemsForFile(absolutePath, source);
    }
  }

  const grouped = new Map<string, { file: string; source: string; problems: Problem[] }>();
  for (const problem of fallbackProblems) {
    const file = problem.file.replace(/\\/g, '/');
    const key = `${file}::${problem.source}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.problems.push(problem);
      continue;
    }
    grouped.set(key, {
      file,
      source: problem.source,
      problems: [problem],
    });
  }

  for (const entry of grouped.values()) {
    problemsStore.setProblemsForFile(entry.file, entry.problems, entry.source);
    problemsStore.markSourceFresh(entry.source);
  }
}

/**
 * Get errors/warnings from IDE
 * 
 * Takes array of paths, shows which files were checked
 */
export async function handleGetDiagnostics(
  args: Record<string, unknown>,
  runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const workspaceRoot = projectStore.rootPath || '';
  runtime?.onUpdate?.({
    liveStatus: 'Collecting diagnostics...',
    meta: {
      diagnosticsFreshness: problemsStore.diagnosticsFreshness,
      diagnosticsBasis: problemsStore.diagnosticsBasis,
    },
  });

  // Get paths to check - accept both 'paths' (array) and 'path' (single)
  let pathsToCheck: string[] = [];

  if (Array.isArray(args.paths)) {
    pathsToCheck = args.paths.map(p => String(p));
  } else if (args.path) {
    pathsToCheck = [String(args.path)];
  }

  // Get all problems from the store (unfiltered to avoid UI filter mismatch)
  const allProblems = problemsStore.allProblemsUnfiltered;
  const freshness = problemsStore.diagnosticsFreshness;
  runtime?.onUpdate?.({
    liveStatus:
      freshness.status === 'updating'
        ? 'Waiting for diagnostics to settle...'
        : freshness.status === 'stale'
          ? 'Collecting diagnostics (some sources stale)...'
          : 'Collecting diagnostics...',
    meta: {
      diagnosticsFreshness: freshness,
      diagnosticsBasis: problemsStore.diagnosticsBasis,
    },
  });

  // If specific paths requested, filter to those
  const normalizedPaths = pathsToCheck.map((path) => normalizePath(path, workspaceRoot));
  const checkedFiles =
    pathsToCheck.length > 0
      ? pathsToCheck
      : problemsStore.filesWithProblems.map((filePath) =>
          filePath.replace(workspaceRoot, '').replace(/^[/\\]/, ''),
        );

  const relevantProblems =
    normalizedPaths.length > 0
      ? allProblems.filter((problem) => {
          const problemPath = normalizePath(problem.file, workspaceRoot);
          return normalizedPaths.some((pathToCheck) =>
            matchesRequestedDiagnosticPath(problemPath, pathToCheck),
          );
        })
      : allProblems;
  const fallbackProblems =
    relevantProblems.length === 0 && pathsToCheck.length > 0
      ? await collectFallbackDiagnostics(pathsToCheck, workspaceRoot)
      : [];
  if (relevantProblems.length === 0 && pathsToCheck.length > 0) {
    syncFallbackDiagnosticsToProblemsStore(pathsToCheck, fallbackProblems);
  }
  const effectiveProblems = fallbackProblems.length > 0 ? fallbackProblems : relevantProblems;
  const usedFallbackDiagnostics = fallbackProblems.length > 0;

  // Format output
  const lines: string[] = [];

  // Show which files were checked
  if (pathsToCheck.length > 0) {
    const fileList = pathsToCheck.length <= 3
      ? pathsToCheck.join(', ')
      : `${pathsToCheck.slice(0, 2).join(', ')} +${pathsToCheck.length - 2} more`;
    lines.push(`Checked: ${fileList}\n`);
  }

  const freshnessLabel =
    freshness.status === 'updating'
      ? 'updating'
      : freshness.status === 'stale'
        ? 'partially stale'
        : freshness.status === 'fresh'
          ? 'fresh'
          : 'idle';
  lines.push(`Diagnostics status: ${freshnessLabel}`);
  if (freshness.activeSources.length > 0) {
    lines.push(`Sources: ${freshness.activeSources.join(', ')}`);
  }
  if (freshness.staleSources.length > 0) {
    lines.push(`Stale sources: ${freshness.staleSources.join(', ')}`);
  }
  if (usedFallbackDiagnostics) {
    lines.push('Local fallback analysis was used for the requested file(s).');
  }
  lines.push('');

  if (effectiveProblems.length === 0) {
    if (freshness.status === 'updating') {
      lines.push('No issues currently reported, but diagnostics are still updating.');
    } else if (freshness.status === 'stale') {
      lines.push('No issues currently reported, but some diagnostics sources are stale.');
    } else if (pathsToCheck.length > 0) {
      lines.push('✓ No issues found');
    } else {
      lines.push('✓ No issues in workspace');
    }
    return {
      success: true,
      output: lines.join('\n'),
      meta: {
        errorCount: 0,
        warningCount: 0,
        fileCount: 0,
        checkedFiles,
        freshness,
        diagnosticsBasis: problemsStore.diagnosticsBasis,
        problems: [],
      },
    };
  }

  // Count by severity
  const errorCount = effectiveProblems.filter(p => p.severity === 'error').length;
  const warnCount = effectiveProblems.filter(p => p.severity === 'warning').length;

  lines.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}\n`);

  // Group by file
  const byFile = new Map<string, Problem[]>();
  for (const problem of effectiveProblems) {
    const relativePath = problem.file.replace(workspaceRoot, '').replace(/^[/\\]/, '');
    if (!byFile.has(relativePath)) {
      byFile.set(relativePath, []);
    }
    byFile.get(relativePath)!.push(problem);
  }

  // Format each file's problems
  for (const [file, problems] of byFile) {
    // Sort by line number
    problems.sort((a, b) => a.line - b.line);

    const fileErrors = problems.filter(p => p.severity === 'error').length;
    const fileWarns = problems.filter(p => p.severity === 'warning').length;

    lines.push(`${file} (${fileErrors}E ${fileWarns}W)`);

    for (const problem of problems.slice(0, 8)) {
      const icon = problem.severity === 'error' ? '❌' :
        problem.severity === 'warning' ? '⚠️' : 'ℹ️';
      const source = problem.source ? ` [${problem.source}]` : '';
      const code = problem.code ? ` (${problem.code})` : '';
      lines.push(`  ${icon} L${problem.line}:${problem.column} ${problem.message}${code}${source}`);
    }

    if (problems.length > 8) {
      lines.push(`  ... +${problems.length - 8} more issues`);
    }
    lines.push('');
  }

  const { text, truncated } = truncateOutput(lines.join('\n'));

  return {
    success: true,
    output: text,
    truncated,
    meta: {
      errorCount,
      warningCount: warnCount,
      fileCount: byFile.size,
      checkedFiles,
      freshness,
      diagnosticsBasis: problemsStore.diagnosticsBasis,
      fallbackDiagnosticsUsed: usedFallbackDiagnostics,
      problems: effectiveProblems.slice(0, 50).map(p => ({
        ...p,
        relativePath: p.file.replace(workspaceRoot, '').replace(/^[/\\]/, '')
      }))
    }
  };
}

/**
 * Get structured tool observability metrics:
 * - Per-tool latency / error / retry stats
 * - Top failing signatures
 */
export async function handleGetToolMetrics(
  _runtime?: ToolRuntimeContext,
): Promise<ToolResult> {
  const aggregates = toolObservabilityStore.toolAggregates;
  const topFailingSignatures = toolObservabilityStore.topFailingSignatures;
  const topSlowTools = toolObservabilityStore.topSlowTools;
  const recentSlowEvents = toolObservabilityStore.recentSlowEvents;

  const lines: string[] = [];
  lines.push(`Total executions: ${toolObservabilityStore.totalExecutions}`);
  lines.push(`Success rate: ${(toolObservabilityStore.successRate * 100).toFixed(1)}%`);
  lines.push('');

  if (aggregates.length === 0) {
    lines.push('No tool telemetry collected yet.');
  } else {
    lines.push('Per-tool metrics:');
    for (const item of aggregates.slice(0, 30)) {
      lines.push(
        `- ${item.toolName}: total=${item.total} fail=${item.failed} retry=${item.retries} avg=${item.avgLatencyMs.toFixed(1)}ms p95=${item.p95LatencyMs.toFixed(1)}ms slow=${(item.slowRate * 100).toFixed(1)}% critical=${item.criticalCount} errorRate=${(item.errorRate * 100).toFixed(1)}%`
      );
    }
  }

  if (topSlowTools.length > 0) {
    lines.push('');
    lines.push('Top slow tools:');
    for (const item of topSlowTools.slice(0, 15)) {
      lines.push(
        `- ${item.toolName}: slowRate=${(item.slowRate * 100).toFixed(1)}% critical=${item.criticalCount} p95=${item.p95LatencyMs.toFixed(1)}ms`
      );
    }
  }

  if (topFailingSignatures.length > 0) {
    lines.push('');
    lines.push('Top failing signatures:');
    for (const entry of topFailingSignatures.slice(0, 20)) {
      lines.push(`- ${entry.failures}x ${entry.signature}`);
    }
  }

  const { text, truncated } = truncateOutput(lines.join('\n'));

  return {
    success: true,
    output: text,
    truncated,
    data: {
      totalExecutions: toolObservabilityStore.totalExecutions,
      successRate: toolObservabilityStore.successRate,
      aggregates,
      topSlowTools,
      recentSlowEvents,
      topFailingSignatures,
    },
  };
}

/**
 * Normalize path for comparison
 */
function normalizePath(path: string, workspaceRoot: string): string {
  let normalized = path.replace(/\\/g, '/').replace(/^file:\/\/\/?/i, '');
  normalized = normalized.replace(/\/\.\//g, '/');
  normalized = normalized.replace(/\/+/g, '/');

  // Remove workspace root prefix if present
  if (workspaceRoot) {
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedLower = normalized.toLowerCase();
    const normalizedRootLower = normalizedRoot.toLowerCase();
    if (
      normalizedLower === normalizedRootLower ||
      normalizedLower.startsWith(`${normalizedRootLower}/`)
    ) {
      normalized = normalized.slice(normalizedRoot.length);
    }
  }

  // Remove leading slash
  normalized = normalized.replace(/^\/+/, '');

  return normalized.toLowerCase();
}
