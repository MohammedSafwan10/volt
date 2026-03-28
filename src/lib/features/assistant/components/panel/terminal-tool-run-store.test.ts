import { describe, expect, it, vi } from "vitest";
import { createTerminalToolRunStore } from "./terminal-tool-run-store";
import { toToolCallPatch } from "./tool-live-updates";
import { executeToolWithUpdates } from "./tool-execution";
import { executeQueuedNonFileTools } from "./loop-executor";

describe("terminal-tool-run-store", () => {
  it("creates a run record with explicit queued state", () => {
    const store = createTerminalToolRunStore();

    store.upsert({
      runId: "run-1",
      toolCallId: "tool-1",
      command: "npm run dev",
      cwd: "C:/tauri/volt",
      executionMode: "foreground",
      state: "queued",
      captureStartOffset: 0,
      captureCurrentOffset: 0,
      startedAt: 100,
    });

    expect(store.get("run-1")).toMatchObject({
      runId: "run-1",
      toolCallId: "tool-1",
      state: "queued",
      executionMode: "foreground",
    });
  });

  it("updates a run state without losing stable command metadata", () => {
    const store = createTerminalToolRunStore();

    store.upsert({
      runId: "run-2",
      toolCallId: "tool-2",
      command: "pnpm test",
      cwd: "C:/tauri/volt",
      executionMode: "foreground",
      state: "running",
      captureStartOffset: 11,
      captureCurrentOffset: 11,
      startedAt: 200,
    });

    store.patch("run-2", {
      state: "completed",
      endedAt: 300,
      exitCode: 0,
      captureEndOffset: 42,
    });

    expect(store.get("run-2")).toMatchObject({
      command: "pnpm test",
      cwd: "C:/tauri/volt",
      state: "completed",
      exitCode: 0,
      captureEndOffset: 42,
    });
  });

  it("tracks detached runs as resolved foreground tool outcomes", () => {
    const store = createTerminalToolRunStore();

    store.upsert({
      runId: "run-3",
      toolCallId: "tool-3",
      command: "npm run dev",
      cwd: "C:/tauri/volt",
      executionMode: "background_detached",
      state: "detaching",
      captureStartOffset: 5,
      captureCurrentOffset: 40,
      startedAt: 500,
    });

    store.patch("run-3", {
      state: "detached",
      endedAt: 900,
      processId: 7,
      detectedUrl: "http://localhost:5173",
    });

    expect(store.get("run-3")).toMatchObject({
      state: "detached",
      processId: 7,
      detectedUrl: "http://localhost:5173",
    });
  });

  it("returns defensive copies from get and list", () => {
    const store = createTerminalToolRunStore();

    store.upsert({
      runId: "run-4",
      toolCallId: "tool-4",
      command: "npm test",
      cwd: "C:/tauri/volt",
      executionMode: "foreground",
      state: "running",
      captureStartOffset: 0,
      captureCurrentOffset: 0,
      startedAt: 1000,
    });

    const fromGet = store.get("run-4");
    const fromList = store.list();

    if (!fromGet) {
      throw new Error("Expected run-4 to exist");
    }

    fromGet.state = "failed";
    fromList[0].command = "mutated";

    expect(store.get("run-4")).toMatchObject({
      state: "running",
      command: "npm test",
    });
  });

  it("ignores identity-field mutations in patch calls", () => {
    const store = createTerminalToolRunStore();

    store.upsert({
      runId: "run-5",
      toolCallId: "tool-5",
      command: "npm run build",
      cwd: "C:/tauri/volt",
      executionMode: "foreground",
      state: "running",
      captureStartOffset: 1,
      captureCurrentOffset: 2,
      startedAt: 300,
    });

    store.patch("run-5", {
      runId: "run-5-mutated",
      toolCallId: "tool-5-mutated",
      state: "completed",
    });

    expect(store.get("run-5")).toMatchObject({
      runId: "run-5",
      toolCallId: "tool-5",
      state: "completed",
    });
    expect(store.get("run-5-mutated")).toBeUndefined();
  });

  it("merges terminal run metadata without dropping live status", () => {
    const patch = toToolCallPatch({
      liveStatus: "Running command...",
      meta: {
        terminalRun: {
          state: "running",
          commandPreview: "npm run dev",
        },
      },
    });

    expect(patch.meta).toMatchObject({
      liveStatus: "Running command...",
      terminalRun: {
        state: "running",
        commandPreview: "npm run dev",
      },
    });
  });

  it("preserves existing terminal metadata when tool execution fails", async () => {
    const updateToolCall = vi.fn();
    const toolCall = {
      id: "tool-6",
      name: "run_command",
      arguments: {
        command: "pnpm test",
      },
      status: "pending" as const,
      meta: {
        terminalRun: {
          state: "running",
          commandPreview: "pnpm test",
          terminalId: "term-6",
        },
      },
    };

    const result = await executeToolWithUpdates({
      toolCall,
      idScope: "spec-gap",
      executeToolCall: async () => {
        throw new Error("boom");
      },
      getToolIdempotencyKey: () => "key",
      updateToolCall,
    });

    expect(result).toMatchObject({
      success: false,
      error: "boom",
    });
    expect(updateToolCall).toHaveBeenLastCalledWith(
      "tool-6",
      expect.objectContaining({
        status: "failed",
        error: "boom",
        meta: {
          terminalRun: {
            state: "running",
            commandPreview: "pnpm test",
            terminalId: "term-6",
          },
          liveStatus: undefined,
        },
      }),
    );
  });

  it("preserves existing meta on running update and terminal metadata on successful completion", async () => {
    const updateToolCall = vi.fn();
    const toolCall = {
      id: "tool-7",
      name: "run_command",
      arguments: {
        command: "pnpm test",
      },
      status: "pending" as const,
      meta: {
        approvalState: "approved",
        terminalRun: {
          state: "running",
          commandPreview: "pnpm test",
          terminalId: "term-7",
        },
      },
    };

    const result = await executeToolWithUpdates({
      toolCall,
      idScope: "spec-gap",
      executeToolCall: async () => ({
        success: true,
        output: "done",
        meta: {
          summary: "completed",
        },
      }),
      getToolIdempotencyKey: () => "key",
      updateToolCall,
    });

    expect(result).toMatchObject({
      success: true,
      output: "done",
    });
    expect(updateToolCall).toHaveBeenNthCalledWith(
      1,
      "tool-7",
      expect.objectContaining({
        status: "running",
        meta: {
          approvalState: "approved",
          terminalRun: {
            state: "running",
            commandPreview: "pnpm test",
            terminalId: "term-7",
          },
          liveStatus: "Running command...",
        },
      }),
    );
    expect(updateToolCall).toHaveBeenLastCalledWith(
      "tool-7",
      expect.objectContaining({
        status: "completed",
        output: "done",
        meta: {
          approvalState: "approved",
          terminalRun: {
            state: "running",
            commandPreview: "pnpm test",
            terminalId: "term-7",
          },
          summary: "completed",
          liveStatus: undefined,
        },
      }),
    );
  });

  it("does not overwrite an already-failed invalid terminal tool call back to running", async () => {
    const toolState = new Map<string, Record<string, unknown>>([
      [
        "tool-invalid",
        {
          id: "tool-invalid",
          status: "failed",
          error: "Invalid tool call",
          meta: {
            terminalRun: {
              state: "failed",
              commandPreview: "pnpm test",
              terminalId: "term-invalid",
            },
          },
        },
      ],
    ]);

    await executeQueuedNonFileTools(
      [
        {
          id: "tool-invalid",
          name: "run_command",
          args: { command: "pnpm test" },
          runAfterFileEdits: false,
        },
      ],
      {
        executeToolCall: async () => ({
          success: true,
          output: "should not execute",
        }),
        signal: new AbortController().signal,
        toolRunScope: "scope",
        getToolIdempotencyKey: () => "id",
        updateToolCallInMessage: (_messageId, toolId, patch) => {
          toolState.set(toolId, {
            ...(toolState.get(toolId) ?? {}),
            ...patch,
          });
        },
        messageId: "m1",
        trackToolOutcome: () => undefined,
        getFailureSignature: () => null,
        onFailureSignature: () => undefined,
        getCurrentToolCallState: (_messageId, toolId) =>
          toolState.get(toolId) as
            | { status?: string; error?: string; meta?: Record<string, unknown> }
            | undefined,
      },
    );

    expect(toolState.get("tool-invalid")).toMatchObject({
      status: "failed",
      error: "Invalid tool call",
    });
  });
});
