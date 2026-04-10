import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn<(eventName: string, handler: EventHandler) => Promise<() => void>>(
    async () => () => undefined,
  ),
}));

type EventHandler = (event: { payload: unknown }) => void;

const nativeEventHandlers = new Map<string, EventHandler>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listenMock,
}));

vi.mock("$core/lsp/typescript-sidecar", () => ({
  isTsLspConnected: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/eslint-sidecar", () => ({
  notifyEslintDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/svelte-sidecar", () => ({
  isSvelteLspConnected: vi.fn(() => false),
  notifySvelteDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/html-sidecar", () => ({
  isHtmlLspConnected: vi.fn(() => false),
  notifyHtmlDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/css-sidecar", () => ({
  isCssLspConnected: vi.fn(() => false),
  notifyCssDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/json-sidecar", () => ({
  isJsonLspConnected: vi.fn(() => false),
  notifyJsonDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/dart-sidecar", () => ({
  isDartLspRunning: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/yaml-sidecar", () => ({
  isYamlLspRunning: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/xml-sidecar", () => ({
  isXmlLspRunning: vi.fn(() => false),
  notifyDocumentChanged: vi.fn(),
}));
vi.mock("$core/lsp/tailwind-sidecar", () => ({
  isTailwindLspConnected: vi.fn(() => false),
  notifyTailwindDocumentChanged: vi.fn(),
}));

import { fileService, workspaceMutationFileBackend } from "./file-service";

function emitNativeEvent<T>(eventName: string, payload: T): void {
  const handler = nativeEventHandlers.get(eventName);
  if (!handler) {
    throw new Error(`No native event handler registered for ${eventName}`);
  }
  handler({ payload });
}

