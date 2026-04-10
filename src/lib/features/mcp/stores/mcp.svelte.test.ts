import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => undefined),
  homeDirMock: vi.fn(async () => "C:/Users/test"),
  joinMock: vi.fn(async (...parts: string[]) => parts.join("/")),
  readFileQuietMock: vi.fn(async () => null),
  getFileInfoQuietMock: vi.fn(async () => null),
  showToastMock: vi.fn(),
  logOutputMock: vi.fn(),
  registerCleanupMock: vi.fn(),
}));

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listenMock,
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: mocks.homeDirMock,
  join: mocks.joinMock,
}));

vi.mock("$core/services/file-system", () => ({
  readFileQuiet: mocks.readFileQuietMock,
  getFileInfoQuiet: mocks.getFileInfoQuietMock,
}));

vi.mock("$shared/stores/toast.svelte", () => ({
  showToast: mocks.showToastMock,
}));

vi.mock("$features/terminal/stores/output.svelte", () => ({
  logOutput: mocks.logOutputMock,
}));

vi.mock("$core/services/hmr-cleanup", () => ({
  registerCleanup: mocks.registerCleanupMock,
}));

describe("mcpStore managed native startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invokeMock.mockReset();
    mocks.listenMock.mockClear();
    mocks.homeDirMock.mockClear();
    mocks.joinMock.mockClear();
    mocks.readFileQuietMock.mockClear();
    mocks.getFileInfoQuietMock.mockClear();
    mocks.showToastMock.mockReset();
    mocks.logOutputMock.mockReset();
  });

  afterEach(async () => {
    const { mcpStore } = await import("./mcp.svelte");
    await mcpStore.cleanup();
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("starts a server through the managed native command", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === "start_mcp_server_managed") {
        return {
          id: "demo",
          name: "demo",
          status: "connected",
          tools: [{ name: "ping" }],
        };
      }
      return undefined;
    });

    const { mcpStore } = await import("./mcp.svelte");
    mcpStore.userConfig = {
      mcpServers: {
        demo: {
          command: "npx",
          args: ["demo-server"],
          autoApprove: ["ping"],
        },
      },
    };

    await mcpStore.startServer("demo");

    expect(mocks.invokeMock).toHaveBeenCalledWith("start_mcp_server_managed", {
      serverId: "demo",
      config: {
        command: "npx",
        args: ["demo-server"],
        env: {},
        disabled: false,
        auto_approve: ["ping"],
      },
      maxRetries: 3,
      retryDelayMs: 30000,
    });
    expect(mocks.invokeMock.mock.calls.some(([command]) => command === "start_mcp_server")).toBe(
      false,
    );
  });

  it("does not schedule frontend retry timers after a managed start failure", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === "start_mcp_server_managed") {
        throw new Error("timed out");
      }
      return undefined;
    });

    const { mcpStore } = await import("./mcp.svelte");
    mcpStore.userConfig = {
      mcpServers: {
        demo: {
          command: "npx",
        },
      },
    };

    await mcpStore.startServer("demo", { showErrorToast: false });
    await vi.advanceTimersByTimeAsync(31000);

    expect(
      mocks.invokeMock.mock.calls.filter(([command]) => command === "start_mcp_server_managed"),
    ).toHaveLength(1);
  });

  it("starts enabled servers through the managed native batch command", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === "start_mcp_servers_managed") {
        return [
          {
            id: "demo",
            name: "demo",
            status: "connected",
            tools: [{ name: "ping" }],
          },
        ];
      }
      return undefined;
    });

    const { mcpStore } = await import("./mcp.svelte");
    mcpStore.userConfig = {
      mcpServers: {
        demo: {
          command: "npx",
          args: ["demo-server"],
        },
        disabled: {
          command: "npx",
          disabled: true,
        },
        "brave-search": {
          command: "npx",
        },
      },
    };

    const startPromise = (mcpStore as any).startEnabledServers();
    await vi.runAllTimersAsync();
    await startPromise;

    expect(mocks.invokeMock).toHaveBeenCalledWith("start_mcp_servers_managed", {
      servers: {
        demo: {
          command: "npx",
          args: ["demo-server"],
          env: {},
          disabled: false,
          auto_approve: [],
        },
      },
      maxRetries: 3,
      retryDelayMs: 30000,
    });
    expect(
      mocks.invokeMock.mock.calls.some(([command]) => command === "start_mcp_server_managed"),
    ).toBe(false);
    expect(mcpStore.servers.get("demo")?.status).toBe("connected");
    expect(mcpStore.servers.get("disabled")?.status).toBe("stopped");
    expect(mcpStore.servers.get("brave-search")?.status).toBe("stopped");
  });
});
