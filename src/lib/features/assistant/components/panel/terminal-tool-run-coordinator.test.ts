import { describe, expect, it, vi } from "vitest";
import { createTerminalToolRunCoordinator } from "./terminal-tool-run-coordinator";
import { createTerminalToolRunStore } from "./terminal-tool-run-store";
import { handleRunCommandThroughCoordinatorForTest } from "$lib/core/ai/tools/handlers/terminal";

describe("terminal-tool-run-coordinator", () => {
  it("marks foreground command completed with bounded excerpt", async () => {
    const store = createTerminalToolRunStore();
    const session = {
      id: "term-1",
      getCleanOutputCursor: () => 10,
      executeCommand: vi.fn().mockResolvedValue({
        output: "owned output\nmore\n",
        exitCode: 0,
        timedOut: false,
      }),
      readCleanOutputSince: vi
        .fn()
        .mockReturnValue({
          text: "owned output\nmore\n",
          nextOffset: 28,
          truncatedBeforeOffset: false,
        }),
    };

    const coordinator = createTerminalToolRunCoordinator({
      runStore: store,
      getSession: vi.fn().mockResolvedValue(session),
      classifyLongRunning: vi.fn().mockReturnValue(false),
      trackDetachedProcess: vi.fn(),
    });

    const result = await coordinator.runForeground({
      runId: "run-1",
      toolCallId: "tool-1",
      command: "echo hi",
      cwd: "C:/tauri/volt",
      timeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(store.get("run-1")).toMatchObject({
      state: "completed",
      excerpt: "owned output\nmore\n",
      captureStartOffset: 10,
      captureEndOffset: 28,
    });
  });

  it("transitions long-running commands to detached instead of leaving them running", async () => {
    const store = createTerminalToolRunStore();
    const session = {
      id: "term-2",
      getCleanOutputCursor: () => 3,
      executeCommand: vi.fn().mockResolvedValue({
        output: "ready on http://localhost:5173\n",
        exitCode: 0,
        timedOut: false,
      }),
      readCleanOutputSince: vi.fn()
        .mockReturnValueOnce({
          text: "",
          nextOffset: 3,
          truncatedBeforeOffset: false,
        })
        .mockReturnValueOnce({
          text: "ready on http://localhost:5173\n",
          nextOffset: 40,
          truncatedBeforeOffset: false,
        }),
    };

    const classifyLongRunning = vi
      .fn()
      .mockImplementation((_command: string, transcript: string) =>
        transcript.includes("http://localhost:5173"),
      );

    const coordinator = createTerminalToolRunCoordinator({
      runStore: store,
      getSession: vi.fn().mockResolvedValue(session),
      classifyLongRunning,
      trackDetachedProcess: vi
        .fn()
        .mockReturnValue({ processId: 8 }),
    });

    const result = await coordinator.runForeground({
      runId: "run-2",
      toolCallId: "tool-2",
      command: "npm run dev",
      cwd: "C:/tauri/volt",
      timeoutMs: 1000,
    });

    expect(result.success).toBe(true);
    expect(store.get("run-2")).toMatchObject({
      state: "detached",
      executionMode: "background_detached",
      processId: 8,
      excerpt: "ready on http://localhost:5173\n",
      captureEndOffset: 40,
    });
    expect(classifyLongRunning).toHaveBeenCalledWith(
      "npm run dev",
      "ready on http://localhost:5173\n",
    );
    expect(result.output).toBe("ready on http://localhost:5173\n");
  });

  it("fails cleanly when session acquisition dies before launch", async () => {
    const store = createTerminalToolRunStore();
    const coordinator = createTerminalToolRunCoordinator({
      runStore: store,
      getSession: vi.fn().mockRejectedValue(new Error("boom")),
      classifyLongRunning: vi.fn().mockReturnValue(false),
      trackDetachedProcess: vi.fn(),
    });

    const result = await coordinator.runForeground({
      runId: "run-3",
      toolCallId: "tool-3",
      command: "pnpm lint",
      cwd: "C:/tauri/volt",
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    expect(store.get("run-3")).toMatchObject({
      state: "failed",
      failureReason: "boom",
    });
  });

  it("routes run_command through the terminal tool coordinator", async () => {
    const coordinator = {
      runForeground: vi.fn().mockResolvedValue({
        success: true,
        output: "ready on http://localhost:5173",
        meta: {
          terminalRun: {
            state: "detached",
            processId: 9,
            terminalId: "term-9",
            detectedUrl: "http://localhost:5173",
          },
        },
      }),
    };

    const result = await handleRunCommandThroughCoordinatorForTest(coordinator, {
      command: "npm run dev",
      cwd: "C:/tauri/volt",
    });

    expect(result.success).toBe(true);
    expect(coordinator.runForeground).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npm run dev",
        cwd: "C:/tauri/volt",
      }),
    );
    expect(result.meta).toMatchObject({
      processId: 9,
      terminalId: "term-9",
    });
    expect(result.output).toContain("http://localhost:5173");
  });
});
