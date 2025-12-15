# Copilot instructions (Volt)

> Repo root is `volt/` (run commands from here).

## Big picture
- Volt is a VS Code-like desktop IDE: **SvelteKit (SPA) + Svelte 5 runes + Monaco + xterm.js** frontend in `src/`, **Tauri v2 (Rust)** backend in `src-tauri/`.
- SPA mode is intentional for Tauri (no SSR). See `src/routes/+layout.ts` (`export const ssr = false`).

## Dev workflows
- Install + run desktop app:
  - `npm install`
  - `npm run tauri dev` (Tauri runs `npm run dev:with-sidecars` via `src-tauri/tauri.conf.json`)
- Typecheck:
  - `npm run check` (runs `svelte-kit sync` + `svelte-check`)
- Rust unit tests (backend):
  - `cd src-tauri && cargo test`
- Sidecar prep (LSP Node runtime):
  - `npm run sidecars:node` (used by `dev:with-sidecars` / `build:with-sidecars`)

## Agent expectations (anti-lazy, repo-specific)
- Don’t stop at “analysis”: if you find a clear bug, contract mismatch, or missing wired feature, implement the fix end-to-end (frontend + Rust command/event if needed).
- Actively hunt “missing pieces” by searching for `coming soon`, stub menu items, and disabled panels (common: Search/Git/Settings UI panels, file-open flow).
- Validate changes with the closest cheap checks:
  - Frontend: `npm run check` (and `npm run build` if you touched bundling/build paths)
  - Backend: `cd src-tauri && cargo test` (file ops has tests in `src-tauri/src/commands/file_ops.rs`)

## Steering docs
- General agent behavior (anti-lazy): `.kiro/steering/agent.md`
- In-app assistant/tool governance (Phase 10): `.kiro/specs/volt/tasks.md` (Phase 10)

## Frontend conventions (Svelte 5 runes)
- Stores are class-based runes stores in `src/lib/stores/*.svelte.ts` using `$state/$derived/$effect`.
  - Avoid mutating `$state` arrays in-place; always assign a new array (see `docs/DEBUGGING-UI-HANGS.md`).
- App shell and keybindings live in `src/lib/components/layout/MainLayout.svelte`.
  - File switching triggers immediate auto-save before opening new tabs.
  - Saves prefer the live Monaco model value (see `handleSave`).

## Backend conventions (Tauri/Rust)
- Tauri commands are implemented in `src-tauri/src/commands/*.rs` and registered in `src-tauri/src/lib.rs`.
- File ops (`read_file`, `write_file`, `list_dir_detailed`, etc.) use `tokio::task::spawn_blocking` and typed errors (`FileError`) and handle Windows long paths (\\?\ prefix) in `src-tauri/src/commands/file_ops.rs`.
- Terminal sessions are PTY-based (`portable_pty`) and stream data via app events:
  - `terminal://data` and `terminal://exit` (see `src-tauri/src/commands/terminal.rs`).

## LSP sidecar data flow (critical)
- Rust spawns language servers as **Tauri shell sidecars** via a single Node sidecar:
  - Start/stop/send/list commands: `lsp_start_server`, `lsp_stop_server`, `lsp_send_message`, etc. in `src-tauri/src/commands/lsp.rs`.
  - Sidecar stdout is parsed as LSP frames (`Content-Length` header) in `src-tauri/src/lsp/manager.rs`.
  - Emitted events are namespaced per server id:
    - `lsp://{serverId}//message`, `lsp://{serverId}//stderr`, `lsp://{serverId}//exit`.

## Packaging / resources
- Production bundles ship `node_modules/**/*` as resources and include the Node sidecar as `src-tauri/binaries/node` (see `src-tauri/tauri.conf.json`).
- Platform binaries under `src-tauri/binaries/` are intentionally not committed (see `README.md`).

## When changing behavior
- Prefer keeping cross-boundary contracts stable:
  - Tauri invoke command names + payload shapes (TS services under `src/lib/services/*` call these).
  - Event names for terminal/LSP streams.
- If you touch `$effect` async flows, add concurrency guards to prevent UI hangs (see `docs/DEBUGGING-UI-HANGS.md`).
