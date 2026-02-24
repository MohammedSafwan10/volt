# Volt Browser Workbench Migration Plan

## Summary
Migrate Volt's built-in browser from an in-editor child webview overlay to a dedicated Browser Workbench window/service. This removes z-order and overlay glitches, unlocks multi-tab browsing, and provides a stable base for advanced browser features and AI automation.

## Why This Migration
Current browser panel uses a child webview composited over IDE UI. On desktop platforms (especially Windows), native z-order behavior causes menu/dropdown clipping and interaction glitches.

A dedicated Browser Workbench window avoids DOM-over-native overlap and gives a production-grade path for:
- tabs
- richer devtools
- automation reliability
- crash isolation and recovery

## Goals
1. Eliminate browser overlay/z-index UI bugs permanently.
2. Support first-class tabbed browsing.
3. Keep AI browser tools working with minimal contract drift.
4. Improve resilience (restart/reconnect/state restore).
5. Keep IDE UX smooth while browser is active.

## Non-Goals (Phase 1)
1. Full Chrome-level devtools parity.
2. Browser extension ecosystem.
3. Cross-device sync.
4. Rewriting all existing AI tools.

## Target Architecture

### 1) Browser Workbench Window
- New dedicated Tauri window label: `browser-workbench`.
- Own Svelte route/component tree for browser UI.
- Own webview region for page content (no overlap with IDE menus).

### 2) Browser Core Service (Rust)
- Central runtime state manager for browser sessions/tabs.
- Handles create/show/hide/focus/close of browser workbench.
- Owns tab lifecycle and per-tab metadata:
  - id
  - url
  - title
  - loading state
  - canGoBack/canGoForward
  - zoom

### 3) Event + Command Contract Layer
- Typed command API (invoke) for actions.
- Event stream for updates to both windows.
- Keep current browser tool layer mapped to service calls.

### 4) State Sync + Recovery
- Persist last session snapshot:
  - open tabs
  - active tab
  - per-tab URL/title
  - UI layout prefs
- On startup/reopen, restore session safely.

### 5) AI Tool Integration
- AI browser tools should call the service contract, not UI internals.
- Tools remain provider-agnostic; only backend execution changes.

## Proposed Command Contracts

### Window lifecycle
- `browser_workbench_open()`
- `browser_workbench_focus()`
- `browser_workbench_close()`
- `browser_workbench_get_state()`

### Tab management
- `browser_tab_create({ url? })`
- `browser_tab_close({ tabId })`
- `browser_tab_activate({ tabId })`
- `browser_tab_list()`

### Navigation
- `browser_tab_navigate({ tabId, url })`
- `browser_tab_back({ tabId })`
- `browser_tab_forward({ tabId })`
- `browser_tab_reload({ tabId, hard? })`
- `browser_tab_stop({ tabId })`

### View controls
- `browser_tab_set_zoom({ tabId, level })`
- `browser_tab_zoom_in({ tabId })`
- `browser_tab_zoom_out({ tabId })`
- `browser_tab_zoom_reset({ tabId })`

### Automation + diagnostics
- Keep existing `browser_*` AI tool names initially.
- Internally route to active tab by default with optional `tabId` support.

## Proposed Event Contracts
- `browser://workbench-opened`
- `browser://workbench-closed`
- `browser://tab-created`
- `browser://tab-closed`
- `browser://tab-activated`
- `browser://tab-updated` (title/url/loading/nav flags)
- `browser://tab-crashed`
- `browser://session-restored`

## Frontend Structure

### New files (suggested)
- `src/lib/components/browser-workbench/BrowserWorkbenchWindow.svelte`
- `src/lib/components/browser-workbench/WorkbenchToolbar.svelte`
- `src/lib/components/browser-workbench/TabStrip.svelte`
- `src/lib/components/browser-workbench/WorkbenchDevtoolsDock.svelte`
- `src/lib/stores/browser-workbench.svelte.ts`

