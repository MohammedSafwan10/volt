# Volt Embedded DB (SQLite) — Implementation Plan

## Summary
We will add an embedded SQLite database to Volt with a sidebar DB panel for manual use first. AI access will be disabled by default and only enabled when the user explicitly toggles it in the DB panel. This keeps the UX simple, avoids accidental AI DB writes, and preserves security. The plan includes schema explorer, SQL console, result viewer, and safe AI tool exposure for later agent usage.

## Goals
- Zero-setup local DB: users can run SQL instantly.
- Clean UI: DB panel in sidebar with schema + query + results.
- Safe AI access: only when user explicitly enables it.
- Future-proof: later add remote DB connectors.

## Out of Scope (for first iteration)
- Postgres connectors
- Migration tooling or schema versioning
- Cross-project DB sharing
- Multi-user access

## Architecture Overview

### Data Layer
- Add src-tauri SQLite service for create/read/write.
- Store DB in project workspace: `/.volt/db/volt.sqlite` (workspace-scoped)
- If no workspace: store in global app data: `%APPDATA%/Volt/db/volt.sqlite`

### Frontend Layer
- New sidebar panel: Database
- Components:
  - `DbPanel.svelte` (sidebar container)
  - `DbSchemaTree.svelte` (tables + columns)
  - `DbQueryConsole.svelte` (SQL input + run)
  - `DbResultsGrid.svelte` (results + pagination)
- Toggle: Allow AI to use DB (off by default)

### AI Tool Exposure (gated)
- Add tools only when:
  - DB panel exists AND
  - user has toggled Allow AI to use DB

## Core Features (MVP)

### 1) DB Panel in Sidebar
- Sidebar tab: Database
- Sections:
  - Connection status: SQLite (Local)
  - Schema explorer: tables, columns, indexes
  - SQL console: run queries
  - Results table: show rows + row count

### 2) SQLite Runtime (Tauri backend)
Add Tauri commands:
- `db_init` → ensures DB file exists
- `db_query` → returns results
- `db_exec` → runs mutating statements (CREATE/UPDATE/DELETE)
- `db_schema` → returns table list + column info

### 3) DB Store (Frontend state)
Add store: `src/lib/stores/db.svelte.ts`
- `isReady`
- `schema`
- `lastQuery`
- `results`
- `aiEnabled`
- `initDb()`, `runQuery()`, `runExec()`, `refreshSchema()`

### 4) AI Tool Gating
Only register DB tools when:
- `dbStore.aiEnabled === true`
- Otherwise tools are hidden from system prompt + tool list.

## AI Tools to Add (When Enabled)

### Tools (Scoped)
1. `db_query`
   - read-only queries
   - result preview
2. `db_exec`
   - creates/updates data
   - only allowed if user grants explicit permission for each run

### Tool Rules
- If AI tool call is mutating → require approval (use existing approval system).
- If user hasn’t enabled AI DB access → tool not listed.

## UI/UX Details

### DB Sidebar Layout
1. Header:
   - SQLite (Local)
   - Toggle: Allow AI to use DB
2. Schema Explorer
   - Tables → expand columns
3. Query Console
   - textarea for SQL
   - Run button
4. Results Panel
   - table output
   - row count

### Toggle Behavior
- Default OFF
- When ON: show a clear banner:
  - AI can now read/write your local DB
- When OFF: all AI DB tools hidden

## Security & Safety
- DB stored locally per project
- AI tool disabled by default
- Mutating SQL requires approval
- Read-only queries do not require approval

## Tests / Validation Scenarios
1. No workspace
   - DB initializes in global app data
   - Sidebar works
2. Workspace open
   - DB saved in `.volt/db/volt.sqlite`
3. Schema Refresh
   - Create table, refresh → appears in tree
4. Query Execution
   - SELECT shows results
5. AI Toggle
   - Tools invisible when toggle OFF
   - Tools visible when toggle ON
6. Mutating SQL
   - Requires approval
   - Execution logged in tool history

## Public API / Interface Changes
- New Tauri commands:
  - `db_init`, `db_query`, `db_exec`, `db_schema`
- New store:
  - `dbStore` with `aiEnabled`

## Future Enhancements (Phase 2+)
- Postgres connector
- Migration manager
- Data import/export
- AI generate schema UI
- Row editor (CRUD)

## Assumptions / Defaults
- Default DB engine: SQLite
- AI access: OFF by default
- DB location:
  - per workspace if available
  - global app data if not
