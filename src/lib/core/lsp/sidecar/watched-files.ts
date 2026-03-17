import type { FileChangeEvent } from '$core/services/file-watch';
import { registerCleanup } from '$core/services/hmr-cleanup';

import { getLspRegistry } from './register';
import type { LspServerType } from './types';

export type WatchedFileChangeKind = 'create' | 'change' | 'delete';

export interface WatchedFileChange {
  kind: WatchedFileChangeKind;
  path: string;
}

const SERVER_DISPATCH_DEBOUNCE_MS = 120;
const SERVER_DISPATCH_CHUNK_SIZE = 100;

const JS_TS_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']);
const TAILWIND_EXTENSIONS = new Set([
  'tsx', 'jsx', 'ts', 'js', 'mts', 'cts', 'mjs', 'cjs',
  'css', 'scss', 'sass', 'less', 'svelte', 'html', 'htm', 'vue',
]);
const CSS_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less']);
const JSON_EXTENSIONS = new Set(['json', 'jsonc']);
const XML_EXTENSIONS = new Set(['xml', 'xsd', 'xsl', 'xslt', 'svg', 'plist']);

const pendingChanges = new Map<LspServerType, WatchedFileChange[]>();
const pendingTimers = new Map<LspServerType, ReturnType<typeof setTimeout>>();

function normalizePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.match(/^[a-zA-Z]:/)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

function getFilename(filePath: string): string {
  return normalizePath(filePath).split('/').pop()?.toLowerCase() ?? '';
}

function getExtension(filePath: string): string {
  const filename = getFilename(filePath);
  const lastDot = filename.lastIndexOf('.');
  return lastDot === -1 ? '' : filename.slice(lastDot + 1);
}

function pathToUri(filePath: string): string {
  const normalizedPath = normalizePath(filePath);
  const encodedPath = encodeURI(normalizedPath);
  if (normalizedPath.match(/^[a-zA-Z]:/)) {
    return `file:///${encodedPath}`;
  }
  return `file://${encodedPath}`;
}

function matchesTypeScript(path: string): boolean {
  const filename = getFilename(path);
  const extension = getExtension(path);
  return (
    JS_TS_EXTENSIONS.has(extension) ||
    filename === 'package.json' ||
    filename === 'tsconfig.json' ||
    filename.startsWith('tsconfig.') ||
    filename === 'jsconfig.json'
  );
}

function matchesEslint(path: string): boolean {
  const filename = getFilename(path);
  const extension = getExtension(path);
  return (
    JS_TS_EXTENSIONS.has(extension) ||
    filename === 'package.json' ||
    filename === '.eslintignore' ||
    filename.startsWith('.eslintrc') ||
    filename === 'eslint.config.js' ||
    filename === 'eslint.config.mjs' ||
    filename === 'eslint.config.cjs' ||
    filename === 'eslint.config.ts'
  );
}

function matchesSvelte(path: string): boolean {
  const filename = getFilename(path);
  return (
    getExtension(path) === 'svelte' ||
    filename === 'package.json' ||
    filename === 'jsconfig.json' ||
    filename === 'tsconfig.json' ||
    filename.startsWith('tsconfig.') ||
    filename.startsWith('svelte.config.') ||
    filename.startsWith('vite.config.')
  );
}

function matchesTailwind(path: string): boolean {
  const filename = getFilename(path);
  const extension = getExtension(path);
  return (
    TAILWIND_EXTENSIONS.has(extension) ||
    filename === 'package.json' ||
    filename.startsWith('tailwind.config.') ||
    filename.startsWith('postcss.config.')
  );
}

function matchesHtml(path: string): boolean {
  const extension = getExtension(path);
  return extension === 'html' || extension === 'htm';
}

function matchesCss(path: string): boolean {
  return CSS_EXTENSIONS.has(getExtension(path));
}

function matchesJson(path: string): boolean {
  return JSON_EXTENSIONS.has(getExtension(path));
}

function matchesDart(path: string): boolean {
  const filename = getFilename(path);
  return (
    getExtension(path) === 'dart' ||
    filename === 'pubspec.yaml' ||
    filename === 'pubspec.lock' ||
    filename === 'analysis_options.yaml'
  );
}

function matchesYaml(path: string): boolean {
  const extension = getExtension(path);
  return extension === 'yaml' || extension === 'yml';
}

function matchesXml(path: string): boolean {
  return XML_EXTENSIONS.has(getExtension(path));
}

