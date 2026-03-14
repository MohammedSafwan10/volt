import type { LspTransport } from './transport';

export type TrackedDocumentMap = Map<string, { version: number; content: string }>;

export async function rehydrateTrackedDocuments(
  openDocuments: TrackedDocumentMap,
  reopen: (filepath: string, content: string) => Promise<void>,
): Promise<void> {
  const docs = Array.from(openDocuments.entries());
  openDocuments.clear();
  for (const [filepath, doc] of docs) {
    await reopen(filepath, doc.content);
  }
}

export async function sendDidSaveForTrackedDocument(options: {
  filepath: string;
  content: string;
  openDocuments: TrackedDocumentMap;
  transport: LspTransport | null;
  initialized: boolean;
  ensureOpen: (filepath: string, content: string) => Promise<void>;
  pathToUri: (filepath: string) => string;
}): Promise<void> {
  const {
    filepath,
    content,
    openDocuments,
    transport,
    initialized,
    ensureOpen,
    pathToUri,
  } = options;

  if (!transport || !initialized) return;
  if (!openDocuments.has(filepath)) {
    await ensureOpen(filepath, content);
  }

  await transport.sendNotification('textDocument/didSave', {
    textDocument: { uri: pathToUri(filepath) },
  });
}
