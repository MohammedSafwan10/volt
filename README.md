# Volt — local-first IDE (Tauri + Svelte)

Volt is a fast, VS Code-like desktop IDE built with **Tauri v2 (Rust)** and a **SvelteKit + TypeScript** frontend. It is **agent-first**, local, and optimized for native performance with on-demand language intelligence.

## What Works Today (High Level)

- Workspace: open folder, file tree, rename/create/delete
- Editor: Monaco editor, tabs, formatting hooks, diff view
- Command Palette / Quick Open: fuzzy file search + symbol picker
- Search: workspace search + replace with streaming results
- Terminal: integrated PTY terminal sessions
- Git (MVP): status/stage/commit/branches/diff/discard with cancellation
- LSPs (on-demand): TS/JS, Svelte, HTML, CSS, JSON, Tailwind, ESLint, plus Dart, YAML, XML
- Assistant: tool-driven agent (read/search/write/terminal/lsp/browser) with approvals and chat history
- Built-in Browser: native webview panel with devtools, element picker, and CDP automation (Windows)
- MCP: external tool servers integrated into the agent tool system

## Supported Languages & LSPs (Summary)

- **Dart / Flutter** — Dart Analysis Server (`dart language-server`) — diagnostics, go-to-def, hover, completions, rename, formatting (requires Dart/Flutter SDK)
- **YAML** — `yaml-language-server` — schema validation, completions, formatting
- **XML** — LemMinX (native binary or JAR via Java) — validation and completions for AndroidManifest.xml, Info.plist, XSD, etc.
- **TypeScript / JavaScript** — TypeScript Language Server (full TS/JS features)
- **Svelte** — Svelte Language Server
- **HTML / CSS / JSON / Tailwind / ESLint** — corresponding LSPs for web development

> LSP servers start on-demand when you open files that need them; this keeps Volt lightweight and responsive.

## Repo Layout

- `src/` — SvelteKit + TypeScript frontend
- `src-tauri/` — Tauri v2 Rust backend (commands, PTY, git, indexing, sidecars, browser)
- `scripts/` — build helpers (sidecars, cleanup)
- `docs/` — developer notes and specs

## Prerequisites

- Node.js (recommended: current LTS)
- Rust toolchain (stable)
- Tauri prerequisites for your OS (Windows requires WebView2)
- **Dart / Flutter SDK** — required to enable Dart LSP for Flutter projects (install Flutter to get Dart)
- **yaml-language-server** — install via npm if you want YAML LSP support: `npm install -g yaml-language-server`
- **Java 11+** (optional) or LemMinX native binary — required if you want XML LSP via the LemMinX JAR

If a required SDK is missing (for example, Dart SDK), Volt logs guidance and can display notifications (configurable) to help users install it.

## Run (Desktop Development)

```bash
npm install
npm run tauri dev
```

## Frontend Checks

```bash
npm run check
```

## Backend (Rust) Checks

```bash
cd src-tauri
cargo check
```

## Build

```bash
npm run tauri build
```

## Cargo Target Dir (Windows Fix)

To avoid build lock contention on Windows, Volt uses a dedicated Cargo target directory:

- Config: `src-tauri/.cargo/config.toml`
- Target dir: `.cargo-target/`

This prevents rust-analyzer and Cargo from locking the same `target/` folder.

## How LSP Sidecars Work

Volt runs language servers as either bundled sidecars or external processes from the user's system:

- Bundled sidecars: Node-based servers run via the prepared Node sidecar (`npm run sidecars:node`).
- External servers: Volt can spawn external language servers (e.g., `dart`, `gopls`, `pyright`) from PATH; detection is performed at runtime.
- The Rust backend (`src-tauri/src/lsp/manager.rs`) manages process lifecycle, message framing (Content-Length), and event routing to the frontend.

This separation keeps the UI process isolated from LSP processes and reduces memory/CPU overhead compared to embedding LSPs inside a single Node/Electron process.

## Where to Look Next

- LSP manager (Rust): `src-tauri/src/lsp/manager.rs`
- LSP sidecar frontend: `src/lib/services/lsp/sidecar/`
- Dart LSP integration: `src/lib/services/lsp/dart-sidecar.ts`
- Assistant tool router: `src/lib/services/ai/tools/router.ts`
- Assistant panel UI: `src/lib/components/assistant/AssistantPanel.svelte`
- Browser panel: `src/lib/components/browser/BrowserPanel.svelte`

## License / Distribution

This repository is **private** and not open-source. Do **not** add an open-source license file (MIT/Apache). The project is intended for private/internal use only.

If the distribution model changes later, update this section accordingly.