const WATCHED_FILE_INTERESTS: Record<LspServerType, (path: string) => boolean> = {
  typescript: matchesTypeScript,
  tailwind: matchesTailwind,
  eslint: matchesEslint,
  svelte: matchesSvelte,
  html: matchesHtml,
  css: matchesCss,
  json: matchesJson,
  dart: matchesDart,
  yaml: matchesYaml,
  xml: matchesXml,
};

function dedupeChanges(changes: WatchedFileChange[]): WatchedFileChange[] {
  const byPath = new Map<string, WatchedFileChange>();
  for (const change of changes) {
    const normalizedPath = normalizePath(change.path);
    const existing = byPath.get(normalizedPath);
    if (!existing) {
      byPath.set(normalizedPath, { kind: change.kind, path: normalizedPath });
      continue;
    }

    if (existing.kind === 'delete' || change.kind === 'delete') {
      byPath.set(normalizedPath, { kind: 'delete', path: normalizedPath });
      continue;
    }

    if (existing.kind === 'create' || change.kind === 'create') {
      byPath.set(normalizedPath, { kind: 'create', path: normalizedPath });
      continue;
    }

    byPath.set(normalizedPath, { kind: 'change', path: normalizedPath });
  }

  return Array.from(byPath.values());
}

function changeKindToLspType(kind: WatchedFileChangeKind): 1 | 2 | 3 {
  switch (kind) {
    case 'create':
      return 1;
    case 'change':
      return 2;
    case 'delete':
      return 3;
  }
}

async function flushServerChanges(serverType: LspServerType): Promise<void> {
  const queued = pendingChanges.get(serverType) ?? [];
  pendingChanges.delete(serverType);

  const timer = pendingTimers.get(serverType);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(serverType);
  }

  const changes = dedupeChanges(queued);
  if (changes.length === 0) {
    return;
  }

  const registry = getLspRegistry();
  const transports = registry.getTransportsByType(serverType).filter((transport) => transport.connected);
  if (transports.length === 0) {
    return;
  }

  for (let index = 0; index < changes.length; index += SERVER_DISPATCH_CHUNK_SIZE) {
    const chunk = changes.slice(index, index + SERVER_DISPATCH_CHUNK_SIZE);
    const params = {
      changes: chunk.map((change) => ({
        uri: pathToUri(change.path),
        type: changeKindToLspType(change.kind),
      })),
    };

    await Promise.all(
      transports.map(async (transport) => {
        try {
          await transport.sendNotification('workspace/didChangeWatchedFiles', params);
        } catch (error) {
          console.warn(`[LSP WatchedFiles] Failed to send ${serverType} file changes:`, error);
        }
      }),
    );
  }
}

function queueServerChanges(serverType: LspServerType, changes: WatchedFileChange[]): void {
  const existing = pendingChanges.get(serverType) ?? [];
  pendingChanges.set(serverType, existing.concat(changes));

  if (pendingTimers.has(serverType)) {
    return;
  }

  const timer = setTimeout(() => {
    pendingTimers.delete(serverType);
    void flushServerChanges(serverType);
  }, SERVER_DISPATCH_DEBOUNCE_MS);
  pendingTimers.set(serverType, timer);
}

export function normalizeWatchedFileChanges(changes: FileChangeEvent[]): WatchedFileChange[] {
  const normalized: WatchedFileChange[] = [];

  for (const change of changes) {
    if (change.kind === 'rename') {
      if (change.absolutePaths[0]) {
        normalized.push({ kind: 'delete', path: change.absolutePaths[0] });
      }
      if (change.absolutePaths[1]) {
        normalized.push({ kind: 'create', path: change.absolutePaths[1] });
      }
      continue;
    }

    const kind: WatchedFileChangeKind =
      change.kind === 'modify'
        ? 'change'
        : change.kind === 'create' || change.kind === 'delete'
          ? change.kind
          : 'change';
    for (const absolutePath of change.absolutePaths) {
      normalized.push({ kind, path: absolutePath });
    }
  }

  return dedupeChanges(normalized);
}

export function dispatchWatchedFileChanges(changes: WatchedFileChange[]): void {
  const dedupedChanges = dedupeChanges(changes);
  if (dedupedChanges.length === 0) {
    return;
  }

  for (const [serverType, matcher] of Object.entries(WATCHED_FILE_INTERESTS) as Array<[
    LspServerType,
    (path: string) => boolean,
  ]>) {
    const relevantChanges = dedupedChanges.filter((change) => matcher(change.path));
    if (relevantChanges.length > 0) {
      queueServerChanges(serverType, relevantChanges);
    }
  }
}

export function resetWatchedFileDispatch(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
  pendingChanges.clear();
}

registerCleanup('lsp-watched-files', () => {
  resetWatchedFileDispatch();
});
