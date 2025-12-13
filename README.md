# Volt (Tauri + Svelte) – VS Code‑like IDE

This repo contains **Volt**, a lightweight VS Code‑style IDE built with **Tauri v2 (Rust)** and a **SvelteKit + TypeScript** frontend.

## Project layout

- `src/` – SvelteKit + TypeScript frontend
- `src-tauri/` – Tauri v2 Rust backend

## Prerequisites

- Node.js (for development)
- Rust toolchain (for Tauri)

## Run (desktop app)

```bash
npm install
npm run tauri dev
```

## LSP sidecar infrastructure (Phase 5)

Volt runs real language servers as **Tauri sidecars**.

- We bundle **Node** as a single sidecar executable.
- Language servers are executed from bundled `node_modules` entrypoints.
- The Node sidecar is prepared automatically during dev/build via:
  - `npm run sidecars:node`

## Notes

- This repository intentionally does **not** commit platform-specific binaries (`src-tauri/binaries/`). They are generated/downloaded per platform.
