import type { LspTransport } from './transport';

export async function sendDidSaveForTrackedDocument(options: {
  filepath: string;
  content: string;
  transport: LspTransport | null;
  initialized: boolean;
  languageId: string;
  pathToUri: (filepath: string) => string;
}): Promise<void> {
  const {
    filepath,
    content,
    transport,
    initialized,
    languageId,
    pathToUri,
  } = options;

  if (!transport || !initialized) return;
  await transport.syncDocument(filepath, languageId, content);

  await transport.sendNotification('textDocument/didSave', {
    textDocument: { uri: pathToUri(filepath) },
  });
}

export async function getTrackedDocumentPathSet(options: {
  transport: LspTransport | null;
  normalizePath?: (filepath: string) => string;
}): Promise<Set<string>> {
  const { transport, normalizePath } = options;
  if (!transport) {
    return new Set();
  }

  const trackedDocuments = await transport.listTrackedDocuments();
  return new Set(
    trackedDocuments.map((document) =>
      normalizePath ? normalizePath(document.filePath) : document.filePath,
    ),
  );
}
