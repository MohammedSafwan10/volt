import { problemsStore, type Problem } from '$shared/stores/problems.svelte';

export interface BackendLspDiagnosticProblem {
  file: string;
  fileName: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: Problem['severity'];
  code?: string;
}

export interface BackendLspDiagnosticsEvent {
  serverId: string;
  source: string;
  filePath: string;
  problems: BackendLspDiagnosticProblem[];
}

export interface BackendLspDiagnosticsClearFileEvent {
  serverId: string;
  source: string;
  filePath: string;
}

export interface BackendLspDiagnosticsSourceStateEvent {
  serverId: string;
  source: string;
  state: 'fresh' | 'stale';
}

export function applyBackendDiagnostics(event: BackendLspDiagnosticsEvent): void {
  problemsStore.setProblemsForFile(
    event.filePath,
    event.problems.map((problem, index) => ({
      ...problem,
      id: `${event.source}:${problem.file}:${problem.line}:${problem.column}:${index}`,
      source: event.source,
    })),
    event.source,
  );
}

export function clearBackendDiagnosticsFile(event: BackendLspDiagnosticsClearFileEvent): void {
  problemsStore.clearProblemsForFile(event.filePath, event.source);
}

export function applyBackendDiagnosticsSourceState(
  event: BackendLspDiagnosticsSourceStateEvent,
): void {
  if (event.state === 'fresh') {
    problemsStore.markSourceFresh(event.source);
    return;
  }

  problemsStore.markSourceStale(event.source);
}
