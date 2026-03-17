import { problemsStore, type Problem } from '$shared/stores/problems.svelte';

const sourceGenerations = new Map<string, number>();

function nextSourceGeneration(source: string): number {
  const nextGeneration = (sourceGenerations.get(source) ?? 0) + 1;
  sourceGenerations.set(source, nextGeneration);
  return nextGeneration;
}

export function getSourceSessionGeneration(source: string): number {
  return sourceGenerations.get(source) ?? 0;
}

export function startSourceSession(source: string): number {
  return nextSourceGeneration(source);
}

export function markSourceSessionReady(source: string, generation: number): boolean {
  if (!isCurrentSourceGeneration(source, generation)) {
    return false;
  }

  problemsStore.markSourceFresh(source);
  return true;
}

export function markSourceSessionStale(source: string): number {
  const generation = nextSourceGeneration(source);
  problemsStore.markSourceStale(source);
  return generation;
}

export function isCurrentSourceGeneration(source: string, generation: number): boolean {
  return getSourceSessionGeneration(source) === generation;
}

export function setSourceProblemsForFile(options: {
  source: string;
  generation: number;
  filePath: string;
  problems: Problem[];
}): boolean {
  const { source, generation, filePath, problems } = options;
  if (!isCurrentSourceGeneration(source, generation)) {
    return false;
  }

  problemsStore.setProblemsForFile(
    filePath,
    problems.map((problem) => ({ ...problem, source })),
    source,
  );
  return true;
}

export function clearSourceProblemsForFile(options: {
  source: string;
  generation: number;
  filePath: string;
}): boolean {
  const { source, generation, filePath } = options;
  if (!isCurrentSourceGeneration(source, generation)) {
    return false;
  }

  problemsStore.clearProblemsForFile(filePath, source);
  return true;
}

export function resetSourceSessions(): void {
  sourceGenerations.clear();
}
