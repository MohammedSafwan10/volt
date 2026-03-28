# Staged Document Subsystem Design

## Context

Volt's current AI file-mutation path still spreads ownership across multiple layers:

- `src/lib/core/ai/tools/handlers/write.ts` performs mutation logic, editor synchronization, tree refresh, diagnostics triggering, and tool metadata shaping.
- `src/lib/core/services/file-service.ts` already models native document state and versioned writes, but it is not the single orchestration boundary for AI mutations.
- file tree state is still refreshed or mutated imperatively.
- diagnostics freshness is tracked, but not attached to a single canonical mutation basis.

This leads to the same systemic class of bugs seen elsewhere in the assistant pipeline: one surface believes a mutation is current while another surface is still projecting stale or incomplete state.

## Goals

1. Establish a single canonical staged-document subsystem for AI-driven file/resource mutations.
2. Make file tree state and diagnostics state projections of canonical mutation state rather than independent owners.
3. Reduce file tool handlers to thin adapters that submit mutation intents and return normalized results.
4. Preserve explicit lifecycle and error states for staged/committed/failed mutations.
5. Support files and structural resources (create, rename, delete, directories) with the same model.

## Non-goals

1. This spec does not redesign terminal tools.
2. This spec does not rewrite all editor architecture outside the mutation boundary.
3. This spec does not require replacing the existing native document backend.
4. This spec does not require a full diagnostics-engine rewrite; it introduces a clearer basis/freshness contract around the existing systems.

## Core Model

The staged-document subsystem introduces canonical resource states and mutation phases.

### Canonical resource states

- `absent` — resource does not exist in committed state
- `staged_new` — resource is created by a staged mutation but not finalized
- `staged_modified` — resource has staged content differing from committed state
- `staged_delete` — resource is marked for deletion but not finalized
- `committed` — committed state is current and consistent
- `failed` — a mutation attempt failed and failure metadata is attached

### Canonical mutation phases

- `prepare`
- `stage`
- `commit`
- `project`
- `finalize`

The resource state answers "what is this resource's truth?"  
The mutation phase answers "where is the current mutation lifecycle?"

## Architecture

### 1. `staged-document-service.ts`

This is the canonical owner of AI mutation state.

Responsibilities:

- hold per-path staged resource snapshots
- expose subscriptions/selectors for consumers
- track committed content, staged content, mutation status, and failure metadata
- preserve before/after state for tool metadata and recovery
- support both content resources and structural resources

Suggested canonical record shape:

```ts
type StagedResourceState =
  | "absent"
  | "staged_new"
  | "staged_modified"
  | "staged_delete"
  | "committed"
  | "failed";

type MutationPhase = "prepare" | "stage" | "commit" | "project" | "finalize";

interface StagedResourceRecord {
  path: string;
  kind: "file" | "directory";
  state: StagedResourceState;
  phase: MutationPhase;
  committedContent?: string | null;
  stagedContent?: string | null;
  previousPath?: string;
  nextPath?: string;
  version?: number;
  error?: string;
  diagnosticsBasis?: "committed_disk" | "editor_buffer" | "staged_tool_output";
  diagnosticsFreshness?: "fresh" | "pending" | "stale";
  meta?: Record<string, unknown>;
}
```

### 2. `workspace-mutation-coordinator.ts`

This is the execution boundary for AI file/resource tools.

Responsibilities:

- accept mutation intents from tool handlers
- preflight against canonical staged-document state
- decide whether mutation is content or structural
- drive the lifecycle: `prepare -> stage -> commit -> project -> finalize`
- produce normalized tool results and failure states

This coordinator becomes the only place that can drive AI mutation side effects across the workspace.

### 3. Projection layers

These consumers no longer own truth. They derive from staged-document state.

#### Editor projection

- applies staged content to open editors/models
- reflects committed/failure state transitions
- never becomes the source of truth for AI mutation state

#### File tree projection

- overlays staged create/rename/delete/modified state on top of committed filesystem state
- avoids imperative refresh-first behavior as primary synchronization
- uses refresh only as reconciliation, not truth ownership

#### Diagnostics projection

- consumes explicit diagnostics basis from staged-document records
- exposes freshness: `fresh`, `pending`, `stale`
- prevents ambiguous "latest diagnostics" claims when state is in transition

## Mutation intent model

File tools stop performing orchestration inline. They submit mutation intents.

Suggested intent shapes:

```ts
type MutationIntent =
  | {
      type: "write";
      path: string;
      content: string;
      createIfMissing?: boolean;
    }
  | {
      type: "append";
      path: string;
      content: string;
    }
  | {
      type: "replace_range";
      path: string;
      startLine: number;
      endLine: number;
      content: string;
    }
  | {
      type: "replace_snippet";
      path: string;
      oldStr: string;
      newStr: string;
    }
  | {
      type: "multi_replace";
      path: string;
      edits: Array<{ oldStr: string; newStr: string }>;
    }
  | {
      type: "apply_patch";
      path: string;
      patch: string;
    }
  | {
      type: "create_dir";
      path: string;
    }
  | {
      type: "delete";
      path: string;
    }
  | {
      type: "rename";
      oldPath: string;
      newPath: string;
    };
```

