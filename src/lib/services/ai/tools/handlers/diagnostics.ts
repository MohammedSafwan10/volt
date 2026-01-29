/**
 * Diagnostics tool handlers - get_diagnostics
 * 
 * Gets real diagnostics from IDE (TypeScript, Svelte, ESLint, Tailwind)
 * via the problemsStore which collects from all language servers.
 */

import { problemsStore } from '$lib/stores/problems.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { truncateOutput, type ToolResult } from '../utils';

/**
 * Get errors/warnings from IDE
 * 
 * Kiro-style: Takes array of paths, shows which files were checked
 */
export async function handleGetDiagnostics(args: Record<string, unknown>): Promise<ToolResult> {
  const workspaceRoot = projectStore.rootPath || '';

  // Get paths to check - accept both 'paths' (array) and 'path' (single)
  let pathsToCheck: string[] = [];

  if (Array.isArray(args.paths)) {
    pathsToCheck = args.paths.map(p => String(p));
  } else if (args.path) {
    pathsToCheck = [String(args.path)];
  }

  // Get all problems from the store
  const allProblems = problemsStore.allProblems;

  // If specific paths requested, filter to those
  let relevantProblems = allProblems;
  let checkedFiles: string[] = [];

  if (pathsToCheck.length > 0) {
    // Normalize paths for comparison
    const normalizedPaths = pathsToCheck.map(p => normalizePath(p, workspaceRoot));

    relevantProblems = allProblems.filter(problem => {
      const problemPath = normalizePath(problem.file, workspaceRoot);
      return normalizedPaths.some(p =>
        problemPath === p ||
        problemPath.endsWith('/' + p) ||
        problemPath.endsWith('\\' + p)
      );
    });

    checkedFiles = pathsToCheck;
  } else {
    // Get all files with problems
    checkedFiles = problemsStore.filesWithProblems.map(f =>
      f.replace(workspaceRoot, '').replace(/^[/\\]/, '')
    );
  }

  // Format output
  const lines: string[] = [];

  // Show which files were checked (Kiro-style)
  if (pathsToCheck.length > 0) {
    const fileList = pathsToCheck.length <= 3
      ? pathsToCheck.join(', ')
      : `${pathsToCheck.slice(0, 2).join(', ')} +${pathsToCheck.length - 2} more`;
    lines.push(`Checked: ${fileList}\n`);
  }

  if (relevantProblems.length === 0) {
    if (pathsToCheck.length > 0) {
      lines.push('✓ No issues found');
    } else {
      lines.push('✓ No issues in workspace');
    }
    return { success: true, output: lines.join('\n') };
  }

  // Count by severity
  const errorCount = relevantProblems.filter(p => p.severity === 'error').length;
  const warnCount = relevantProblems.filter(p => p.severity === 'warning').length;

  lines.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}\n`);

  // Group by file
  const byFile = new Map<string, typeof relevantProblems>();
  for (const problem of relevantProblems) {
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
      problems: relevantProblems.slice(0, 50).map(p => ({
        ...p,
        relativePath: p.file.replace(workspaceRoot, '').replace(/^[/\\]/, '')
      }))
    }
  };
}

/**
 * Normalize path for comparison
 */
function normalizePath(path: string, workspaceRoot: string): string {
  let normalized = path.replace(/\\/g, '/');

  // Remove workspace root prefix if present
  if (workspaceRoot) {
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/');
    if (normalized.startsWith(normalizedRoot)) {
      normalized = normalized.slice(normalizedRoot.length);
    }
  }

  // Remove leading slash
  normalized = normalized.replace(/^\/+/, '');

  return normalized.toLowerCase();
}
