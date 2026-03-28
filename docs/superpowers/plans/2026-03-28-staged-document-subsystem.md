# Staged Document Subsystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a canonical staged-document subsystem for AI-driven file and structural mutations so tool handlers, file tree state, and diagnostics all project from one mutation lifecycle instead of owning separate truth.

**Architecture:** Introduce a `staged-document-service` for canonical resource snapshots and a `workspace-mutation-coordinator` that drives mutation intents through `prepare -> stage -> commit -> project -> finalize`. Migrate AI file tools to thin intent adapters first, then project staged state into file tree and diagnostics freshness/basis.

**Tech Stack:** TypeScript, Svelte stores/runes, Tauri invoke APIs, existing native document manager, Vitest, svelte-check, ESLint

---

## File Structure

### New files

- `src/lib/core/services/staged-document-service.ts`
  - Canonical staged resource store and subscription API
- `src/lib/core/services/staged-document-service.test.ts`
  - Unit tests for state transitions and failure retention
- `src/lib/core/services/workspace-mutation-coordinator.ts`
  - Accepts mutation intents, runs lifecycle, returns normalized results
- `src/lib/core/services/workspace-mutation-coordinator.test.ts`
  - Unit tests for content and structural mutation flows
- `src/lib/core/services/staged-document-projections.ts`
  - Shared helpers that map staged state into editor/tree/diagnostics projection payloads

### Modified files

- `src/lib/core/ai/tools/handlers/write.ts`
  - Convert file tools into thin intent builders and result shapers
- `src/lib/core/services/file-service.ts`
  - Keep as backend, add only minimal interfaces/helpers needed by coordinator
- `src/lib/shared/stores/project.svelte.ts`
  - Add staged tree overlay/projection support
- `src/lib/shared/stores/problems.svelte.ts`
  - Add diagnostics basis/freshness support from staged records
- `src/lib/core/ai/tools/handlers/diagnostics.ts`
  - Return staged diagnostics basis/freshness metadata
- `src/lib/features/editor/components/file-tree/FileTree.svelte`
  - Render staged projection signals rather than relying only on imperative refreshes

### Existing tests to extend

- `src/lib/core/ai/tools/handlers/write*.test.ts` if present
- `src/lib/shared/stores/project*.test.ts` if present
- `src/lib/shared/stores/problems*.test.ts` if present

---

### Task 1: Build staged-document-service core model

**Files:**
- Create: `src/lib/core/services/staged-document-service.ts`
- Create: `src/lib/core/services/staged-document-service.test.ts`

- [ ] **Step 1: Write the failing tests for canonical staged state**

```ts
import { describe, expect, it } from "vitest";
import {
  createStagedDocumentService,
  type MutationPhase,
  type StagedResourceState,
} from "./staged-document-service";

describe("staged-document-service", () => {
  it("tracks staged_modified to committed transitions for file content", () => {
    const service = createStagedDocumentService();

    service.stage({
      path: "src/app.ts",
      kind: "file",
      state: "staged_modified",
      phase: "stage",
      committedContent: "before",
      stagedContent: "after",
      version: 3,
    });

    service.finalizeSuccess("src/app.ts", {
      committedContent: "after",
      version: 4,
    });

    expect(service.get("src/app.ts")).toMatchObject({
      state: "committed" satisfies StagedResourceState,
      phase: "finalize" satisfies MutationPhase,
      committedContent: "after",
      stagedContent: "after",
      version: 4,
    });
  });

  it("retains failure metadata when a staged mutation fails", () => {
    const service = createStagedDocumentService();

    service.stage({
      path: "src/app.ts",
      kind: "file",
      state: "staged_modified",
      phase: "commit",
      committedContent: "before",
      stagedContent: "after",
      version: 3,
    });

    service.finalizeFailure("src/app.ts", "disk write failed");

    expect(service.get("src/app.ts")).toMatchObject({
      state: "failed",
      phase: "finalize",
      error: "disk write failed",
      committedContent: "before",
      stagedContent: "after",
    });
  });

  it("supports structural staged_delete state", () => {
    const service = createStagedDocumentService();

    service.stage({
      path: "src/obsolete.ts",
      kind: "file",
      state: "staged_delete",
      phase: "stage",
      committedContent: "legacy",
      stagedContent: null,
      version: 5,
    });

    expect(service.get("src/obsolete.ts")).toMatchObject({
      state: "staged_delete",
      committedContent: "legacy",
      stagedContent: null,
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm test -- --run src/lib/core/services/staged-document-service.test.ts
```

