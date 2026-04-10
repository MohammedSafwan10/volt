import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

type EventHandler = (event: { payload: unknown }) => void;

const eventHandlers = new Map<string, EventHandler>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listenMock,
}));

import { createTransport } from "./transport";

function emitEvent<T>(eventName: string, payload: T): void {
  const handler = eventHandlers.get(eventName);
  if (!handler) {
    throw new Error(`No event handler for ${eventName}`);
  }
  handler({ payload });
}

describe("LspTransport restart replay ownership", () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    eventHandlers.clear();
    mocks.invokeMock.mockReset();
    mocks.listenMock.mockReset();
    setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    mocks.listenMock.mockImplementation(async (eventName: string, handler: EventHandler) => {
      eventHandlers.set(eventName, handler);
      return () => {
        eventHandlers.delete(eventName);
      };
    });

    mocks.invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "lsp_start_server":
        case "lsp_start_server_managed":
        case "lsp_restart_server":
          return {
            serverId: "typescript-test",
            serverType: "typescript",
            pid: 101,
            status: "Running",
          };
        case "lsp_send_message":
          return undefined;
        default:
          return undefined;
      }
    });
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it("does not replay initialize or initialized from TypeScript after backend restart", async () => {
    const transport = createTransport("typescript-test", "typescript", { enabled: false });

    await transport.start({
      sidecarName: "node",
      entrypoint: "typescript.js",
      args: [],
      cwd: "C:/workspace",
    });

    const initializePromise = transport.sendRequest("initialize", {
      capabilities: { workspace: {} },
    });
    emitEvent("lsp://typescript-test//message", {
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: {} },
    });
    await initializePromise;

    await transport.sendNotification("initialized", {});

    mocks.invokeMock.mockClear();

    await (transport as any).restartFromSavedConfig();

    expect(mocks.invokeMock).toHaveBeenCalledWith("lsp_restart_server", {
      serverId: "typescript-test",
    });
    expect(
      mocks.invokeMock.mock.calls.some(([command]) => command === "lsp_send_message"),
    ).toBe(false);

    await transport.stop();
  });

  it("starts a sidecar server through the managed native command", async () => {
    const transport = createTransport("typescript-test", "typescript", { enabled: false });

    await transport.start({
      sidecarName: "node",
      entrypoint: "typescript.js",
      args: [],
      cwd: "C:/workspace",
    });

    expect(mocks.invokeMock).toHaveBeenCalledWith("lsp_start_server_managed", {
      serverId: "typescript-test",
      serverType: "typescript",
      sidecarName: "node",
      entrypoint: "typescript.js",
      args: [],
      cwd: "C:/workspace",
      env: undefined,
    });
    expect(
      mocks.invokeMock.mock.calls.some(([command]) => command === "lsp_start_server"),
    ).toBe(false);

    await transport.stop();
  });

  it("schedules unhealthy restart recovery through the backend instead of a frontend timer", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "lsp_start_server":
          return {
            serverId: "typescript-test",
            serverType: "typescript",
            pid: 101,
            status: "Running",
          };
        case "lsp_check_health":
          return {
            healthy: false,
            lastResponseAt: null,
            consecutiveFailures: 1,
            lastCheckAt: Date.now(),
            avgResponseTimeMs: null,
            message: "Unhealthy: 1 consecutive failures",
          };
        case "lsp_schedule_recovery":
          return {
            scheduled: true,
            restarting: false,
            attemptsInWindow: 1,
          };
        case "lsp_stop_server":
          return undefined;
        default:
          return undefined;
      }
    });

    const transport = createTransport("typescript-test", "typescript", {
      enabled: false,
      autoRestart: true,
      failureThreshold: 1,
    });
    transport.configureRestartPolicy({
      enabled: true,
      baseDelayMs: 750,
      maxDelayMs: 15000,
      maxAttempts: 4,
      windowMs: 120000,
    });

    await transport.start({
      sidecarName: "node",
      entrypoint: "typescript.js",
      args: [],
      cwd: "C:/workspace",
    });

    await transport.checkHealth();

    expect(mocks.invokeMock).toHaveBeenCalledWith("lsp_check_health", {
      serverId: "typescript-test",
      transportConnected: true,
      failureThreshold: 1,
    });
    expect(mocks.invokeMock).toHaveBeenCalledWith("lsp_schedule_recovery", {
      serverId: "typescript-test",
      reason: "health-check failure",
      baseDelayMs: 750,
      maxDelayMs: 15000,
      maxAttempts: 4,
      windowMs: 120000,
    });
    expect(
      mocks.invokeMock.mock.calls.some(([command]) => command === "lsp_get_server_info"),
    ).toBe(false);
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    await transport.stop();
  });

  it("starts health monitoring through the backend instead of a frontend interval", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "lsp_start_server":
          return {
            serverId: "typescript-test",
            serverType: "typescript",
            pid: 101,
            status: "Running",
          };
        case "lsp_start_health_monitoring":
        case "lsp_stop_health_monitoring":
        case "lsp_reset_recovery":
          return undefined;
        default:
          return undefined;
      }
    });

    const transport = createTransport("typescript-test", "typescript", {
      enabled: true,
      intervalMs: 5000,
      failureThreshold: 2,
    });

    await transport.start({
      sidecarName: "node",
      entrypoint: "typescript.js",
      args: [],
      cwd: "C:/workspace",
    });

    expect(mocks.invokeMock).toHaveBeenCalledWith("lsp_start_health_monitoring", {
      serverId: "typescript-test",
      intervalMs: 5000,
      failureThreshold: 2,
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();

    await transport.stop();
  });

  it("schedules transport-exit recovery through the backend", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "lsp_start_server_managed":
          return {
            serverId: "typescript-test",
            serverType: "typescript",
            pid: 101,
            status: "Running",
          };
        case "lsp_schedule_recovery":
          return {
            scheduled: true,
            restarting: false,
            attemptsInWindow: 1,
          };
        case "lsp_reset_recovery":
        case "lsp_stop_server":
          return undefined;
        default:
          return undefined;
      }
    });

    const transport = createTransport("typescript-test", "typescript", { enabled: false });
    transport.configureRestartPolicy({
      enabled: true,
      baseDelayMs: 750,
      maxDelayMs: 15000,
      maxAttempts: 4,
      windowMs: 120000,
    });

    await transport.start({
      sidecarName: "node",
      entrypoint: "typescript.js",
      args: [],
      cwd: "C:/workspace",
    });

    mocks.invokeMock.mockClear();
    emitEvent("lsp://typescript-test//exit", undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.invokeMock).toHaveBeenCalledWith("lsp_schedule_recovery", {
      serverId: "typescript-test",
      reason: "transport exit",
      baseDelayMs: 750,
      maxDelayMs: 15000,
      maxAttempts: 4,
      windowMs: 120000,
    });

    await transport.stop();
  });

  it("reconnects transport state when the backend emits a restarted event", async () => {
    mocks.invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "lsp_start_server_managed":
        case "lsp_restart_server":
          return {
            serverId: "typescript-test",
            serverType: "typescript",
            pid: 101,
            status: "Running",
          };
        case "lsp_start_health_monitoring":
        case "lsp_stop_health_monitoring":
        case "lsp_reset_recovery":
          return undefined;
        default:
          return undefined;
      }
    });

    const transport = createTransport("typescript-test", "typescript", {
      enabled: true,
      intervalMs: 5000,
      failureThreshold: 2,
    });

    await transport.start({
      sidecarName: "node",
      entrypoint: "typescript.js",
      args: [],
      cwd: "C:/workspace",
    });

    emitEvent("lsp://typescript-test//exit", undefined);
    expect(transport.connected).toBe(false);

    mocks.invokeMock.mockClear();
    emitEvent("lsp://typescript-test//restarted", {
      serverId: "typescript-test",
      serverType: "typescript",
      pid: 202,
      status: "Running",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.connected).toBe(true);
    expect(
      mocks.invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "lsp_start_health_monitoring" &&
          payload?.serverId === "typescript-test" &&
          payload?.intervalMs === 5000 &&
          payload?.failureThreshold === 2,
      ),
    ).toBe(true);

    await transport.stop();
  });
});
