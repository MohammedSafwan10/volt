---
name: stability-hardening-worker
description: Regression-hardening worker for browser/CDP removal, validation stabilization, and cross-area convergence.
---

# Stability Hardening Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that:
- remove obsolete browser/CDP surfaces
- stabilize failing validators or broken local flows
- harden terminal, git, search, or shell regressions during the migration
- remove temporary bridges and converge multi-area behavior near the end of the mission

## Required Skills

- `agent-browser` — use when verifying user-visible shell, assistant, search, git, terminal-adjacent UI, or MCP behavior on the local app surface.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, `.factory/services.yaml`, and `.factory/library/user-testing.md` first.
2. Start by reproducing the visible regression or validation blocker:
   - identify whether it is pre-existing, introduced by current mission work, or caused by stale removed browser/CDP paths
   - do not “fix around” a bug you have not reproduced
3. For removal work:
   - remove user-visible entrypoints first
   - remove backend/frontend dead references next
   - keep non-browser IDE flows working throughout
4. For regression hardening:
   - prefer targeted fixes with characterization tests
   - do not rewrite stable areas just because they are adjacent
5. Run the relevant recurring validators after each meaningful batch:
   - `npm run test`
   - `npm run check`
   - `npm run lint` when the touched area is ready for it
   - Rust validation if the feature affects native code and the environment blocker is resolved
6. Perform a focused manual sweep on the affected user flows.
   - if the feature requires visible/manual verification and you cannot actually perform it, do not imply it happened; report the verification as deferred/blocked and return non-success if that missing check matters to the feature contract
7. Keep narrowly targeted hardening features narrow:
   - do not bundle broad adjacent refactors just because they are in nearby files
   - if a required fix expands beyond the scoped regression/removal target, return to the orchestrator for a follow-up feature instead of widening the change opportunistically
8. If a baseline validator is still red, separate:
   - what you fixed
   - what remains pre-existing
   - what now blocks the next milestone

## Example Handoff

```json
{
  "salientSummary": "Removed the final browser/CDP shell exposure, retired remaining assistant browser paths, and stabilized the baseline tests needed for the next native-core milestone. Non-browser IDE panels still loaded and the assistant no longer exposed browser behavior as active tooling.",
  "whatWasImplemented": "Deleted remaining browser/CDP-facing UI entrypoints and stale tool/router references, updated strict-tool handling for retired browser behavior, and repaired the touched validation baseline so recurring test/check commands are usable again for the mission.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npm run test",
        "exitCode": 0,
        "observation": "The touched assistant/tooling and shell tests passed after removal cleanup."
      },
      {
        "command": "npm run check",
        "exitCode": 0,
        "observation": "Type and Svelte checks passed for the modified removal/hardening surfaces."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Opened the app shell and checked the activity bar and side panels.",
        "observed": "No browser panel remained accessible; explorer/search/git/MCP still rendered."
      },
      {
        "action": "Prompted the assistant for legacy browser behavior.",
        "observed": "The request did not expose active browser tools and surfaced retired/unsupported behavior instead."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "src/lib/core/ai/tools/router-strict.test.ts",
        "cases": [
          {
            "name": "retired browser tools are rejected deterministically",
            "verifies": "Legacy browser/CDP tool names remain retired rather than active."
          }
        ]
      }
    ]
  },
  "discoveredIssues": [
    {
      "severity": "low",
      "description": "The local dev surface still required a retry before `http://localhost:1420` was reachable, so future validators should verify startup before relying on browser-based checks."
    }
  ]
}
```

## When to Return to Orchestrator

- A failing validator or regression appears pre-existing and outside current feature scope, and it now blocks progress
- Removal/hardening work would require changing the milestone ordering
- The bug cannot be reproduced reliably enough to fix with confidence
- A convergence feature uncovers new architecture debt that deserves its own follow-up feature
