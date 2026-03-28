# Architecture

Architectural decisions, migration targets, and runtime ownership notes.

**What belongs here:** current-vs-target architecture, subsystem ownership, migration priorities, important structural constraints.

---

## Current architectural shape

- Volt is a Tauri desktop IDE with a SvelteKit/TypeScript frontend and Rust backend
- Rust already owns major OS/process-heavy domains:
  - filesystem ops / watch / indexing
  - workspace search
  - semantic index
  - terminal PTY lifecycle
  - git execution
  - LSP process lifecycle
  - MCP server lifecycle
  - AI key storage / provider proxying
  - chat persistence
- Frontend still owns too much runtime orchestration in:
  - `src/lib/core/services/file-service.ts`
  - `src/lib/shared/stores/project.svelte.ts`
  - `src/lib/core/services/project-diagnostics.ts`
  - `src/lib/features/assistant/runtime/*`
  - `src/lib/core/ai/tools/router.ts`
  - parts of LSP/MCP/terminal/git/search coordination

## Target architecture for this mission

Rust should own the runtime/control plane:
- document/file authority
- workspace lifecycle supervision
- diagnostics scheduling
- agent runtime orchestration
- LSP broker behavior above raw transport
- MCP runtime policy and lifecycle

Svelte/TypeScript should remain responsible for:
- layout and shell UI
- Monaco/xterm/editor widget integration
- assistant/chat presentation
- panel state and interaction flow
- thin adapters over native runtime services

Volt is desktop-first. The frontend dev server exists to support the Tauri desktop shell, not as a deployable web product target for this mission.

## Mission-specific structural rules

- Browser/CDP functionality is to be removed, not preserved or rebuilt
- Avoid leaving long-term dual ownership where Rust and TypeScript are both sources of truth for the same runtime state
- Prefer backend-first migrations:
  1. add native service/manager
  2. move adapters to that native surface
  3. remove duplicated frontend runtime logic

## High-value user-visible contracts to protect

- workspace open/switch/close behavior
- editor/file correctness
- assistant approvals/tool execution/history
- terminal and git behavior
- search and Problems behavior
- MCP panel and assistant-visible MCP inventory
