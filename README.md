# Volt — local-first IDE (Tauri + Svelte)

Volt is a fast, VS Code-like desktop IDE built with **Tauri v2 (Rust)** and a **SvelteKit + TypeScript** frontend.

## Goal

An agent-first, local IDE focused on delivering fast, native performance and on-demand language intelligence.

## What works today (high level)

- Workspace: open folder, file tree, rename/create/delete
- Editor: Monaco editor, tabs, formatting hooks
- Quick Open / Command Palette: fuzzy file search with index
- Search: workspace search + replace with streaming results
- Terminal: integrated PTY terminal sessions
- Git (MVP): status/stage/commit/branches/diff/discard with cancellation
- LSPs (on-demand): TypeScript/JavaScript, Svelte, HTML, CSS, JSON, Tailwind, ESLint, plus Dart, YAML, and XML support

## Supported Languages & LSPs (summary)

- **Dart / Flutter** — Dart Analysis Server (`dart language-server`) — diagnostics, go-to-def, hover, completions, rename, code actions, formatting (requires Dart/Flutter SDK)
- **YAML** — `yaml-language-server` — schema validation, completions, formatting (pubspec.yaml and other workflows/configs)
- **XML** — LemMinX (native binary or JAR via Java) — validation and completions for AndroidManifest.xml, Info.plist, XSD, etc.
- **TypeScript / JavaScript** — TypeScript Language Server (full TS/JS features)
- **Svelte** — Svelte Language Server
- **HTML / CSS / JSON / Tailwind / ESLint** — corresponding LSPs for web development

> LSP servers start on-demand when you open files that need them; this keeps Volt lightweight and responsive.

## Repo layout

- `src/` — SvelteKit + TypeScript frontend
- `src-tauri/` — Tauri v2 Rust backend (commands, PTY, git, indexing, sidecars)
- `scripts/` — build helpers (sidecars)
- `docs/` — developer notes and specs

## Prerequisites

- Node.js (recommended: current LTS)
- Rust toolchain (stable)
- Tauri prerequisites for your OS (Windows requires WebView2)
- **Dart / Flutter SDK** — required to enable Dart LSP for Flutter projects (install Flutter to get Dart)
- **yaml-language-server** — install via npm if you want YAML LSP support: `npm install -g yaml-language-server`
- **Java 11+** (optional) or LemMinX native binary — required if you want XML LSP via the LemMinX JAR; Volt also attempts to detect native LemMinX binaries

If a required SDK is missing (for example, Dart SDK), Volt logs guidance and can display notifications (configurable) to help users install it.

## Run (desktop development)

```bash
npm install
npm run sidecars:node
npm run tauri dev
```

## Frontend checks

```bash
# Typecheck and Svelte checks
npm run check
```

## Backend (Rust) checks

```bash
cd src-tauri
cargo check
```

## Build

```bash
npm run sidecars:node
npm run tauri build
```

## How LSP sidecars work

Volt runs language servers as either bundled sidecars or external processes from the user's system:

- Bundled sidecars: Node-based servers run via the prepared Node sidecar (`npm run sidecars:node`).
- External servers: Volt can spawn external language servers (e.g., `dart`, `gopls`, `pyright`) from PATH; detection is performed at runtime.
- The Rust backend (`src-tauri/src/lsp/manager.rs`) manages process lifecycle, message framing (Content-Length), and event routing to the frontend.

This separation keeps the UI process isolated from LSP processes and reduces memory/CPU overhead compared to embedding LSPs inside a single Node/Electron process.

## Contributing and development notes

- Repo layout: `src/` (frontend), `src-tauri/` (backend), `scripts/` (helpers), `docs/` (notes)
- Add new LSPs by extending the sidecar registry and adding detection logic in `src/lib/services/lsp/sidecar/`.
- Follow existing patterns for on-demand server start and diagnostic mapping to the problems panel.

## License / Distribution

This repository is **private** and not open-source. Do **not** add an open-source license file (MIT/Apache). The project is intended for private/internal use only.

If the distribution model changes later, update this section accordingly.

## Where to look next

- LSP manager (Rust): `src-tauri/src/lsp/manager.rs`
- LSP sidecar frontend: `src/lib/services/lsp/sidecar/`
- Dart LSP integration: `src/lib/services/lsp/dart-sidecar.ts`

If you'd like, I can also:

- Add a short UI notification when an SDK (e.g., Dart) is missing
- Add quick install instructions for common LSP servers
- Add screenshots or GIFs to the README

---

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
