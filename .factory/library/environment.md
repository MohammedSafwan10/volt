# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** required tooling, external dependencies, platform-specific notes, known environment blockers.
**What does NOT belong here:** service commands and ports (use `.factory/services.yaml`).

---

- Platform during planning: Windows
- Existing app flow uses Tauri + Vite with dev URL `http://localhost:1420`
- `http://localhost:1420` is only an internal desktop-dev dependency for Tauri, not a supported web target
- Existing occupied ports observed during planning: `3000`, `3306`, `5432`
- Required local tooling:
  - Node / npm
  - Rust / Cargo
  - Tauri prerequisites for Windows / WebView2
- Tauri build config depends on prepared sidecars/resources:
  - bundled node sidecar
  - bundled rg sidecar
  - `node_modules` resources included by Tauri config

## Known validation blockers during planning

- `npm run check`, `npm run lint`, and `npm run test` were runnable but already red
- `cargo check --manifest-path src-tauri/Cargo.toml` was blocked by a Windows/Tauri permission issue during dry run
- The frontend dev surface at `http://localhost:1420` was not confirmed stable during the dry run

Workers should treat validation stabilization as real scope when it blocks milestone progress.
