# Volt — local-first IDE (Tauri + Svelte)

Volt is a fast, VS Code-like desktop IDE built with **Tauri v2 (Rust)** and a **SvelteKit + TypeScript** frontend.

## Goal

The north star is an **agent-first IDE**:

- A solid local editor (files, search, LSP, terminal, git)
- An integrated “agent” workflow that can take multi-step actions (read/edit files, run commands, explain changes) while keeping the UI responsive

The core IDE features are already implemented; “agent” capabilities are a direction/roadmap and may be partially implemented depending on the current task stage.

## What works today

- **Workspace**: open folder, file tree, rename/create/delete
- **Editor**: Monaco editor, tabs, formatting hooks
- **Quick Open / Command Palette**: fuzzy file search backed by a scalable index
- **Search**: workspace search + replace with streaming results
- **Terminal**: integrated PTY terminal sessions
- **Git (MVP)**: status/stage/unstage/commit/branches/diff/discard with cancellation for long operations
- **LSP sidecars**: TypeScript, ESLint, Tailwind, Svelte (runs real language servers)

## Repo layout

- `src/` — SvelteKit + TypeScript frontend
- `src-tauri/` — Tauri v2 Rust backend (commands, PTY, git, indexing, sidecars)
- `scripts/` — build helpers (sidecars)
- `docs/` — dev notes

## Prerequisites

- Node.js (recommended: current LTS)
- Rust toolchain (stable)
- Tauri prerequisites for your OS (Windows needs WebView2)

## Run (desktop)

```bash
npm install
npm run sidecars:node
npm run tauri dev
```

## Checks

```bash
# frontend typecheck
npm run check

# backend compile check
cd src-tauri
cargo check
```

## Build

```bash
npm run sidecars:node
npm run tauri build
```

## LSP sidecars (how it works)

Volt runs language servers as **Tauri sidecars**.

- A Node runtime is prepared as a sidecar (see `npm run sidecars:node`).
- Language servers are started by the Rust backend and connected to the editor over an internal transport.
- Platform launchers live under `src-tauri/binaries/` (Windows uses `.cmd` wrappers).

## Notes

- This project is under active development; behavior may change as tasks in the spec evolve.
- The implementation plan lives in the task spec at .kiro/specs/volt/tasks.md.