Expected: fail because `staged-document-service.ts` does not exist yet

- [ ] **Step 3: Implement the minimal staged-document-service**

```ts
export type StagedResourceState =
  | "absent"
  | "staged_new"
  | "staged_modified"
  | "staged_delete"
  | "committed"
  | "failed";

export type MutationPhase = "prepare" | "stage" | "commit" | "project" | "finalize";

export interface StagedResourceRecord {
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

export function createStagedDocumentService() {
  const records = new Map<string, StagedResourceRecord>();

  return {
    get(path: string): StagedResourceRecord | null {
      return records.get(path) ?? null;
    },
    list(): StagedResourceRecord[] {
      return [...records.values()];
    },
    stage(record: StagedResourceRecord): void {
      records.set(record.path, { ...record });
    },
    finalizeSuccess(
      path: string,
      next: { committedContent?: string | null; version?: number },
    ): void {
      const existing = records.get(path);
      if (!existing) return;
      records.set(path, {
        ...existing,
        state: "committed",
        phase: "finalize",
        committedContent: next.committedContent ?? existing.stagedContent ?? existing.committedContent,
        stagedContent: next.committedContent ?? existing.stagedContent ?? existing.committedContent,
        version: next.version ?? existing.version,
        error: undefined,
      });
    },
    finalizeFailure(path: string, error: string): void {
      const existing = records.get(path);
      if (!existing) return;
      records.set(path, {
        ...existing,
        state: "failed",
        phase: "finalize",
        error,
      });
    },
    clear(path: string): void {
      records.delete(path);
    },
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
npm test -- --run src/lib/core/services/staged-document-service.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/core/services/staged-document-service.ts src/lib/core/services/staged-document-service.test.ts
git commit -m "feat(document): add staged document service"
```

---

### Task 2: Add workspace-mutation-coordinator for content and structural intents

**Files:**
- Create: `src/lib/core/services/workspace-mutation-coordinator.ts`
- Create: `src/lib/core/services/workspace-mutation-coordinator.test.ts`
- Modify: `src/lib/core/services/file-service.ts`

- [ ] **Step 1: Write failing coordinator tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createStagedDocumentService } from "./staged-document-service";
import { createWorkspaceMutationCoordinator } from "./workspace-mutation-coordinator";

