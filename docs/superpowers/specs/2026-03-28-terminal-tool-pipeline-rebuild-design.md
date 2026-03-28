# Terminal Tool Pipeline Rebuild Design

## Context

Volt's terminal-backed AI tools currently mix several responsibilities in the same path:

- command execution
- terminal session reuse
- output capture
- long-running process detection
- chat-facing presentation shaping
- tool lifecycle completion

That mixing creates visible product bugs:

- chat can show the wrong terminal output or prompt text
- terminal-backed tool cards can appear stuck in running state
- long-running commands can blur into chat output instead of cleanly detaching
- terminal UI and chat UI can disagree about what the command is doing

This spec defines a terminal-specific sub-refactor under the broader reliability program. It does not replace the larger workspace mutation refactor; it isolates the terminal pipeline so it can become reliable on its own boundaries.

## Goals

- Ensure every terminal-backed tool call has one canonical execution record
- Ensure chat only renders output that belongs to that tool call
- Ensure stuck running states are eliminated through explicit lifecycle transitions
- Ensure long-running commands detach cleanly into background process tracking
- Ensure terminal session reuse never causes cross-run transcript bleed
- Keep the terminal-specific refactor scoped so it can be implemented and tested independently

## Non-goals

- Rebuilding the entire assistant runtime
- Replacing the terminal emulator itself
- Solving general markdown streaming issues unrelated to terminal tools
- Solving file mutation reliability in this sub-spec

## Current failure modes

### Mixed execution and presentation

`handleRunCommand()` currently owns both execution mechanics and user-facing result shaping. It decides queueing, shell behavior, timeout behavior, dev-server heuristics, detach behavior, and final output framing in one function. That makes correctness hard to reason about and easy to break.

### Shared terminal transcript leakage

The current implementation captures output by reading from shared terminal session history. Even though offsets are used, the contract is still too weak because session reuse, output polling, and fallback reads all happen in the same handler. This makes it possible for a tool call to surface prompt text or unrelated output in chat.

### Tool lifecycle ambiguity

Terminal tool completion is not modeled as its own authoritative lifecycle. Instead, completion is inferred from a mix of shell integration results, dev-server heuristics, timeouts, and session behavior. This creates cases where a tool looks stuck or partially resolved.

### UI projection instability

Chat terminal cards are still projections of partially evolving tool state. Terminal output, tool metadata, and tool completion are not normalized into a stable render contract early enough, so UI can present unstable intermediate states.

## Recommended architecture

Introduce a dedicated `TerminalToolRunCoordinator` that becomes the only owner of terminal-tool execution state.

### Canonical terminal run record

Each terminal-backed tool call gets a run record with:

- `runId`
- `toolCallId`
- `terminalId`
- `processId?`
- `command`
- `cwd`
- `captureStartOffset`
- `captureCurrentOffset`
- `captureEndOffset?`
- `executionMode`
- `state`
- `startedAt`
- `endedAt?`
- `exitCode?`
- `failureReason?`
- `detectedUrl?`

### Execution modes

- `foreground`
- `background_detached`
- `reused_background`

### States

- `queued`
- `launching`
- `running`
- `streaming_output`
- `detaching`
- `detached`
- `completed`
- `failed`
- `cancelled`

These states are explicit and mutually meaningful. Chat and observability consume them directly rather than inferring status from terminal text or incomplete tool metadata.

## Output ownership model

Output for a terminal tool run is split into three channels:

### 1. Raw transcript

The exact terminal output produced after `captureStartOffset`. This is owned by the run record and never read by chat directly from generic terminal session state.

### 2. Chat excerpt

A bounded excerpt derived from the run transcript for inline chat display. This is the only output channel chat cards may render during execution.

### 3. Final result summary

The terminal tool's final structured outcome:

- success/failure
- timeout/detach/reuse classification
- exit code when available
- summarized final output excerpt

This prevents chat from behaving like a live terminal mirror.

## Cursor capture contract

The coordinator captures terminal output using a strict cursor contract:

1. Acquire or create terminal session
2. Record `captureStartOffset`
3. Execute command
4. Only consume output after that offset
5. Seal `captureEndOffset` when the run reaches a terminal state

No fallback path is allowed to read generic recent terminal output without preserving run boundaries. If output before the requested offset has been truncated from memory, the run must report that explicitly instead of silently substituting unrelated transcript.

