# Dart / Flutter SDK Detection Design

## Goal

Make Volt detect and use Dart/Flutter SDKs on Windows as reliably as VS Code by avoiding PATH-only assumptions, supporting explicit user configuration, validating SDK health, and surfacing detection state in the UI.

## Context

Volt currently resolves Dart by checking `where dart`, a few environment variables, and a small set of common install paths in `src/lib/core/lsp/dart-sdk.ts`. The LSP debug panel then shows a generic “Dart SDK not found” banner when detection fails. This is fragile for desktop GUI apps on Windows because the Tauri process may not inherit the same environment as an interactive terminal, even when `flutter` and `dart` work fine in the shell.

The user selected **Option C**: explicit SDK configuration, layered auto-detection, validation, and clear UX.

## Requirements

1. Volt must support an explicit user-configured Flutter SDK path and/or Dart SDK path.
2. Detection priority must be:
   1. explicit settings
   2. environment / PATH visible to the app process
   3. common install locations
   4. Dart bundled inside a discovered Flutter SDK
3. Volt must validate discovered SDKs by invoking binaries, not by existence checks alone.
4. Volt must expose the detection result, source, and failure reason in the UI.
5. Volt must provide a user-triggered re-scan / refresh flow.
6. Volt should guide the user to choose a local SDK folder when detection fails, instead of leaving only a passive warning.

## Proposed Approaches

### Approach A — Auto-detect only, improved internals

Keep SDK selection fully automatic, but make detection smarter and validation richer.

- Pros: lowest UI churn
- Cons: still fails when GUI environment differs from user expectations; no escape hatch

### Approach B — Explicit settings plus auto-detect

Add persisted SDK settings and use them before auto-detection, but keep UI changes minimal.

- Pros: reliable and relatively low risk
- Cons: weaker discoverability; users may not realize they can fix detection themselves

### Approach C — Explicit settings, validation, and visible recovery UX

Add persisted SDK settings, richer detection metadata, validation, and a visible “rescan / configure SDK” flow in Settings and the LSP debug surface.

- Pros: best reliability and best UX; matches desktop IDE expectations
- Cons: moderate implementation scope

## Recommendation

Use **Approach C**.

This gives Volt the same practical reliability pattern used by mature desktop editors: explicit paths when needed, automatic detection when possible, and clear visibility into what the app thinks is happening.

## Design

### 1. SDK resolution model

Introduce a structured detection result in `dart-sdk.ts`:

- resolved Dart executable path
- optional Flutter executable path
- Dart / Flutter versions
- resolution source:
  - `settings:flutter`
  - `settings:dart`
  - `env:path`
  - `env:flutter_root`
  - `env:dart_sdk`
  - `common-path`
  - `flutter-bundled-dart`
- validation state
- human-readable failure / warning message

This metadata must replace the current binary “found or not” model so the UI can explain what happened.

### 2. Settings model

Extend `src/lib/shared/stores/settings.svelte.ts` with:

- `flutterSdkPath: string`
- `dartSdkPath: string`

These will be optional persisted strings. They represent SDK roots, not executable files:

- Flutter setting points to the Flutter SDK root (for example `C:\src\flutter`)
- Dart setting points to the standalone Dart SDK root (for example `C:\tools\dart-sdk`)

The detection layer derives executable paths from these roots.

This is safer and more user-friendly than asking for `flutter.bat` / `dart.exe` directly.

### 3. Validation behavior

Validation must be executable-based:

- Flutter: run `flutter --version --machine` when possible; fallback to parsing plain output
- Dart: run `dart --version`
- Optional health enrichment: run `flutter doctor -v` only on explicit user action, not on every startup, because it is heavier and slower

Startup detection should stay fast. `flutter doctor -v` should power a future “Check Flutter setup” action or detailed diagnostics panel entry, not block editor startup.

### 4. Detection order

The detector should resolve in this order:

1. configured Flutter SDK root from settings
2. configured Dart SDK root from settings
3. PATH-visible `flutter` / `dart`
4. `FLUTTER_ROOT`
5. `DART_SDK`
6. known install locations
7. Dart bundled inside a discovered Flutter SDK

If a configured path exists but validation fails, Volt should report that explicitly and not silently skip to another source without telling the user. A bad explicit config is a user-fixable problem and should be visible.

### 5. UI / UX

#### Settings panel

Add a new **SDKs** or **Languages > Dart / Flutter** section with:

- Flutter SDK root input
- Dart SDK root input
- Clear buttons
- “Re-scan SDKs” button
- short help text explaining that GUI apps on Windows may not inherit terminal PATH reliably

For now, plain text inputs are acceptable if the repo does not already have a native folder picker pattern in place. A folder picker can be a follow-up if no lightweight existing pattern is available.

#### LSP debug view

Upgrade the Dart / Flutter banner to show:

- whether an SDK was detected
- which source won
- resolved executable path
- the last validation issue if any
- action hints such as “Open Settings and set Flutter SDK root”

#### Commands

Add a lightweight rescan action that:

- clears the cached SDK info
- re-runs Dart LSP initialization logic for Dart / Flutter workspaces

This can initially be wired through Settings and internal store logic; command palette exposure can be added if there is already a clean pattern for app-level commands.

## File-level changes

### `src/lib/core/lsp/dart-sdk.ts`

- expand `DartSdkInfo`
- add resolution source metadata
- split root-to-executable derivation helpers from detection helpers
- validate configured SDK roots
- keep cache invalidation explicit

### `src/lib/core/lsp/dart-sidecar.ts`

- preserve and expose richer startup issues
- use richer detection result in `getDartLspStatus()`
- add a rescan/reinitialize path

### `src/lib/shared/stores/settings.svelte.ts`

- add persisted `flutterSdkPath` and `dartSdkPath`
- add setters and reset behavior

### `src/lib/shared/components/sidebar/SettingsPanel.svelte`

- add SDK settings UI
- add rescan action

### `src/lib/shared/components/panel/LspDebugView.svelte`

- show source, path, and explicit failure reason
- show actionable recovery guidance

## Error handling

Volt should distinguish these cases:

1. **No SDK found anywhere**
   - show install/configure guidance
2. **Configured SDK path missing**
   - say the configured folder does not exist
3. **Configured SDK path found but invalid**
   - say validation failed and include the failing executable path if available
4. **Auto-detected SDK found but validation failed**
   - say which source produced the invalid candidate

These messages should be short and user-facing, while console logs can remain more verbose.

## Testing

Add or extend unit tests around detection logic:

- prefers explicit Flutter setting over PATH
- prefers explicit Dart setting when Flutter setting is absent
- derives bundled Dart from configured Flutter root
- reports invalid configured SDK distinctly
- falls back through detection order correctly
- preserves source metadata in returned `DartSdkInfo`

Also run the existing frontend validation command(s) after changes.

## Out of Scope

- bundling Flutter or Dart with Volt
- automatic SDK installation
- full `flutter doctor` UI integration
- device management / Flutter daemon enhancements

## Approval

This design implements the approved Option C with explicit settings, validated detection, and visible recovery UX, while keeping startup lightweight by reserving `flutter doctor -v` for manual diagnostics instead of every launch.
