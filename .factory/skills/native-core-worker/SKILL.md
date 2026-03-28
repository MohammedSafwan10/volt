---
name: native-core-worker
description: Rust-first runtime migration worker for backend ownership shifts with thin frontend adapters.
---

# Native Core Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that move runtime-critical ownership from TypeScript/Svelte into Rust:
- document manager and file authority
- workspace lifecycle and diagnostics supervision
- agent runtime orchestration
- LSP broker behavior
- MCP runtime/lifecycle ownership
- frontend adapter refactors that directly support those native services

## Required Skills

- `agent-browser` — use when the feature changes visible shell, editor, assistant, MCP, or other UI behavior and the local surface at `http://localhost:1420` is available.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, `.factory/services.yaml`, and the relevant `.factory/library/*.md` files before changing anything.
2. Characterize the existing behavior first:
   - identify the current TypeScript source of truth and the Rust/native ownership boundary
   - add or update focused tests before implementation when feasible
3. Implement backend-first:
   - create or extend the Rust service/manager and its typed command/event surface
   - move core runtime ownership into Rust
   - only then thin the TypeScript/Svelte adapter layer
4. Do not leave permanent dual-ownership logic behind:
   - temporary bridges are acceptable only if clearly scoped to the feature
   - remove duplicate runtime state where practical within the feature
5. Verify at three levels:
   - targeted tests for the changed subsystem
   - explicit regression coverage for any persistence/state flow that just became native-owned (for example restore state, recent-project persistence, freshness reconciliation, or other backend-owned lifecycle state), not only adjacent routing or adapter behavior
   - repo recurring gates relevant to the feature (`npm run test`, `npm run check`, plus Rust gates when available)
   - manual user-surface verification for changed visible behavior, or an explicit documented deferral if the user owns that verification or the surface is blocked
6. If the feature changes user-visible behavior and the local app surface is reachable, use `agent-browser` to validate it. If the surface is blocked or the user has reserved manual verification for themselves, document that explicitly in the handoff and do not imply the visible-flow check was completed.
7. Keep handoff evidence specific:
   - exact commands run
   - exactly what user flow was checked
   - if feature-scoped commit isolation is blocked by a dirty working tree, say that explicitly instead of citing unrelated commits as proof
   - any remaining bridge, blocker, or regression risk

## Example Handoff

```json
{
  "salientSummary": "Added a Rust document manager and migrated editor save/dirty flows onto it. Frontend file-service logic now acts as a thin adapter, and manual editor/save/rename flows still worked on the local surface.",
  "whatWasImplemented": "Created native document-state ownership in Rust for version tracking, dirty state, save/apply behavior, and conflict checks. Rewired editor/file adapters in TypeScript to consume the new native commands/events and removed duplicate write verification logic from the frontend path.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npm run test",
        "exitCode": 0,
        "observation": "Targeted editor/document tests passed after the migration."
      },
      {
        "command": "npm run check",
        "exitCode": 0,
        "observation": "Svelte/type checks passed for the touched adapter files."
      },
      {
        "command": "cargo check --manifest-path src-tauri/Cargo.toml",
        "exitCode": 0,
        "observation": "Rust document manager and command registration compiled successfully."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Opened an existing file, edited it, saved it, and confirmed the dirty indicator cleared while content persisted.",
        "observed": "The visible editor buffer, tab state, and saved file content stayed in sync."
      },
      {
        "action": "Renamed an open file from the explorer and kept working in the renamed tab.",
        "observed": "Tree entry and active tab both moved to the new path without duplication."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "src/lib/features/editor/stores/editor-lsp-lifecycle.test.ts",
        "cases": [
          {
            "name": "save follows native document authority",
            "verifies": "Visible save behavior still routes through the migrated native document layer."
          }
        ]
      }
    ]
  },
  "discoveredIssues": [
    {
      "severity": "medium",
      "description": "The local `http://localhost:1420` surface remained flaky under Tauri dev startup, so manual verification used the reachable shell only after retry."
    }
  ]
}
```

## When to Return to Orchestrator

- The feature needs a new validation strategy because the local app surface is unavailable
- The Rust/TypeScript ownership boundary cannot be changed safely without reordering upcoming features
- A blocker in Tauri/native environment prevents meaningful backend verification
- Preserving the user-visible contract would require scope from a different milestone
