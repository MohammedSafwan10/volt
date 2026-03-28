# Terminal Tool Pipeline Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild terminal-backed tool execution so each tool call owns its lifecycle and transcript boundaries, eliminating stuck terminal cards and transcript leakage into chat.

**Architecture:** Introduce a dedicated terminal run coordinator/store that owns terminal tool lifecycle, cursor-based transcript capture, detach handoff, and chat-facing projections. Keep existing external tool names and assistant runtime entry points, but move execution ownership out of `terminal.ts` and make chat consume stable run state instead of mixed terminal/session/tool metadata.

**Tech Stack:** Svelte 5, TypeScript, Vitest, existing Volt assistant runtime, terminal store/session APIs

---

## File Structure

### New files

- `src/lib/features/assistant/components/panel/terminal-tool-run-store.ts`
  - Canonical run record types and in-memory store for terminal tool runs.
- `src/lib/features/assistant/components/panel/terminal-tool-transcript.ts`
  - Cursor-bounded transcript/excerpt helpers.
- `src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.ts`
  - Orchestrates session selection, run state transitions, transcript capture, detach handoff, and final outcomes.
- `src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts`
  - Unit tests for run state transitions and stable metadata behavior.
- `src/lib/features/assistant/components/panel/terminal-tool-transcript.test.ts`
  - Unit tests for transcript capture/excerpt rules and truncation handling.
- `src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts`
  - Unit tests for foreground runs, detach flows, and failure handling.

### Modified files

- `src/lib/core/ai/tools/handlers/terminal.ts`
  - Slim adapter layer delegating `run_command`/`start_process` output ownership to coordinator logic.
- `src/lib/features/assistant/components/panel/tool-execution.ts`
  - Preserve stable terminal-tool run metadata on tool patches/results.
- `src/lib/features/assistant/components/panel/tool-live-updates.ts`
  - Add terminal-specific live-status projection shape instead of generic text only.
- `src/lib/features/assistant/components/InlineToolCall.svelte`
  - Render terminal cards from canonical run metadata with stable shell and excerpt.
- `src/lib/features/assistant/components/AssistantMessageRow.svelte`
  - Keep terminal cards in tool lane and avoid text/tool reconstruction glitches for active runs.
- `src/lib/features/assistant/runtime/native-runtime.ts`
  - Pass through terminal run patches/events if needed by runtime event bridge.

### Existing tests to extend

- `src/lib/features/assistant/components/panel/streaming-text-buffer.test.ts`
  - Only if excerpt buffering needs specific regression coverage here.

---

### Task 1: Add canonical terminal run types and store

**Files:**
- Create: `src/lib/features/assistant/components/panel/terminal-tool-run-store.ts`
- Test: `src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts`

- [ ] **Step 1: Write the failing store tests**

```ts
import { describe, expect, it } from "vitest";
import {
  createTerminalToolRunStore,
  type TerminalToolRunRecord,
} from "./terminal-tool-run-store";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts`
Expected: FAIL with module not found for `terminal-tool-run-store`

- [ ] **Step 3: Write minimal run store implementation**