### Existing files to adapt
- `src/lib/stores/browser.svelte.ts`
- `src/lib/services/ai/tools/handlers/browser.ts`
- `src/lib/components/layout/MainLayout.svelte`
- `src/lib/components/browser/BrowserPanel.svelte` (deprecate or fallback mode)

## Migration Strategy

### Phase A: Service foundation
1. Add browser workbench window lifecycle commands in Rust.
2. Add tab model and in-memory manager.
3. Add command/event contracts.
4. Keep old BrowserPanel operational.

### Phase B: New UI window
1. Build workbench toolbar + tab strip.
2. Wire command/event store.
3. Add open/focus actions from IDE.
4. Keep old browser panel behind fallback toggle.

### Phase C: Tool routing cutover
1. Route `browser_*` tools to workbench service.
2. Preserve current tool names/contracts for compatibility.
3. Add stable error mapping for no-active-tab/no-window scenarios.

### Phase D: Reliability hardening
1. Session persistence and restore.
2. Crash detection and restart flow.
3. Telemetry and latency/error metrics.

### Phase E: Cleanup
1. Remove overlap hacks from old panel.
2. Mark old embedded panel deprecated.
3. Optionally remove legacy mode after confidence period.

## UX Rules
1. Browser workbench opens fast and focuses existing instance when already open.
2. New tab default should be configurable (Google or blank/new-tab page).
3. Closing active tab activates nearest tab.
4. If last tab closed, open one blank tab (do not kill workbench unexpectedly).
5. Keyboard shortcuts:
- `Ctrl+Shift+B`: open/focus browser workbench
- `Ctrl+T`: new browser tab (when workbench focused)
- `Ctrl+W`: close browser tab
- `Ctrl+L`: focus address bar

## Error Handling
- Deterministic error codes:
  - `BROWSER_WORKBENCH_NOT_OPEN`
  - `BROWSER_TAB_NOT_FOUND`
  - `BROWSER_NAVIGATION_FAILED`
  - `BROWSER_TAB_CRASHED`
- Include actionable remediation in each error.

## Telemetry (Minimum)
Capture:
- workbench open latency
- tab create latency
- navigation success/failure rate
- crash count
- AI browser tool success/failure per tool name

## Testing Plan

### Unit tests
1. Tab manager lifecycle (create/activate/close).
2. Session serialization/deserialization.
3. Error mapping for missing tab/window.

### Integration tests
1. IDE opens/focuses workbench.
2. Tab navigation updates propagate to store.
3. AI `browser_navigate` works with active tab routing.
4. Reopen app restores previous tab session.

### Manual QA
1. Open top menus in IDE while browser workbench is open: no clipping issues.
2. Create/close/switch 10+ tabs quickly.
3. Crash/reload scenario recovers session.
4. AI tools work after tab switch and after reopen.

## Acceptance Criteria
1. No browser dropdown clipping due to IDE overlay/z-order.
2. Multi-tab browsing works reliably.
3. Existing AI browser tools keep working (or have clear migration errors).
4. Workbench can recover from close/crash with session restore.
5. No regressions in non-browser IDE workflows.

## Risks and Mitigations
1. IPC complexity grows.
- Mitigation: strict typed payloads + versioned event schema.

2. State drift between windows.
- Mitigation: single source of truth in Rust manager; frontend stores subscribe only.

3. Cross-platform window quirks.
- Mitigation: add platform-specific QA checklist and feature flags if needed.

## Implementation Notes for Next AI
1. Start from Rust contracts first; UI should consume stable events.
2. Keep old browser panel as fallback until parity is validated.
3. Do not break existing `browser_*` tool names in first cutover.
4. Add metrics early; they are needed to know if migration is truly better.
5. Prefer deterministic behavior over visual tricks/hacks.

## Optional Future Extensions
1. Per-tab isolated profile/session containers.
2. Download manager.
3. HAR export/import.
4. Web performance timeline recording.
5. Security audit report automation for AI flows.