describe("workspace-mutation-coordinator", () => {
  it("stages then commits a write intent", async () => {
    const staged = createStagedDocumentService();
    const backend = {
      read: vi.fn().mockResolvedValue({
        path: "src/app.ts",
        content: "before",
        version: 1,
        diskVersion: 1,
        isDirty: false,
        lastModified: 1,
      }),
      write: vi.fn().mockResolvedValue({ success: true, newVersion: 2 }),
    };

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: "write",
      path: "src/app.ts",
      content: "after",
    });

    expect(result.success).toBe(true);
    expect(staged.get("src/app.ts")).toMatchObject({
      state: "committed",
      committedContent: "after",
      version: 2,
    });
  });

  it("retains failed state when backend write fails", async () => {
    const staged = createStagedDocumentService();
    const backend = {
      read: vi.fn().mockResolvedValue({
        path: "src/app.ts",
        content: "before",
        version: 1,
        diskVersion: 1,
        isDirty: false,
        lastModified: 1,
      }),
      write: vi.fn().mockResolvedValue({ success: false, error: "permission denied" }),
    };

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: "write",
      path: "src/app.ts",
      content: "after",
    });

    expect(result.success).toBe(false);
    expect(staged.get("src/app.ts")).toMatchObject({
      state: "failed",
      error: "permission denied",
    });
  });

  it("stages structural delete intents", async () => {
    const staged = createStagedDocumentService();
    const backend = {
      read: vi.fn().mockResolvedValue({
        path: "src/old.ts",
        content: "legacy",
        version: 4,
        diskVersion: 4,
        isDirty: false,
        lastModified: 1,
      }),
      deletePath: vi.fn().mockResolvedValue({ success: true }),
    };

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    await coordinator.run({
      type: "delete",
      path: "src/old.ts",
    });

    expect(staged.get("src/old.ts")).toMatchObject({
      state: "committed",
      phase: "finalize",
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm test -- --run src/lib/core/services/workspace-mutation-coordinator.test.ts
```

Expected: FAIL because coordinator does not exist yet

- [ ] **Step 3: Implement the minimal coordinator and backend interface**

```ts
import type { FileDocument, WriteResult } from "./file-service";
import type { StagedResourceRecord } from "./staged-document-service";

type MutationIntent =
  | { type: "write"; path: string; content: string; createIfMissing?: boolean }
  | { type: "delete"; path: string }
  | { type: "create_dir"; path: string }
  | { type: "rename"; oldPath: string; newPath: string };

interface FileBackend {
  read(path: string, forceRefresh?: boolean): Promise<FileDocument | null>;
  write(path: string, content: string, options?: Record<string, unknown>): Promise<WriteResult>;
  deletePath?(path: string): Promise<{ success: boolean; error?: string }>;
  createDir?(path: string): Promise<{ success: boolean; error?: string }>;
  renamePath?(oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }>;
}

export function createWorkspaceMutationCoordinator(deps: {
  stagedDocuments: {
    stage(record: StagedResourceRecord): void;
    finalizeSuccess(path: string, next: { committedContent?: string | null; version?: number }): void;
    finalizeFailure(path: string, error: string): void;
  };
  fileBackend: FileBackend;
}) {
  return {
    async run(intent: MutationIntent): Promise<{ success: boolean; error?: string }> {
      if (intent.type === "write") {
        const current = await deps.fileBackend.read(intent.path, true);
        deps.stagedDocuments.stage({
          path: intent.path,
          kind: "file",
          state: current ? "staged_modified" : "staged_new",
          phase: "stage",
          committedContent: current?.content ?? null,
          stagedContent: intent.content,
          version: current?.version,
        });

        const writeResult = await deps.fileBackend.write(intent.path, intent.content, {
          expectedVersion: current?.version,
          createIfMissing: intent.createIfMissing ?? !current,
          source: "ai",
        });

        if (!writeResult.success) {
          deps.stagedDocuments.finalizeFailure(intent.path, writeResult.error ?? "write failed");
          return { success: false, error: writeResult.error ?? "write failed" };
        }

        deps.stagedDocuments.finalizeSuccess(intent.path, {
          committedContent: intent.content,
          version: writeResult.newVersion,
        });
        return { success: true };
      }

      if (intent.type === "delete") {
        const current = await deps.fileBackend.read(intent.path, true);
        deps.stagedDocuments.stage({
          path: intent.path,
          kind: "file",
          state: "staged_delete",
          phase: "stage",
          committedContent: current?.content ?? null,
          stagedContent: null,
          version: current?.version,
        });

        const result = await deps.fileBackend.deletePath?.(intent.path);
        if (!result?.success) {
          deps.stagedDocuments.finalizeFailure(intent.path, result?.error ?? "delete failed");
          return { success: false, error: result?.error ?? "delete failed" };
        }

        deps.stagedDocuments.finalizeSuccess(intent.path, {
          committedContent: null,
          version: current?.version,
        });
        return { success: true };
      }

      return { success: false, error: `Unsupported intent: ${intent.type}` };
    },
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
npm test -- --run src/lib/core/services/workspace-mutation-coordinator.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/core/services/workspace-mutation-coordinator.ts src/lib/core/services/workspace-mutation-coordinator.test.ts src/lib/core/services/file-service.ts
git commit -m "feat(document): add mutation coordinator"
```

---

### Task 3: Add projection helpers for tree and diagnostics basis

**Files:**
- Create: `src/lib/core/services/staged-document-projections.ts`
- Modify: `src/lib/shared/stores/problems.svelte.ts`
- Test: `src/lib/core/services/staged-document-service.test.ts`

- [ ] **Step 1: Write the failing projection tests**

```ts
import { describe, expect, it } from "vitest";
import {
  projectDiagnosticsState,
  projectTreeMutationState,
} from "./staged-document-projections";

describe("staged-document-projections", () => {
  it("projects staged_modified files into tree overlay state", () => {
    const result = projectTreeMutationState([
      {
        path: "src/app.ts",
        kind: "file",
        state: "staged_modified",
        phase: "project",
      },
    ]);

    expect(result["src/app.ts"]).toMatchObject({
      state: "staged_modified",
      kind: "file",
    });
  });

  it("projects explicit diagnostics basis and freshness", () => {
    const result = projectDiagnosticsState({
      path: "src/app.ts",
      kind: "file",
      state: "failed",
      phase: "finalize",
      diagnosticsBasis: "staged_tool_output",
      diagnosticsFreshness: "pending",
    });

    expect(result).toEqual({
      basis: "staged_tool_output",
      freshness: "pending",
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm test -- --run src/lib/core/services/staged-document-service.test.ts
```

Expected: FAIL because projection helpers do not exist yet

- [ ] **Step 3: Implement minimal projection helpers and diagnostics support**

```ts
import type { StagedResourceRecord } from "./staged-document-service";

export function projectTreeMutationState(records: StagedResourceRecord[]) {
  return Object.fromEntries(
    records.map((record) => [
      record.path,
      {
        kind: record.kind,
        state: record.state,
        previousPath: record.previousPath,
        nextPath: record.nextPath,
      },
    ]),
  );
}

export function projectDiagnosticsState(record: StagedResourceRecord | null) {
  return {
    basis: record?.diagnosticsBasis ?? "committed_disk",
    freshness: record?.diagnosticsFreshness ?? "fresh",
  } as const;
}
```

Add to `problems.svelte.ts` a small explicit basis property:

```ts
export type DiagnosticsBasis = "committed_disk" | "editor_buffer" | "staged_tool_output";

diagnosticsBasis: DiagnosticsBasis = "committed_disk";

setDiagnosticsBasis(next: DiagnosticsBasis): void {
  this.diagnosticsBasis = next;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
npm test -- --run src/lib/core/services/staged-document-service.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/core/services/staged-document-projections.ts src/lib/shared/stores/problems.svelte.ts src/lib/core/services/staged-document-service.test.ts
git commit -m "feat(document): add staged projections"
```

---

### Task 4: Migrate content file tools to mutation intents

**Files:**
- Modify: `src/lib/core/ai/tools/handlers/write.ts`
- Modify: `src/lib/core/services/workspace-mutation-coordinator.ts`
- Test: `src/lib/core/services/workspace-mutation-coordinator.test.ts`

- [ ] **Step 1: Write a failing regression test for write tool delegation**

```ts
import { describe, expect, it, vi } from "vitest";
import * as writeHandlers from "./write";

describe("write tool handlers", () => {
  it("routes handleWriteFile through the workspace mutation coordinator", async () => {
    const run = vi.fn().mockResolvedValue({
      success: true,
      record: {
        path: "src/app.ts",
        state: "committed",
        committedContent: "after",
      },
    });

    const result = await writeHandlers.handleWriteFile(
      { path: "src/app.ts", content: "after" },
      undefined,
      { run } as never,
    );

    expect(run).toHaveBeenCalledWith({
      type: "write",
      path: "src/app.ts",
      content: "after",
      createIfMissing: true,
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --run src/lib/core/services/workspace-mutation-coordinator.test.ts
```

Expected: FAIL because handlers still own orchestration directly

- [ ] **Step 3: Refactor content handlers into thin adapters**

Replace direct orchestration in:

- `handleWriteFile`
- `handleAppendFile`
- `handleStrReplace`
- `handleMultiReplace`
- `handleApplyPatch`
- `handleReplaceLines`

with the pattern:

```ts
const result = await workspaceMutationCoordinator.run({
  type: "write",
  path: relativePath,
  content,
  createIfMissing: true,
});

if (!result.success) {
  return { success: false, error: result.error };
}

return {
  success: true,
  output: `Updated ${relativePath}`,
  meta: {
    fileEdit: {
      relativePath,
      absolutePath: path,
      beforeContent: result.record?.committedContent ?? null,
      afterContent: result.record?.stagedContent ?? result.record?.committedContent ?? null,
    },
  },
};
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm test -- --run src/lib/core/services/workspace-mutation-coordinator.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/core/ai/tools/handlers/write.ts src/lib/core/services/workspace-mutation-coordinator.ts src/lib/core/services/workspace-mutation-coordinator.test.ts
git commit -m "refactor(document): route content tools through coordinator"
```

---

### Task 5: Migrate structural file tools and remove imperative tree ownership from handlers

**Files:**
- Modify: `src/lib/core/ai/tools/handlers/write.ts`
- Modify: `src/lib/shared/stores/project.svelte.ts`
- Test: `src/lib/core/services/workspace-mutation-coordinator.test.ts`

- [ ] **Step 1: Write failing tests for structural intent routing**

```ts
import { describe, expect, it, vi } from "vitest";

describe("structural mutation handlers", () => {
  it("routes delete through the coordinator instead of removing tree nodes directly", async () => {
    const run = vi.fn().mockResolvedValue({ success: true });
    const removeNode = vi.fn();

    await handleDeleteFile(
      { path: "src/old.ts" },
      { run, removeNode } as never,
    );

    expect(run).toHaveBeenCalledWith({
      type: "delete",
      path: "src/old.ts",
    });
    expect(removeNode).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm test -- --run src/lib/core/services/workspace-mutation-coordinator.test.ts
```

Expected: FAIL because structural handlers still mutate tree/editor state directly

- [ ] **Step 3: Route `create_dir`, `delete`, and `rename` through coordinator**

Implement structural adapter flow:

```ts
await workspaceMutationCoordinator.run({
  type: "delete",
  path: relativePath,
});
```

and remove direct handler-owned calls like:

```ts
await projectStore.refreshTree();
projectStore.removeNode(path);
```

from structural tool handlers.

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
npm test -- --run src/lib/core/services/workspace-mutation-coordinator.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/core/ai/tools/handlers/write.ts src/lib/shared/stores/project.svelte.ts src/lib/core/services/workspace-mutation-coordinator.test.ts
git commit -m "refactor(document): route structural tools through coordinator"
```

---

### Task 6: Project staged resource state into the file tree

**Files:**
- Modify: `src/lib/shared/stores/project.svelte.ts`
- Modify: `src/lib/features/editor/components/file-tree/FileTree.svelte`
- Test: `src/lib/shared/stores/project.svelte.ts` related test file if present, otherwise create `src/lib/shared/stores/project-staged-tree.test.ts`

- [ ] **Step 1: Write the failing tree projection test**

```ts
import { describe, expect, it } from "vitest";
import { projectTreeMutationState } from "$core/services/staged-document-projections";

describe("project tree staged overlay", () => {
  it("marks modified files without requiring full refresh", () => {
    const overlay = projectTreeMutationState([
      {
        path: "src/app.ts",
        kind: "file",
        state: "staged_modified",
        phase: "project",
      },
    ]);

    expect(overlay["src/app.ts"].state).toBe("staged_modified");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --run src/lib/shared/stores/project-staged-tree.test.ts
```

Expected: FAIL because staged tree overlay support does not exist yet

- [ ] **Step 3: Add staged overlay state to project store and render it**

In `project.svelte.ts`, add:

```ts
stagedTreeOverlay: Record<
  string,
  { kind: "file" | "directory"; state: string; previousPath?: string; nextPath?: string }
> = {};

setStagedTreeOverlay(next: Record<string, { kind: "file" | "directory"; state: string }>): void {
  this.stagedTreeOverlay = next;
}
```

In `FileTree.svelte`, render a staged status indicator from `projectStore.stagedTreeOverlay[node.path]`.

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm test -- --run src/lib/shared/stores/project-staged-tree.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/stores/project.svelte.ts src/lib/features/editor/components/file-tree/FileTree.svelte src/lib/shared/stores/project-staged-tree.test.ts
git commit -m "feat(tree): project staged document overlay"
```

---

### Task 7: Project staged diagnostics basis and freshness into problems store

**Files:**
- Modify: `src/lib/shared/stores/problems.svelte.ts`
- Modify: `src/lib/core/ai/tools/handlers/diagnostics.ts`
- Test: create `src/lib/shared/stores/problems-staged-diagnostics.test.ts`

- [ ] **Step 1: Write the failing diagnostics basis test**

```ts
import { describe, expect, it } from "vitest";
import { problemsStore } from "./problems.svelte";

describe("problems store staged diagnostics basis", () => {
  it("tracks diagnostics basis separately from freshness", () => {
    problemsStore.setDiagnosticsBasis("staged_tool_output");
    problemsStore.markSourceStale("typescript");

    expect(problemsStore.diagnosticsBasis).toBe("staged_tool_output");
    expect(problemsStore.diagnosticsFreshness.status).toBe("stale");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --run src/lib/shared/stores/problems-staged-diagnostics.test.ts
```

Expected: FAIL because basis tracking does not exist yet

- [ ] **Step 3: Add basis-aware diagnostics state and expose it through diagnostics handler**

In `problems.svelte.ts`, add:

```ts
export type DiagnosticsBasis = "committed_disk" | "editor_buffer" | "staged_tool_output";

diagnosticsBasis: DiagnosticsBasis = "committed_disk";

setDiagnosticsBasis(next: DiagnosticsBasis): void {
  this.diagnosticsBasis = next;
}
```

In `diagnostics.ts`, include:

```ts
meta: {
  diagnosticsFreshness: problemsStore.diagnosticsFreshness,
  diagnosticsBasis: problemsStore.diagnosticsBasis,
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm test -- --run src/lib/shared/stores/problems-staged-diagnostics.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/stores/problems.svelte.ts src/lib/core/ai/tools/handlers/diagnostics.ts src/lib/shared/stores/problems-staged-diagnostics.test.ts
git commit -m "feat(diagnostics): add staged basis tracking"
```

---

### Task 8: Final regression validation for staged truth across tools, tree, and diagnostics

**Files:**
- Modify: tests created above as needed

- [ ] **Step 1: Add a final regression test matrix**

Add tests that cover:

```ts
it("does not present failed mutation as committed");
it("projects staged_modified into tree overlay while diagnostics stay pending");
it("returns diagnostics basis metadata through the diagnostics tool");
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- --run src/lib/core/services/staged-document-service.test.ts src/lib/core/services/workspace-mutation-coordinator.test.ts src/lib/shared/stores/project-staged-tree.test.ts src/lib/shared/stores/problems-staged-diagnostics.test.ts
```

Expected: PASS

- [ ] **Step 3: Run repo validators**

Run:

```bash
npm run check
npx eslint "src/lib/core/services/staged-document-service.ts" "src/lib/core/services/workspace-mutation-coordinator.ts" "src/lib/core/services/staged-document-projections.ts" "src/lib/core/ai/tools/handlers/write.ts" "src/lib/shared/stores/project.svelte.ts" "src/lib/shared/stores/problems.svelte.ts" "src/lib/core/ai/tools/handlers/diagnostics.ts" "src/lib/features/editor/components/file-tree/FileTree.svelte"
```

Expected:

- `svelte-check found 0 errors and 0 warnings`
- eslint exits successfully

- [ ] **Step 4: Review diff**

Run:

```bash
git diff -- src/lib/core/services/staged-document-service.ts src/lib/core/services/workspace-mutation-coordinator.ts src/lib/core/services/staged-document-projections.ts src/lib/core/ai/tools/handlers/write.ts src/lib/shared/stores/project.svelte.ts src/lib/shared/stores/problems.svelte.ts src/lib/core/ai/tools/handlers/diagnostics.ts src/lib/features/editor/components/file-tree/FileTree.svelte
```

Expected: diff shows staged-document service, coordinator, thin tool handlers, tree overlay projection, and diagnostics basis/freshness updates

- [ ] **Step 5: Commit**

```bash
git add src/lib/core/services/staged-document-service.ts src/lib/core/services/workspace-mutation-coordinator.ts src/lib/core/services/staged-document-projections.ts src/lib/core/ai/tools/handlers/write.ts src/lib/shared/stores/project.svelte.ts src/lib/shared/stores/problems.svelte.ts src/lib/core/ai/tools/handlers/diagnostics.ts src/lib/features/editor/components/file-tree/FileTree.svelte
git add src/lib/core/services/staged-document-service.test.ts src/lib/core/services/workspace-mutation-coordinator.test.ts src/lib/shared/stores/project-staged-tree.test.ts src/lib/shared/stores/problems-staged-diagnostics.test.ts
git commit -m "feat(document): add staged document mutation pipeline"
```

---

## Self-Review

### Spec coverage

- canonical staged state: Task 1
- coordinator lifecycle: Task 2
- projection helpers: Task 3
- content tools as thin adapters: Task 4
- structural tools as thin adapters: Task 5
- tree projection: Task 6
- diagnostics basis/freshness projection: Task 7
- regression validation: Task 8

No spec gaps found.

### Placeholder scan

- no `TODO` / `TBD`
- every task has concrete files, code, commands, expected outcomes

### Type consistency

- canonical record names use `StagedResourceRecord`, `StagedResourceState`, `MutationPhase` consistently
- coordinator intent names align with spec (`write`, `delete`, `create_dir`, `rename`)
- diagnostics basis strings align with spec (`committed_disk`, `editor_buffer`, `staged_tool_output`)
