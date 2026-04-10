import { describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { WorkspaceLifecycleManager } from "./workspace-lifecycle";

describe("WorkspaceLifecycleManager", () => {
  it("requests workspace activation planning from the native workspace manager", async () => {
    const manager = new WorkspaceLifecycleManager();
    invokeMock.mockResolvedValue({
      hasHeavyDirs: true,
      isDartWorkspace: true,
      largeRepoMode: true,
      tasks: [
        {
          id: "start-dart-lsp",
          kind: "start_dart_lsp",
          delayMs: 120,
          phase: "light",
          serial: false,
        },
        {
          id: "start-file-watching",
          kind: "start_file_watching",
          delayMs: 80,
          phase: "light",
          serial: false,
        },
      ],
    });

    const plan = await manager.planActivation({
      rootPath: "c:/workspace",
      reuseExistingWorkspace: false,
      indexedCount: 15000,
      initialIndexDurationMs: 2100,
    });

    expect(plan.largeRepoMode).toBe(true);
    expect(plan.isDartWorkspace).toBe(true);
    expect(plan.tasks).toHaveLength(2);
    expect(invokeMock).toHaveBeenCalledWith("workspace_plan_activation", {
      request: {
        rootPath: "c:/workspace",
        reuseExistingWorkspace: false,
        indexedCount: 15000,
        initialIndexDurationMs: 2100,
      },
    });
  });

  it("runs teardown and activation hooks in registration order", async () => {
    const calls: string[] = [];
    const manager = new WorkspaceLifecycleManager();

    invokeMock.mockResolvedValue({
      closed: true,
      activeRootPath: null,
      previousRootPath: "c:/old",
      recentProjects: [],
    });

    manager.register({
      id: "first",
      teardown: async () => {
        calls.push("teardown:first");
      },
      activate: async () => {
        calls.push("activate:first");
      },
    });
    manager.register({
      id: "second",
      teardown: async () => {
        calls.push("teardown:second");
      },
      activate: async () => {
        calls.push("activate:second");
      },
    });

    await manager.teardown({
      previousRootPath: "c:/old",
      removePersistence: false,
      clearFileTree: false,
    });
    await manager.activate({ rootPath: "c:/new", previousRootPath: "c:/old" });

    expect(calls).toEqual([
      "teardown:first",
      "teardown:second",
      "activate:first",
      "activate:second",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("workspace_close", {
      request: {
        currentRootPath: "c:/old",
        removePersistence: false,
      },
    });
  });

  it("routes refresh through the native workspace_refresh command", async () => {
    const manager = new WorkspaceLifecycleManager();
    invokeMock.mockResolvedValue({
      refreshed: true,
      activeRootPath: "c:/workspace",
      recentProjects: ["c:/workspace"],
      message: null,
    });

    const result = await manager.refresh("c:/workspace");

    expect(result).toEqual({
      refreshed: true,
      activeRootPath: "c:/workspace",
      recentProjects: ["c:/workspace"],
      message: null,
    });
    expect(invokeMock).toHaveBeenCalledWith("workspace_refresh", {
      request: {
        currentRootPath: "c:/workspace",
      },
    });
  });

  it("tracks persisted workspace state from native snapshots and teardown", async () => {
    const manager = new WorkspaceLifecycleManager();

    invokeMock.mockResolvedValueOnce({
      activeRootPath: "c:/workspace",
      persistedRootPath: "c:/workspace",
      recentProjects: ["c:/workspace"],
    });

    const state = await manager.getState();
    expect(state.persistedRootPath).toBe("c:/workspace");
    expect(manager.getPersistedRootPath()).toBe("c:/workspace");

    invokeMock.mockResolvedValueOnce({
      closed: true,
      activeRootPath: null,
      previousRootPath: "c:/workspace",
      recentProjects: [],
    });

    await manager.teardown({
      previousRootPath: "c:/workspace",
      removePersistence: true,
      clearFileTree: true,
    });

    expect(manager.getPersistedRootPath()).toBeNull();
  });

  it("routes activation delay waits through the native workspace manager", async () => {
    const manager = new WorkspaceLifecycleManager();
    invokeMock.mockResolvedValue(undefined);

    await manager.waitForActivationDelay(120);

    expect(invokeMock).toHaveBeenCalledWith("workspace_wait_activation_delay", {
      delayMs: 120,
    });
  });
});
