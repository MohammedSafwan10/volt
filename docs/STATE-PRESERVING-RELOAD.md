# State-Preserving Reload

Volt implements a VS Code–style **state snapshot / restore** system that preserves
the IDE's runtime state across page reloads — both during Vite HMR in development
and when using the manual **Developer: Reload Window** command (Ctrl+Shift+R).

## How it works

```
  ┌──────────────────────────────────────────────────┐
  │                Before Reload                      │
  │  1. hmr-cleanup.ts fires (HMR dispose / unload)  │
  │  2. stateSnapshotService.snapshot()               │
  │     → each participant.getSnapshot() → JSON       │
  │     → saved to sessionStorage                     │
  │  3. Cleanup functions run (Tauri listeners, etc.) │
  │  4. Page unloads / HMR hot-swaps module           │
  └──────────────────────────────────────────────────┘
                         ↓
  ┌──────────────────────────────────────────────────┐
  │                After Reload                       │
  │  1. +layout.svelte checks isReload()              │
  │  2. stateSnapshotService.restore()                │
  │     → participants sorted by priority (low first) │
  │     → each participant.restoreSnapshot(data)      │
  │  3. sessionStorage snapshots cleared (one-shot)   │
  │  4. Normal app init continues                     │
  └──────────────────────────────────────────────────┘
```

### Storage

All snapshots are stored in **`sessionStorage`** under the prefix
`volt.stateSnapshot.<participantId>`. Session storage is ephemeral — it survives
page reloads but is cleared when the browser tab closes. This is ideal: we never
want to restore stale state from a previous session.

A **staleness guard** (30 s) ensures that if the page somehow takes too long to
reload, old snapshots are discarded.

## Key files

| File | Role |
|------|------|
| `src/lib/core/services/state-snapshot.ts` | Core `StateSnapshotService` singleton and `ISnapshotParticipant` interface |
| `src/lib/core/services/hmr-cleanup.ts` | Triggers `snapshot()` in `beforeunload` and HMR `dispose` hooks |
| `src/routes/+layout.svelte` | Calls `restore()` on startup when a reload is detected |
| `src/lib/shared/stores/ui.svelte.ts` | UI layout participant (sidebar, panels, zoom) |
| `src/lib/shared/stores/bottom-panel.svelte.ts` | Bottom panel tab participant |
| `src/lib/features/assistant/stores/assistant.svelte.ts` | Assistant panel + conversation pointer participant |
| `src/lib/features/editor/stores/editor.svelte.ts` | Open files / active tab participant |
| `src/lib/features/terminal/stores/terminal.svelte.ts` | Terminal session labels + active/AI terminal IDs |

## Adding a new snapshot participant

1. **Implement `ISnapshotParticipant`** in your store class:

```ts
import { stateSnapshotService, type ISnapshotParticipant } from '$core/services/state-snapshot';

class MyStore implements ISnapshotParticipant {
  readonly snapshotPriority = 5; // lower = restores first

  getSnapshot() {
    return { /* JSON-serializable state */ };
  }

  restoreSnapshot(data: unknown) {
    const snap = data as MySnapshot;
    // apply snap to this store's reactive state
  }
}
```

2. **Register the singleton** after construction:

```ts
export const myStore = new MyStore();
stateSnapshotService.registerParticipant('myStore', myStore);
```

### Priority guide

| Priority | Use case |
|----------|----------|
| 0 | Layout / UI chrome (sidebar, panels) |
| 1 | Feature panel state (assistant, settings) |
| 2 | Editor state (open files, active tab) |
| 3 | Terminal (needs backend sync first) |
| 5+ | Anything that depends on the above |

### Rules

- **Only snapshot what you need.** Prefer IDs and pointers over full data.
  Messages are in the DB; file content is on disk. Snapshot the *references*.
- **`getSnapshot()` must return JSON-serializable data.** No class instances,
  functions, or circular references.
- **`restoreSnapshot()` should be defensive.** Validate every field before
  applying — the schema may have changed between builds.
- **Async work in `restoreSnapshot()`** is fine — use `void promise.then(...)`.
  The restore loop is synchronous but participants can kick off async follow-up
  (e.g., terminal waits for `ensureSynced()`).

## Reload Window command

- **Keyboard shortcut:** `Ctrl+Shift+R` (or `Cmd+Shift+R` on macOS)
- **Command palette:** "Developer: Reload Window"
- Calls `stateSnapshotService.reloadWindow()` which:
  1. Sets reload reason to `'manual'`
  2. Snapshots all participants
  3. Calls `window.location.reload()`

## Terminal sessions

Terminal PTY processes live in the **Tauri backend** and survive frontend reloads.
On restore, the `TerminalStore`:

1. Restores session labels immediately
2. Waits for `ensureSynced()` (which calls `syncWithBackend()` to rediscover
   backend-managed sessions)
3. Re-applies the saved `activeTerminalId` and `aiTerminalId` if those sessions
   still exist

## HMR safety

- `state-snapshot.ts` uses `import.meta.hot.accept()` to force a full page
  reload (with snapshot) if the service module itself is hot-replaced. This
  prevents stale singleton references.
- The `hmr-cleanup.ts` `dispose` hook snapshots state *before* running cleanup
  functions, so even HMR-triggered reloads preserve state.