```ts
export type TerminalToolRunState =
  | "queued"
  | "launching"
  | "running"
  | "streaming_output"
  | "detaching"
  | "detached"
  | "completed"
  | "failed"
  | "cancelled";

export type TerminalToolExecutionMode =
  | "foreground"
  | "background_detached"
  | "reused_background";

export interface TerminalToolRunRecord {
  runId: string;
  toolCallId: string;
  terminalId?: string;
  processId?: number;
  command: string;
  cwd?: string;
  captureStartOffset: number;
  captureCurrentOffset: number;
  captureEndOffset?: number;
  executionMode: TerminalToolExecutionMode;
  state: TerminalToolRunState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  failureReason?: string;
  detectedUrl?: string;
  excerpt?: string;
  transcriptTruncated?: boolean;
}

export interface TerminalToolRunStore {
  get(runId: string): TerminalToolRunRecord | undefined;
  upsert(run: TerminalToolRunRecord): void;
  patch(runId: string, patch: Partial<TerminalToolRunRecord>): void;
  list(): TerminalToolRunRecord[];
  clear(): void;
}

export function createTerminalToolRunStore(): TerminalToolRunStore {
  const runs = new Map<string, TerminalToolRunRecord>();

  return {
    get(runId) {
      return runs.get(runId);
    },
    upsert(run) {
      runs.set(run.runId, run);
    },
    patch(runId, patch) {
      const current = runs.get(runId);
      if (!current) {
        throw new Error(`Terminal tool run not found: ${runId}`);
      }
      runs.set(runId, { ...current, ...patch });
    },
    list() {
      return Array.from(runs.values());
    },
    clear() {
      runs.clear();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/features/assistant/components/panel/terminal-tool-run-store.ts src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts
git commit -m "feat(assistant): add terminal tool run store"
```

### Task 2: Add transcript capture helpers with explicit truncation handling

**Files:**
- Create: `src/lib/features/assistant/components/panel/terminal-tool-transcript.ts`
- Test: `src/lib/features/assistant/components/panel/terminal-tool-transcript.test.ts`

- [ ] **Step 1: Write the failing transcript tests**

```ts
import { describe, expect, it } from "vitest";
import {
  buildTerminalToolExcerpt,
  readTerminalTranscriptSlice,
} from "./terminal-tool-transcript";

describe("terminal-tool-transcript", () => {
  it("reads only output after the provided start offset", () => {
    const session = {
      readCleanOutputSince: (offset: number) => ({
        text: offset === 20 ? "owned output\n" : "wrong output\n",
        nextOffset: 33,
        truncatedBeforeOffset: false,
      }),
    };

    const result = readTerminalTranscriptSlice(session, 20, 4000);

    expect(result).toEqual({
      text: "owned output\n",
      nextOffset: 33,
      truncatedBeforeOffset: false,
    });
  });

  it("builds a bounded excerpt without mixing old output", () => {
    const excerpt = buildTerminalToolExcerpt("a\nb\nc\nd\ne", 2);
    expect(excerpt).toBe("d\ne");
  });

  it("preserves truncation signal for caller handling", () => {
    const session = {
      readCleanOutputSince: () => ({
        text: "partial\n",
        nextOffset: 99,
        truncatedBeforeOffset: true,
      }),
    };

    expect(readTerminalTranscriptSlice(session, 40, 4000).truncatedBeforeOffset).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-transcript.test.ts`
Expected: FAIL with module not found for `terminal-tool-transcript`

- [ ] **Step 3: Write minimal transcript helper implementation**

```ts
interface TranscriptReader {
  readCleanOutputSince: (
    offset: number,
    maxChars: number,
  ) => {
    text: string;
    nextOffset: number;
    truncatedBeforeOffset: boolean;
  };
}

export function readTerminalTranscriptSlice(
  session: TranscriptReader,
  startOffset: number,
  maxChars: number,
): {
  text: string;
  nextOffset: number;
  truncatedBeforeOffset: boolean;
} {
  return session.readCleanOutputSince(startOffset, maxChars);
}

export function buildTerminalToolExcerpt(
  transcript: string,
  maxLines: number,
): string {
  const lines = transcript.split("\n");
  return lines.slice(-maxLines).join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-transcript.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/features/assistant/components/panel/terminal-tool-transcript.ts src/lib/features/assistant/components/panel/terminal-tool-transcript.test.ts
git commit -m "feat(assistant): add terminal transcript helpers"
```

### Task 3: Build the terminal run coordinator around canonical lifecycle state

**Files:**
- Create: `src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.ts`
- Test: `src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts`