describe("fileService workspace mutation backend", () => {
  beforeEach(() => {
    mocks.invokeMock.mockReset();
    mocks.invokeMock.mockResolvedValue(undefined);
    mocks.listenMock.mockClear();
    mocks.listenMock.mockImplementation(async (eventName: string, handler: EventHandler) => {
      nativeEventHandlers.set(eventName, handler);
      return () => {
        nativeEventHandlers.delete(eventName);
      };
    });
    fileService.closeDocument("src/old-name.ts");
    fileService.closeDocument("src/new-name.ts");
    fileService.closeDocument("src/to-delete.ts");
  });

  it("exposes structural mutation methods on the shared backend", () => {
    expect(typeof workspaceMutationFileBackend.createDir).toBe("function");
    expect(typeof workspaceMutationFileBackend.deletePath).toBe("function");
    expect(typeof workspaceMutationFileBackend.renamePath).toBe("function");
  });

  it("creates directories through the native command", async () => {
    mocks.invokeMock.mockResolvedValue(undefined);

    const result = await fileService.createDir("src\\new-dir");

    expect(result).toEqual({ success: true });
    expect(mocks.invokeMock).toHaveBeenCalledWith("create_dir", { path: "src/new-dir" });
  });

  it("deletes cached documents when the native close event arrives", async () => {
    mocks.invokeMock.mockResolvedValue(undefined);
    fileService.setCachedDocument("src/to-delete.ts", {
      path: "src/to-delete.ts",
      content: "obsolete",
      version: 2,
      diskVersion: 2,
      isDirty: false,
      lastModified: 1,
      language: "typescript",
    });

    const result = await fileService.deletePath("src\\to-delete.ts");

    expect(result).toEqual({ success: true });
    expect(mocks.invokeMock).toHaveBeenCalledWith("document_delete", { path: "src/to-delete.ts" });
    expect(fileService.getDocument("src/to-delete.ts")).not.toBeNull();

    emitNativeEvent("document://closed", { path: "src/to-delete.ts" });

    expect(fileService.getDocument("src/to-delete.ts")).toBeNull();
  });

  it("deletes cached descendant documents when native close events arrive for a removed folder", async () => {
    mocks.invokeMock.mockResolvedValue(undefined);
    fileService.setCachedDocument("src/to-delete/one.ts", {
      path: "src/to-delete/one.ts",
      content: "one",
      version: 1,
      diskVersion: 1,
      isDirty: false,
      lastModified: 1,
      language: "typescript",
    });
    fileService.setCachedDocument("src/to-delete/nested/two.ts", {
      path: "src/to-delete/nested/two.ts",
      content: "two",
      version: 2,
      diskVersion: 2,
      isDirty: true,
      lastModified: 2,
      language: "typescript",
    });

    const result = await fileService.deletePath("src/to-delete");

    expect(result).toEqual({ success: true });
    emitNativeEvent("document://closed", { path: "src/to-delete/one.ts" });
    emitNativeEvent("document://closed", { path: "src/to-delete/nested/two.ts" });

    expect(fileService.getDocument("src/to-delete/one.ts")).toBeNull();
    expect(fileService.getDocument("src/to-delete/nested/two.ts")).toBeNull();
  });

  it("keeps cached documents until closeDocument receives the native close event", async () => {
    mocks.invokeMock.mockResolvedValue(undefined);
    fileService.setCachedDocument("src/close-me.ts", {
      path: "src/close-me.ts",
      content: "bye",
      version: 1,
      diskVersion: 1,
      isDirty: false,
      lastModified: 1,
      language: "typescript",
    });

    fileService.closeDocument("src\\close-me.ts");
    await Promise.resolve();

    expect(
      mocks.invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "document_close" && payload?.path === "src/close-me.ts",
      ),
    ).toBe(true);
    expect(fileService.getDocument("src/close-me.ts")).not.toBeNull();

    emitNativeEvent("document://closed", { path: "src/close-me.ts" });

    expect(fileService.getDocument("src/close-me.ts")).toBeNull();
  });

  it("moves cached documents when the native rename event arrives", async () => {
    mocks.invokeMock.mockResolvedValue(undefined);
    fileService.setCachedDocument("src/old-name.ts", {
      path: "src/old-name.ts",
      content: "export const renamed = true;",
      version: 7,
      diskVersion: 7,
      isDirty: false,
      lastModified: 1,
      language: "typescript",
    });

    const result = await fileService.renamePath("src\\old-name.ts", "src\\new-name.ts");

    expect(result).toEqual({ success: true });
    expect(mocks.invokeMock).toHaveBeenCalledWith("document_rename", {
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
    });
    expect(fileService.getDocument("src/old-name.ts")).not.toBeNull();
    expect(fileService.getDocument("src/new-name.ts")).toBeNull();

    emitNativeEvent("document://renamed", {
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      state: {
        path: "src/new-name.ts",
        content: "export const renamed = true;",
        version: 7,
        diskVersion: 7,
        isDirty: false,
        lastModified: 2,
        language: "typescript",
      },
    });

    expect(fileService.getDocument("src/old-name.ts")).toBeNull();
    expect(fileService.getDocument("src/new-name.ts")).toMatchObject({
      path: "src/new-name.ts",
      content: "export const renamed = true;",
      version: 7,
    });
  });

  it("moves cached descendant documents when native rename events arrive for a renamed folder", async () => {
    mocks.invokeMock.mockResolvedValue(undefined);
    fileService.setCachedDocument("src/old-name/one.ts", {
      path: "src/old-name/one.ts",
      content: "one",
      version: 1,
      diskVersion: 1,
      isDirty: false,
      lastModified: 1,
      language: "typescript",
    });
    fileService.setCachedDocument("src/old-name/nested/two.ts", {
      path: "src/old-name/nested/two.ts",
      content: "two",
      version: 2,
      diskVersion: 2,
      isDirty: false,
      lastModified: 2,
      language: "typescript",
    });

    const result = await fileService.renamePath("src/old-name", "src/new-name");

    expect(result).toEqual({ success: true });

    emitNativeEvent("document://renamed", {
      oldPath: "src/old-name/one.ts",
      newPath: "src/new-name/one.ts",
      state: {
        path: "src/new-name/one.ts",
        content: "one",
        version: 1,
        diskVersion: 1,
        isDirty: false,
        lastModified: 3,
        language: "typescript",
      },
    });
    emitNativeEvent("document://renamed", {
      oldPath: "src/old-name/nested/two.ts",
      newPath: "src/new-name/nested/two.ts",
      state: {
        path: "src/new-name/nested/two.ts",
        content: "two",
        version: 2,
        diskVersion: 2,
        isDirty: false,
        lastModified: 4,
        language: "typescript",
      },
    });

    expect(fileService.getDocument("src/old-name/one.ts")).toBeNull();
    expect(fileService.getDocument("src/old-name/nested/two.ts")).toBeNull();
    expect(fileService.getDocument("src/new-name/one.ts")).toMatchObject({
      path: "src/new-name/one.ts",
      content: "one",
    });
    expect(fileService.getDocument("src/new-name/nested/two.ts")).toMatchObject({
      path: "src/new-name/nested/two.ts",
      content: "two",
    });
  });

  it("clears cached dirty state immediately after a successful write", async () => {
    mocks.invokeMock.mockResolvedValue({
      success: true,
      newVersion: 4,
      state: {
        path: "src/dirty.txt",
        content: "after",
        version: 4,
        diskVersion: 3,
        isDirty: false,
        lastModified: 44,
        language: "plaintext",
      },
    });
    fileService.setCachedDocument("src/dirty.txt", {
      path: "src/dirty.txt",
      content: "before",
      version: 3,
      diskVersion: 2,
      isDirty: true,
      lastModified: 1,
      language: "plaintext",
    });

    const result = await fileService.write("src\\dirty.txt", "after", { source: "editor" });

    expect(result).toEqual({
      success: true,
      newVersion: 4,
      error: undefined,
      conflictContent: undefined,
    });
    expect(fileService.isDirty("src/dirty.txt")).toBe(false);
    expect(fileService.getDocument("src/dirty.txt")).toMatchObject({
      path: "src/dirty.txt",
      content: "after",
      version: 4,
      diskVersion: 3,
      isDirty: false,
      lastModified: 44,
    });
  });

  it("hydrates cached state from the native save result", async () => {
    mocks.invokeMock.mockResolvedValue({
      success: true,
      newVersion: 5,
      state: {
        path: "src/save-me.ts",
        content: "saved text",
        version: 5,
        diskVersion: 5,
        isDirty: false,
        lastModified: 55,
        language: "typescript",
      },
    });
    fileService.setCachedDocument("src/save-me.ts", {
      path: "src/save-me.ts",
      content: "saved text",
      version: 4,
      diskVersion: 3,
      isDirty: true,
      lastModified: 1,
      language: "typescript",
    });

    const result = await fileService.save("src\\save-me.ts");

    expect(result).toEqual({
      success: true,
      newVersion: 5,
      error: undefined,
      conflictContent: undefined,
    });
    expect(mocks.invokeMock).toHaveBeenCalledWith("document_save", { path: "src/save-me.ts" });
    expect(fileService.getDocument("src/save-me.ts")).toMatchObject({
      path: "src/save-me.ts",
      content: "saved text",
      version: 5,
      diskVersion: 5,
      isDirty: false,
      lastModified: 55,
    });
  });

  it("does not re-dirty a clean document when a late native edit event repeats the same content", async () => {
    fileService.setCachedDocument("src/race.txt", {
      path: "src/race.txt",
      content: "saved",
      version: 2,
      diskVersion: 2,
      isDirty: false,
      lastModified: 10,
      language: "plaintext",
    });

    emitNativeEvent("document://changed", {
      path: "src/race.txt",
      content: "saved",
      version: 3,
      diskVersion: 2,
      isDirty: true,
      source: "editor",
      previousContent: "before",
    });

    expect(fileService.isDirty("src/race.txt")).toBe(false);
    expect(fileService.getDocument("src/race.txt")).toMatchObject({
      path: "src/race.txt",
      content: "saved",
      version: 3,
      diskVersion: 2,
      isDirty: false,
    });
  });

  it("does not mutate cached document state until the native edit event arrives", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === "document_apply_edit") {
        return {
          state: {
            path: "src/live-edit.ts",
            content: "edited",
            version: 4,
            diskVersion: 3,
            isDirty: true,
            lastModified: 2,
            language: "typescript",
          },
        };
      }
      return undefined;
    });

    fileService.setCachedDocument("src/live-edit.ts", {
      path: "src/live-edit.ts",
      content: "before",
      version: 3,
      diskVersion: 3,
      isDirty: false,
      lastModified: 1,
      language: "typescript",
    });
    const changes: Array<{ path: string; content: string; version: number }> = [];
    const unsubscribe = fileService.subscribeAll((event) => {
      changes.push({
        path: event.path,
        content: event.content,
        version: event.version,
      });
    });

    fileService.updateContent("src\\live-edit.ts", "edited", "editor");

    expect(fileService.getDocument("src/live-edit.ts")).toMatchObject({
      path: "src/live-edit.ts",
      content: "before",
      version: 3,
      diskVersion: 3,
      isDirty: false,
    });
    expect(changes).toEqual([]);

    emitNativeEvent("document://changed", {
      path: "src/live-edit.ts",
      content: "edited",
      version: 4,
      diskVersion: 3,
      isDirty: true,
      source: "editor",
    });

    expect(fileService.getDocument("src/live-edit.ts")).toMatchObject({
      path: "src/live-edit.ts",
      content: "edited",
      version: 4,
      diskVersion: 3,
      isDirty: true,
    });
    expect(changes).toEqual([
      {
        path: "src/live-edit.ts",
        content: "edited",
        version: 4,
      },
    ]);

    unsubscribe();
    fileService.closeDocument("src/live-edit.ts");
  });

  it("routes batch writes through the native document command", async () => {
    mocks.invokeMock.mockResolvedValue({
      success: true,
      states: [
        {
          path: "src/a.ts",
          content: "alpha",
          version: 5,
          diskVersion: 5,
          isDirty: false,
          lastModified: 77,
          language: "typescript",
        },
        {
          path: "src/b.ts",
          content: "beta",
          version: 6,
          diskVersion: 6,
          isDirty: false,
          lastModified: 88,
          language: "typescript",
        },
      ],
    });
    fileService.setCachedDocument("src/a.ts", {
      path: "src/a.ts",
      content: "stale",
      version: 99,
      diskVersion: 99,
      isDirty: true,
      lastModified: 1,
      language: "typescript",
    });

    const result = await fileService.batchWrite(
      [
        { path: "src\\a.ts", content: "alpha" },
        { path: "src\\b.ts", content: "beta" },
      ],
      { expectedVersion: 4, source: "ai" },
    );

    expect(result).toEqual({
      success: true,
      newVersion: undefined,
      error: undefined,
      conflictContent: undefined,
    });
    expect(mocks.invokeMock).toHaveBeenCalledWith("document_batch_write", {
      writes: [
        { path: "src/a.ts", content: "alpha" },
        { path: "src/b.ts", content: "beta" },
      ],
      expectedVersion: 4,
      source: "ai",
      force: false,
      createIfMissing: false,
    });
    expect(fileService.getDocument("src/a.ts")).toMatchObject({
      path: "src/a.ts",
      content: "alpha",
      version: 5,
      diskVersion: 5,
      isDirty: false,
      lastModified: 77,
    });
    expect(fileService.getDocument("src/b.ts")).toMatchObject({
      path: "src/b.ts",
      content: "beta",
      version: 6,
      diskVersion: 6,
      isDirty: false,
      lastModified: 88,
    });
  });

  it("surfaces native batch write conflicts without frontend rollback logic", async () => {
    mocks.invokeMock.mockResolvedValue({
      success: false,
      error: "Version conflict in src/a.ts",
      conflictContent: "server",
    });
    fileService.setCachedDocument("src/a.ts", {
      path: "src/a.ts",
      content: "local",
      version: 3,
      diskVersion: 2,
      isDirty: true,
      lastModified: 1,
      language: "typescript",
    });

    const result = await fileService.batchWrite([{ path: "src/a.ts", content: "next" }], {
      expectedVersion: 2,
      source: "editor",
    });

    expect(result).toEqual({
      success: false,
      newVersion: undefined,
      error: "Version conflict in src/a.ts",
      conflictContent: "server",
    });
    expect(mocks.invokeMock).toHaveBeenCalledWith("document_batch_write", {
      writes: [{ path: "src/a.ts", content: "next" }],
      expectedVersion: 2,
      source: "editor",
      force: false,
      createIfMissing: false,
    });
    expect(fileService.getDocument("src/a.ts")).toMatchObject({
      path: "src/a.ts",
      content: "local",
      version: 3,
      diskVersion: 2,
      isDirty: true,
    });
  });

  it("returns the cached native save state without refetching the document", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === "document_save") {
        return {
          success: true,
          newVersion: 8,
          state: {
            path: "src/final.ts",
            content: "final",
            version: 8,
            diskVersion: 8,
            isDirty: false,
            lastModified: 99,
            language: "typescript",
          },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    fileService.setCachedDocument("src/final.ts", {
      path: "src/final.ts",
      content: "draft",
      version: 7,
      diskVersion: 6,
      isDirty: true,
      lastModified: 1,
      language: "typescript",
    });

    const result = await fileService.saveAndGetDocument("src\\final.ts");

    expect(result.result).toEqual({
      success: true,
      newVersion: 8,
      error: undefined,
      conflictContent: undefined,
    });
    expect(result.document).toMatchObject({
      path: "src/final.ts",
      content: "final",
      version: 8,
      diskVersion: 8,
      isDirty: false,
      lastModified: 99,
    });
    expect(mocks.invokeMock).toHaveBeenCalledWith("document_save", { path: "src/final.ts" });
    expect(mocks.invokeMock.mock.calls.some(([command]) => command === "document_get")).toBe(false);
  });

  it("hydrates dirty documents from the native dirty list command", async () => {
    mocks.invokeMock.mockResolvedValue([
      {
        path: "src/dirty-a.ts",
        content: "one",
        version: 3,
        diskVersion: 2,
        isDirty: true,
        lastModified: 11,
        language: "typescript",
      },
      {
        path: "src/dirty-b.ts",
        content: "two",
        version: 7,
        diskVersion: 5,
        isDirty: true,
        lastModified: 22,
        language: "typescript",
      },
    ]);

    const result = await fileService.getDirtyDocuments();

    expect(mocks.invokeMock.mock.calls.some(([command]) => command === "document_list_dirty")).toBe(
      true,
    );
    expect(result).toEqual([
      {
        path: "src/dirty-a.ts",
        content: "one",
        version: 3,
        diskVersion: 2,
        isDirty: true,
        lastModified: 11,
        language: "typescript",
      },
      {
        path: "src/dirty-b.ts",
        content: "two",
        version: 7,
        diskVersion: 5,
        isDirty: true,
        lastModified: 22,
        language: "typescript",
      },
    ]);
    expect(fileService.getDocument("src/dirty-a.ts")).toMatchObject({
      path: "src/dirty-a.ts",
      content: "one",
      version: 3,
      diskVersion: 2,
      isDirty: true,
    });
    expect(fileService.getDocument("src/dirty-b.ts")).toMatchObject({
      path: "src/dirty-b.ts",
      content: "two",
      version: 7,
      diskVersion: 5,
      isDirty: true,
    });
  });
});
