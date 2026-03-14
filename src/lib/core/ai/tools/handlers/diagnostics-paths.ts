export function matchesRequestedDiagnosticPath(
  problemPath: string,
  requestedPath: string,
): boolean {
  return problemPath === requestedPath;
}