- [ ] **Step 1: Write the failing coordinator tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createTerminalToolRunCoordinator } from "./terminal-tool-run-coordinator";
import { createTerminalToolRunStore } from "./terminal-tool-run-store";

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
      readCleanOutputSince: vi.fn().mockReturnValue({
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
      executeCommand: vi.fn(),
      readCleanOutputSince: vi.fn().mockReturnValue({
        text: "ready on http://localhost:5173\n",
        nextOffset: 40,
        truncatedBeforeOffset: false,
      }),
    };

    const coordinator = createTerminalToolRunCoordinator({
      runStore: store,
      getSession: vi.fn().mockResolvedValue(session),
      classifyLongRunning: vi.fn().mockReturnValue(true),
      trackDetachedProcess: vi.fn().mockReturnValue({ processId: 8 }),
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
    });
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts`
Expected: FAIL with module not found for `terminal-tool-run-coordinator`

- [ ] **Step 3: Write minimal coordinator implementation**

```ts
import { buildTerminalToolExcerpt, readTerminalTranscriptSlice } from "./terminal-tool-transcript";
import type { TerminalToolRunStore } from "./terminal-tool-run-store";

interface CoordinatorDeps {
  runStore: TerminalToolRunStore;
  getSession: (cwd?: string) => Promise<{
    id: string;
    getCleanOutputCursor: () => number;
    executeCommand?: (command: string, timeoutMs: number) => Promise<{
      output: string;
      exitCode: number;
      timedOut: boolean;
    }>;
    readCleanOutputSince: (
      offset: number,
      maxChars: number,
    ) => {
      text: string;
      nextOffset: number;
      truncatedBeforeOffset: boolean;
    };
  }>;
  classifyLongRunning: (command: string, transcript: string) => boolean;
  trackDetachedProcess: (command: string, cwd?: string, terminalId?: string) => {
    processId: number;
  };
}

export function createTerminalToolRunCoordinator(deps: CoordinatorDeps) {
  return {
    async runForeground(input: {
      runId: string;
      toolCallId: string;
      command: string;
      cwd?: string;
      timeoutMs: number;
    }) {
      deps.runStore.upsert({
        runId: input.runId,
        toolCallId: input.toolCallId,
        command: input.command,
        cwd: input.cwd,
        captureStartOffset: 0,
        captureCurrentOffset: 0,
        executionMode: "foreground",
        state: "launching",
        startedAt: Date.now(),
      });

      try {
        const session = await deps.getSession(input.cwd);
        const captureStartOffset = session.getCleanOutputCursor();

        deps.runStore.patch(input.runId, {
          terminalId: session.id,
          captureStartOffset,
          captureCurrentOffset: captureStartOffset,
          state: "running",
        });

        const transcriptSlice = readTerminalTranscriptSlice(
          session,
          captureStartOffset,
          16000,
        );
        const transcript = transcriptSlice.text;

        if (deps.classifyLongRunning(input.command, transcript)) {
          const detached = deps.trackDetachedProcess(
            input.command,
            input.cwd,
            session.id,
          );
          deps.runStore.patch(input.runId, {
            executionMode: "background_detached",
            state: "detached",
            processId: detached.processId,
            captureCurrentOffset: transcriptSlice.nextOffset,
            captureEndOffset: transcriptSlice.nextOffset,
            excerpt: buildTerminalToolExcerpt(transcript, 12),
            transcriptTruncated: transcriptSlice.truncatedBeforeOffset,
            endedAt: Date.now(),
          });
          return { success: true, output: transcript };
        }

        const completion = session.executeCommand
          ? await session.executeCommand(input.command, input.timeoutMs)
          : { output: transcript, exitCode: 0, timedOut: false };

        const finalSlice = readTerminalTranscriptSlice(
          session,
          captureStartOffset,
          16000,
        );

        deps.runStore.patch(input.runId, {
          state:
            completion.exitCode === 0 && !completion.timedOut
              ? "completed"
              : "failed",
          captureCurrentOffset: finalSlice.nextOffset,
          captureEndOffset: finalSlice.nextOffset,
          excerpt: buildTerminalToolExcerpt(finalSlice.text || completion.output, 12),
          transcriptTruncated: finalSlice.truncatedBeforeOffset,
          exitCode: completion.exitCode,
          endedAt: Date.now(),
          failureReason:
            completion.exitCode === 0 && !completion.timedOut
              ? undefined
              : completion.timedOut
                ? "Command timed out"
                : `Command failed with exit code ${completion.exitCode}`,
        });

        return {
          success: completion.exitCode === 0 && !completion.timedOut,
          output: finalSlice.text || completion.output,
        };
      } catch (error) {
        deps.runStore.patch(input.runId, {
          state: "failed",
          failureReason: error instanceof Error ? error.message : String(error),
          endedAt: Date.now(),
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.ts src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts
git commit -m "feat(assistant): add terminal tool run coordinator"
```

### Task 4: Refactor terminal handler to delegate to coordinator

**Files:**
- Modify: `src/lib/core/ai/tools/handlers/terminal.ts`
- Test: `src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts`

- [ ] **Step 1: Write the failing handler integration test**

```ts
it("converts detached terminal runs into resolved tool results", async () => {
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

  const result = await invokeRunCommandForTest(
    coordinator,
    { command: "npm run dev", cwd: "C:/tauri/volt" },
  );

  expect(result.success).toBe(true);
  expect(result.meta).toMatchObject({
    processId: 9,
    terminalId: "term-9",
  });
  expect(result.output).toContain("http://localhost:5173");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts`
Expected: FAIL because `handleRunCommand` still owns detach/result shaping directly

- [ ] **Step 3: Implement handler delegation**

```ts
// inside terminal.ts
import { createTerminalToolRunCoordinator } from "$features/assistant/components/panel/terminal-tool-run-coordinator";
import { createTerminalToolRunStore } from "$features/assistant/components/panel/terminal-tool-run-store";

const terminalToolRunStore = createTerminalToolRunStore();
const terminalToolRunCoordinator = createTerminalToolRunCoordinator({
  runStore: terminalToolRunStore,
  getSession: async (cwd) => {
    const session = await terminalStore.getOrCreateAiTerminal(cwd);
    if (!session) throw new Error("Failed to access AI terminal");
    await session.waitForReady(3000);
    return session;
  },
  classifyLongRunning: (command, transcript) =>
    isLikelyDevServer(command) && /\b(ready|started|listening|localhost:)\b/i.test(transcript),
  trackDetachedProcess: (command, cwd, terminalId) =>
    trackDetachedProcess(command, cwd, terminalId ?? ""),
});

export async function handleRunCommand(args: Record<string, unknown>): Promise<ToolResult> {
  const normalizedInvocation = extractLeadingCwdDirective(
    String(args.command),
    resolveToolCwd(args.cwd),
  );
  const command = normalizedInvocation.command.trim();
  const cwd = requireToolCwd(normalizedInvocation.cwd);
  const timeout = typeof args.timeout === "number" ? args.timeout : 90_000;

  const result = await terminalToolRunCoordinator.runForeground({
    runId: `terminal-run:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    toolCallId: String(args.toolCallId ?? command),
    command,
    cwd,
    timeoutMs: timeout,
  });

  return {
    success: result.success,
    output: result.output ?? "",
    error: result.error,
    meta: result.meta,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/core/ai/tools/handlers/terminal.ts src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts
git commit -m "refactor(assistant): route terminal tools through coordinator"
```

### Task 5: Preserve terminal run metadata through tool execution updates

**Files:**
- Modify: `src/lib/features/assistant/components/panel/tool-live-updates.ts`
- Modify: `src/lib/features/assistant/components/panel/tool-execution.ts`
- Test: `src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts`

- [ ] **Step 1: Write the failing metadata propagation test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts`
Expected: FAIL because terminal run metadata is not explicitly preserved in tool patch tests

- [ ] **Step 3: Implement metadata-safe tool patching**

```ts
// tool-live-updates.ts
export function toToolCallPatch(
  update: ToolRuntimeUpdate,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const meta: Record<string, unknown> = {
    ...(update.meta ?? {}),
  };
  if (update.liveStatus) {
    meta.liveStatus = update.liveStatus;
  }
  if (Object.keys(meta).length > 0) {
    patch.meta = meta;
  }
  return patch;
}

// tool-execution.ts
updateToolCall(toolCall.id, {
  status: result.success ? "completed" : "failed",
  output: result.output,
  error: result.error,
  meta: {
    ...(result.meta ?? {}),
    liveStatus: undefined,
  },
  data: result.data,
  endTime: Date.now(),
  streamingProgress: undefined,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/features/assistant/components/panel/tool-live-updates.ts src/lib/features/assistant/components/panel/tool-execution.ts src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts
git commit -m "fix(assistant): preserve terminal run metadata in tool patches"
```

### Task 6: Render terminal cards from canonical run metadata

**Files:**
- Modify: `src/lib/features/assistant/components/InlineToolCall.svelte`
- Modify: `src/lib/features/assistant/components/AssistantMessageRow.svelte`
- Test: `src/lib/features/assistant/components/panel/streaming-text-buffer.test.ts`

- [ ] **Step 1: Write the failing UI projection tests**

```ts
it("keeps terminal card shell stable while excerpt updates", () => {
  const toolCall = {
    id: "tool-1",
    name: "run_command",
    status: "running",
    arguments: { command: "npm run dev" },
    meta: {
      terminalRun: {
        state: "running",
        commandPreview: "npm run dev",
        excerpt: "starting...\n",
      },
    },
  };

  const nextToolCall = {
    ...toolCall,
    meta: {
      terminalRun: {
        state: "streaming_output",
        commandPreview: "npm run dev",
        excerpt: "starting...\nready on http://localhost:5173\n",
      },
    },
  };

  expect(readTerminalCardIdentity(toolCall)).toEqual(readTerminalCardIdentity(nextToolCall));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/features/assistant/components/panel/streaming-text-buffer.test.ts`
Expected: FAIL because terminal card identity/projection helper does not exist yet

- [ ] **Step 3: Implement stable terminal card projection**

```ts
// InlineToolCall.svelte helper shape
function getTerminalRunMeta() {
  const meta = (toolCall.meta as Record<string, unknown> | undefined) ?? {};
  return (meta.terminalRun as
    | {
        state?: string;
        commandPreview?: string;
        excerpt?: string;
        detectedUrl?: string;
        processId?: number;
      }
    | undefined);
}

const terminalRunMeta = $derived(getTerminalRunMeta());
const terminalPreview = $derived(
  terminalRunMeta?.commandPreview || String(toolCall.arguments.command || ""),
);
const terminalExcerpt = $derived(terminalRunMeta?.excerpt || toolCall.output || "");
```

```svelte
{#if isTerminalTool}
  <div class="terminal-tool-container" class:expanded>
    <button class="terminal-header" onclick={toggleExpanded} aria-expanded={expanded} type="button">
      <div class="terminal-badge icon-only" title="Run command">
        <UIIcon name="terminal" size={14} />
      </div>
      <div class="terminal-command-preview">
        <span class="prompt-char">$</span>
        <span class="command-text">{terminalPreview || "command"}</span>
      </div>
      <div class="terminal-meta">
        <span class="status-pill">{terminalRunMeta?.state || toolCall.status}</span>
      </div>
    </button>
    {#if expanded}
      <div class="tool-details">
        <pre class="detail-output">{terminalExcerpt}</pre>
      </div>
    {/if}
  </div>
{/if}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/features/assistant/components/panel/streaming-text-buffer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/features/assistant/components/InlineToolCall.svelte src/lib/features/assistant/components/AssistantMessageRow.svelte src/lib/features/assistant/components/panel/streaming-text-buffer.test.ts
git commit -m "feat(assistant): render terminal cards from canonical run metadata"
```

### Task 7: Run focused validation and final checks

**Files:**
- Test: `src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts`
- Test: `src/lib/features/assistant/components/panel/terminal-tool-transcript.test.ts`
- Test: `src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts`
- Test: `src/lib/features/assistant/components/panel/streaming-text-buffer.test.ts`
- Modify: `docs/superpowers/plans/2026-03-28-terminal-tool-pipeline-rebuild.md` (check off progress only if executing from this plan)

- [ ] **Step 1: Run focused test suite**

Run: `npm test -- src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts src/lib/features/assistant/components/panel/terminal-tool-transcript.test.ts src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts src/lib/features/assistant/components/panel/streaming-text-buffer.test.ts`
Expected: PASS

- [ ] **Step 2: Run type checking**

Run: `npm run check`
Expected: PASS

- [ ] **Step 3: Run lint on touched files**

Run: `npx eslint src/lib/core/ai/tools/handlers/terminal.ts src/lib/features/assistant/components/InlineToolCall.svelte src/lib/features/assistant/components/AssistantMessageRow.svelte src/lib/features/assistant/components/panel/tool-execution.ts src/lib/features/assistant/components/panel/tool-live-updates.ts src/lib/features/assistant/components/panel/terminal-tool-run-store.ts src/lib/features/assistant/components/panel/terminal-tool-transcript.ts src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.ts`
Expected: PASS

- [ ] **Step 4: Inspect git diff before handoff**

Run: `git diff -- src/lib/core/ai/tools/handlers/terminal.ts src/lib/features/assistant/components/InlineToolCall.svelte src/lib/features/assistant/components/AssistantMessageRow.svelte src/lib/features/assistant/components/panel/tool-execution.ts src/lib/features/assistant/components/panel/tool-live-updates.ts src/lib/features/assistant/components/panel/terminal-tool-run-store.ts src/lib/features/assistant/components/panel/terminal-tool-transcript.ts src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.ts`
Expected: Review shows only terminal pipeline refactor changes

- [ ] **Step 5: Commit validation-complete state**

```bash
git add src/lib/core/ai/tools/handlers/terminal.ts src/lib/features/assistant/components/InlineToolCall.svelte src/lib/features/assistant/components/AssistantMessageRow.svelte src/lib/features/assistant/components/panel/tool-execution.ts src/lib/features/assistant/components/panel/tool-live-updates.ts src/lib/features/assistant/components/panel/terminal-tool-run-store.ts src/lib/features/assistant/components/panel/terminal-tool-transcript.ts src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.ts src/lib/features/assistant/components/panel/terminal-tool-run-store.test.ts src/lib/features/assistant/components/panel/terminal-tool-transcript.test.ts src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.test.ts src/lib/features/assistant/components/panel/streaming-text-buffer.test.ts
git commit -m "fix(assistant): rebuild terminal tool execution pipeline"
```

---

## Self-Review

### Spec coverage

- Canonical run record: covered by Tasks 1 and 3
- Transcript ownership/excerpt/truncation: covered by Task 2
- Handler delegation/lifecycle cleanup: covered by Task 4
- Chat stable projection: covered by Task 6
- Validation and rollout safety: covered by Task 7

No uncovered spec sections remain.

### Placeholder scan

Checked for `TODO`, `TBD`, “similar to”, and vague “add tests” steps. Each task contains exact files, code, and commands.

### Type consistency

- `TerminalToolRunRecord`, `TerminalToolRunState`, and `TerminalToolExecutionMode` are introduced in Task 1 and referenced consistently later.
- Coordinator API names in Tasks 3 and 4 match (`createTerminalToolRunCoordinator`, `runForeground`).
- Metadata key stays consistent as `terminalRun`.
