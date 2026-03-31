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

  it("surfaces failure reasons for foreground command failures", async () => {
    const store = createTerminalToolRunStore();
    const session = {
      id: "term-4",
      info: { shell: "powershell.exe" },
      getCleanOutputCursor: () => 0,
      executeCommand: vi.fn().mockResolvedValue({
        output: "ParserError output",
        exitCode: 1,
        timedOut: false,
      }),
      readCleanOutputSince: vi.fn().mockReturnValue({
        text: "ParserError output",
        nextOffset: 18,
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
      runId: "run-4",
      toolCallId: "tool-4",
      command: "bad command",
      cwd: "C:/tauri/volt",
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Command failed with exit code 1");
    expect(store.get("run-4")).toMatchObject({
      state: "failed",
      failureReason: "Command failed with exit code 1",
      exitCode: 1,
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

  it("publishes live transcript excerpts while a foreground command is still running", async () => {
    vi.useFakeTimers();
    try {
      const store = createTerminalToolRunStore();
      let transcript = "";
      let resolveCommand:
        | ((value: { output: string; exitCode: number; timedOut: boolean }) => void)
        | undefined;

      const session = {
        id: "term-live",
        info: { shell: "powershell.exe" },
        getCleanOutputCursor: () => 0,
        executeCommand: vi.fn().mockImplementation(
          () =>
            new Promise<{ output: string; exitCode: number; timedOut: boolean }>((resolve) => {
              resolveCommand = resolve;
            }),
        ),
        readCleanOutputSince: vi.fn().mockImplementation(() => ({
          text: transcript,
          nextOffset: transcript.length,
          truncatedBeforeOffset: false,
        })),
      };

      const runtime = {
        onUpdate: vi.fn(),
      };

      const coordinator = createTerminalToolRunCoordinator({
        runStore: store,
        getSession: vi.fn().mockResolvedValue(session),
        classifyLongRunning: vi.fn().mockReturnValue(false),
        trackDetachedProcess: vi.fn(),
      });

      const runPromise = coordinator.runForeground({
        runId: "run-live",
        toolCallId: "tool-live",
        command: 'echo "Terminal test: basic echo works"',
        cwd: "C:/tauri/volt",
        timeoutMs: 1000,
        runtime,
      });

      await vi.advanceTimersByTimeAsync(150);
      transcript = "Terminal test: basic echo works\n";
      await vi.advanceTimersByTimeAsync(150);

      expect(runtime.onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          liveStatus: "Running command...",
          meta: {
            terminalRun: expect.objectContaining({
              terminalId: "term-live",
              excerpt: "Terminal test: basic echo works\n",
            }),
          },
        }),
      );

      resolveCommand?.({
        output: "Terminal test: basic echo works\n",
        exitCode: 0,
        timedOut: false,
      });
      await vi.advanceTimersByTimeAsync(150);

      const result = await runPromise;
      expect(result.success).toBe(true);
      expect(store.get("run-live")).toMatchObject({
        state: "completed",
        excerpt: "Terminal test: basic echo works\n",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