## Data flow

### Standard content mutation

1. tool handler parses and validates arguments
2. handler creates mutation intent
3. coordinator loads current committed/staged resource snapshot
4. coordinator runs preflight checks
5. staged-document-service records staged state
6. coordinator commits through native/file backend
7. projection layer updates editor/tree/diagnostics views
8. staged-document-service finalizes to `committed` or `failed`
9. tool result is returned using staged-document metadata

### Structural mutation

1. tool handler submits `create_dir`, `delete`, or `rename`
2. coordinator stages structural record (`staged_new` / `staged_delete` / rename metadata)
3. backend commit executes
4. tree/editor projections reconcile
5. final state is committed or failed

## Error handling

Failures are explicit canonical states, not late-attached ad hoc errors.

### Preflight conflict

Examples:

- expected version mismatch
- rename target already exists
- delete target missing
- snippet replace cannot match

Handling:

- mutation transitions to `failed`
- error metadata remains attached to canonical record
- projections may show failure state, but must not present the resource as committed

### Commit failure

Examples:

- native write failure
- native rename/delete/create failure
- disk or permission issue

Handling:

- staged record remains visible with `failed`
- projections mark stale/pending as appropriate
- tool result includes normalized failure and canonical metadata

### Projection lag

Examples:

- diagnostics not yet recomputed
- tree has not yet reconciled with committed state

Handling:

- projections expose `pending` or `stale`
- consumers must not silently claim freshness

## Diagnostics contract

The staged-document subsystem explicitly sets diagnostics basis:

- `committed_disk` — diagnostics are based on durable committed disk state
- `editor_buffer` — diagnostics reflect open editor buffer state
- `staged_tool_output` — diagnostics reflect staged tool-produced state before full reconciliation

And freshness:

- `fresh`
- `pending`
- `stale`

This lets the assistant/UI communicate whether a post-edit diagnostic result is authoritative, transitional, or outdated.

## Tree contract

The file tree becomes a projection:

- committed filesystem state is the base layer
- staged-document records provide overlays for pending create/rename/delete/modified resources
- watcher/native refresh remains reconciliation input, not the sole source of truth during AI mutation lifecycles

This prevents cases where a tool reports a change but the tree still renders old truth, or vice versa.

## Changes to existing files

### `src/lib/core/ai/tools/handlers/write.ts`

Current problem:

- owns too many responsibilities

New role:

- parse args
- build mutation intent
- call coordinator
- shape tool output from canonical record/result

It should no longer directly own tree refresh, editor synchronization, diagnostics orchestration, or multi-surface truth.

### `src/lib/core/services/file-service.ts`

Current role:

- lower-level document backend with versioned writes and native integration

Retained role:

- committed document backend
- disk/native synchronization
- save/read/version operations

New relationship:

- consumed by coordinator/staged-document-service
- not the top-level owner of AI mutation orchestration

### File tree state

Current problem:

- imperative refreshes/local mutation ownership

New role:

- projection consumer of staged-document records

### Diagnostics state

Current problem:

- freshness exists but basis/truth is not unified around a canonical mutation lifecycle

New role:

- basis-aware projection of staged/committed state

## Testing strategy

### Unit tests

- staged-document-service state transitions
- coordinator lifecycle transitions
- failure retention semantics
- structural mutation state modeling
- diagnostics basis/freshness transitions

### Integration tests

- write tool -> staged -> commit -> editor/tree/diagnostics projection
- failed mutation does not present committed state
- rename/delete/create directory project correctly into tree state
- post-edit diagnostics basis transitions are explicit and stable

### Regression tests

- tool reports success while tree still shows old state
- diagnostics are surfaced as fresh when actually transitional
- editor/tree/diagnostics disagree after a failed or partially applied mutation

## Rollout plan

This should be implemented in phases while preserving behavior:

1. introduce staged-document-service and coordinator
2. migrate content mutation tools first
3. migrate structural mutation tools
4. switch tree to staged projection
5. switch diagnostics freshness to staged basis contract
6. remove obsolete direct orchestration from `write.ts`

## Success criteria

1. AI file/resource mutations have a single canonical lifecycle owner.
2. Tool handlers are thin adapters rather than orchestration hubs.
3. Tree state and diagnostics state are projections of staged-document truth.
4. Failed mutations remain explicit and do not silently look committed.
5. UI/tool metadata, tree, editor, and diagnostics no longer drift due to split ownership.
