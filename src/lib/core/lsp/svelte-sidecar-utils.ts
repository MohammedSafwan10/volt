import type { ProblemSeverity } from '$shared/stores/problems.svelte';

export function getSvelteLanguageId(_filepath: string): string {
  return 'svelte';
}

export function sveltePathToUri(filepath: string): string {
  let normalizedPath = filepath.replace(/\\/g, '/');
  if (normalizedPath.match(/^[a-zA-Z]:/)) {
    normalizedPath = normalizedPath[0].toLowerCase() + normalizedPath.slice(1);
  }
  const encodedPath = encodeURI(normalizedPath);
  if (normalizedPath.match(/^[a-zA-Z]:/)) {
    return `file:///${encodedPath}`;
  }
  return `file://${encodedPath}`;
}

export function svelteUriToPath(uri: string): string {
  let path = uri.replace('file://', '');
  if (path.match(/^\/[a-zA-Z]:/)) {
    path = path.slice(1);
  }
  if (path.match(/^[a-zA-Z]:/)) {
    path = path[0].toLowerCase() + path.slice(1);
  }
  return path.replace(/\\/g, '/');
}

export function mapSvelteSeverity(lspSeverity: number): ProblemSeverity {
  switch (lspSeverity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'info';
  }
}