## Session reuse rules

Session reuse remains allowed, but only under a stronger contract:

- the reused session must be idle for foreground runs
- the coordinator must create a fresh run record with a new start offset
- prior session history cannot become part of the new run's chat excerpt
- reused background dev servers are represented as `reused_background`, not as active foreground command runs

If these conditions cannot be guaranteed, the coordinator creates a fresh dedicated session instead of reusing one.

## Long-running command handoff

Long-running commands should not remain in an ambiguous running state.

When the coordinator classifies a command as long-running:

1. foreground run enters `detaching`
2. background process record is created or linked
3. run transitions to `detached`
4. tool call resolves successfully with a detached outcome
5. later output belongs to background process inspection tools, not the original tool card

This removes the current limbo where a server-like command can keep appearing live in chat.

## Chat rendering contract

Terminal tool UI in chat becomes a stable projection of the canonical run record.

### Required behavior

- card type is fixed as terminal-tool card from first render
- icon is fixed from first render
- command preview is fixed from first render
- only lifecycle badge and excerpt body update over time
- markdown assistant text and terminal tool cards render in separate lanes

### Prohibited behavior

- rendering raw terminal transcript directly into assistant markdown
- switching card type mid-stream
- deriving terminal output from generic terminal panel state
- using partial tool meta patches to reshape the card shell

## Component boundaries

### `terminal.ts` handler layer

Becomes a thin adapter that requests execution from the coordinator and converts final run outcomes into `ToolResult`.

### `TerminalToolRunCoordinator`

Owns:

- terminal session selection/creation
- run record creation
- capture cursor boundaries
- lifecycle transitions
- detach handoff
- final result classification

### terminal transcript capture helper

Owns:

- strict offset-based reads
- excerpt generation
- truncation signaling

### chat projection layer

Consumes run record snapshots and renders stable card state. It does not inspect live terminal sessions directly.

## Error handling

### Shell integration unavailable

If shell integration is unavailable or inconsistent, the coordinator still uses explicit run state transitions and transcript boundaries. It may classify completion using timeout/exit heuristics, but it must still seal the run and produce a final state instead of hanging indefinitely.

### Session disappeared mid-run

If the terminal session dies:

- foreground run becomes `failed`
- detached run becomes `unknown_background` or `failed` depending on whether process linkage exists
- chat receives a clear failure state rather than stale running state

### Transcript truncation

If earlier output is evicted before collection:

- the run record marks transcript truncation
- chat/final result includes explicit truncation metadata
- the system must not substitute unrelated prior output

## File-level implementation direction

Primary files expected to change:

- `src/lib/core/ai/tools/handlers/terminal.ts`
- `src/lib/features/assistant/components/panel/tool-execution.ts`
- `src/lib/features/assistant/components/panel/tool-tracking.ts`
- `src/lib/features/assistant/components/InlineToolCall.svelte`
- `src/lib/features/assistant/components/AssistantMessageRow.svelte`
- `src/lib/features/assistant/components/panel/tool-live-updates.ts`
- `src/lib/features/assistant/runtime/native-runtime.ts`

New likely files:

- `src/lib/features/assistant/components/panel/terminal-tool-run-coordinator.ts`
- `src/lib/features/assistant/components/panel/terminal-tool-transcript.ts`
- `src/lib/features/assistant/components/panel/terminal-tool-run-store.ts`

## Testing strategy

Add focused regressions for:

1. foreground run captures only output after its start offset
2. reused session does not leak prior transcript into the next tool call
3. long-running server command resolves as `detached`, not forever `running`
4. failed session startup resolves as `failed`, not `running`
5. chat terminal card keeps stable identity while excerpt updates stream in
6. truncated transcript is reported explicitly
7. background process reuse returns a reused-background outcome instead of replaying old output

## Rollout plan

Implement behind the existing terminal tool interface first so no prompt/tool schema changes are needed. The refactor should preserve external tool names (`run_command`, `start_process`, `get_process_output`, etc.) while replacing the internal execution pipeline.

## Success criteria

- terminal tool cards no longer show stray prompt or unrelated transcript content
- terminal tool cards no longer remain visually stuck after command resolution
- long-running commands reliably resolve to detached background state
- reused terminal sessions no longer cause cross-run output bleed
- terminal panel and chat agree on command lifecycle state
