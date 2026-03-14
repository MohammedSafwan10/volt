import type { Problem } from '$shared/stores/problems.svelte';

export function hasProblemsFromSource(
  problems: Problem[],
  source: string,
): boolean {
  return problems.some((problem) => problem.source === source);
}

export function getStaleSourceFiles(
  previousFiles: Iterable<string>,
  nextFiles: Iterable<string>,
): string[] {
  const next = new Set(nextFiles);
  const stale: string[] = [];

  for (const filePath of previousFiles) {
    if (!next.has(filePath)) {
      stale.push(filePath);
    }
  }

  return stale;
}
