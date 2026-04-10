import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
  saveMock: vi.fn(),
  showToastMock: vi.fn(),
  logOutputMock: vi.fn(),
  fileServiceReadMock: vi.fn(),
  fileServiceWriteMock: vi.fn(),
  fileServiceCreateDirMock: vi.fn(),
  fileServiceDeletePathMock: vi.fn(),
  fileServiceRenamePathMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openMock,
  save: mocks.saveMock,
}));

vi.mock("$shared/stores/toast.svelte", () => ({
  showToast: mocks.showToastMock,
}));

vi.mock("$features/terminal/stores/output.svelte", () => ({
  logOutput: mocks.logOutputMock,
}));

vi.mock("./file-service", () => ({
  fileService: {
    read: mocks.fileServiceReadMock,
    write: mocks.fileServiceWriteMock,
    createDir: mocks.fileServiceCreateDirMock,
    deletePath: mocks.fileServiceDeletePathMock,
    renamePath: mocks.fileServiceRenamePathMock,
  },
}));

vi.mock("$core/types/files", () => ({
  isFileError: (value: unknown) =>
    typeof value === "object" && value !== null && "type" in value,
  getFileErrorMessage: (error: { type: string; path?: string }) =>
    `${error.type}${error.path ? `: ${error.path}` : ""}`,
}));

import { createDirectory, createFile, deletePath, deletePathQuiet, renamePath } from "./file-system";

describe("file-system structural mutations", () => {
  beforeEach(() => {
    mocks.invokeMock.mockReset();
    mocks.openMock.mockReset();
    mocks.saveMock.mockReset();
    mocks.showToastMock.mockReset();
    mocks.logOutputMock.mockReset();
    mocks.fileServiceReadMock.mockReset();
    mocks.fileServiceWriteMock.mockReset();
    mocks.fileServiceCreateDirMock.mockReset();
    mocks.fileServiceDeletePathMock.mockReset();
    mocks.fileServiceRenamePathMock.mockReset();
  });

  it("routes deletePath through the shared file service", async () => {
    mocks.fileServiceDeletePathMock.mockResolvedValue({ success: true });

    const result = await deletePath("src/demo.ts");

    expect(result).toBe(true);
    expect(mocks.fileServiceDeletePathMock).toHaveBeenCalledWith("src/demo.ts");
    expect(mocks.invokeMock).not.toHaveBeenCalled();
  });

  it("routes renamePath through the shared file service", async () => {
    mocks.fileServiceRenamePathMock.mockResolvedValue({ success: true });

    const result = await renamePath("src/old.ts", "src/new.ts");

    expect(result).toBe(true);
    expect(mocks.fileServiceRenamePathMock).toHaveBeenCalledWith("src/old.ts", "src/new.ts");
    expect(mocks.invokeMock).not.toHaveBeenCalled();
  });

  it("routes createFile through the shared file service", async () => {
    mocks.fileServiceWriteMock.mockResolvedValue({ success: true, newVersion: 1 });

    const result = await createFile("src/new-file.ts");

    expect(result).toBe(true);
    expect(mocks.fileServiceWriteMock).toHaveBeenCalledWith("src/new-file.ts", "", {
      createIfMissing: true,
      source: "editor",
    });
    expect(mocks.invokeMock).not.toHaveBeenCalled();
  });

  it("routes createDirectory through the shared file service", async () => {
    mocks.fileServiceCreateDirMock.mockResolvedValue({ success: true });

    const result = await createDirectory("src/new-folder");

    expect(result).toBe(true);
    expect(mocks.fileServiceCreateDirMock).toHaveBeenCalledWith("src/new-folder");
    expect(mocks.invokeMock).not.toHaveBeenCalled();
  });

  it("routes quiet deletes through the document manager command", async () => {
    mocks.invokeMock.mockResolvedValue(undefined);

    const result = await deletePathQuiet("tmp/file.txt");

    expect(result).toBe(true);
    expect(mocks.invokeMock).toHaveBeenCalledWith("document_delete", { path: "tmp/file.txt" });
  });

  it("treats quiet delete of a missing path as success", async () => {
    mocks.invokeMock.mockRejectedValue({
      type: "NotFound",
      path: "tmp/missing.txt",
    });

    const result = await deletePathQuiet("tmp/missing.txt");

    expect(result).toBe(true);
    expect(mocks.invokeMock).toHaveBeenCalledWith("document_delete", { path: "tmp/missing.txt" });
  });
});
