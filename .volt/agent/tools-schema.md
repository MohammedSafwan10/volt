# Volt Agent — Tool Call Protocol (Runtime Default)

> Source of truth: `.kiro/specs/volt/tasks.md` (Phase 10). This file is a convenient runtime/default schema reference.

## Required tool-call envelope

ToolCall (JSON)
```json
{
  "requestId": "uuid-or-ulid",
  "mode": "ask|spec|agent",
  "tool": "workspace.readFile",
  "why": "One sentence why this tool is needed",
  "risk": "low|medium|high",
  "requiresApproval": true,
  "rollback": "How the user can revert (checkpoint id, git, or file restore)",
  "input": {}
}
```

ToolResult (JSON)
```json
{
  "requestId": "uuid-or-ulid",
  "ok": true,
  "durationMs": 42,
  "result": {},
  "warnings": [],
  "errors": []
}
```

Typed error shape (Required)
```json
{ "type": "PermissionDenied", "message": "...", "path": "..." }
```

## Streaming tool events (required for long operations)
- `tool://progress` with `{ requestId, message?, percent?, partialResult? }`
- `tool://done` with `{ requestId, result }`
- `tool://error` with `{ requestId, error }`

## Approval defaults
Always require approval for:
- terminal/process execution
- any network call beyond the selected AI provider
- delete/rename/move operations
- git checkout/reset/rebase
- multi-file edits where `changedFiles > 3`

## Suggested tool namespaces
- Workspace: `workspace.listDir`, `workspace.readFile`, `workspace.search`, `workspace.applyEdits`
- Editor: `editor.getActiveFile`, `editor.getSelection`, `editor.revealRange`
- Terminal: `terminal.create`, `terminal.write`, `terminal.kill`, `terminal.getOutput`
- Git: `git.status`, `git.diff`, `git.stage`, `git.commit`, `git.checkout`
