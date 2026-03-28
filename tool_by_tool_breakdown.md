# ⚡ Every Volt Tool — Keep or Remove? (with Antigravity Comparison)

> **Goal:** Each tool must do ONE distinct thing. No two tools should overlap.
> **Antigravity has ~12 tools and is rock solid. Here's how each Volt tool compares.**

---

## 📖 READING TOOLS

### 1. [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) → ✅ KEEP
| | |
|---|---|
| **What it does** | Lists files/folders in a directory (one level deep) |
| **Antigravity equivalent** | [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) — identical concept |
| **Why keep** | Fundamental. Every AI agent needs directory listing. Simple, fast, reliable. |
| **Is it distinct?** | Yes — nothing else lists directory contents |

### 2. [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) → ✅ KEEP
| | |
|---|---|
| **What it does** | Reads file content with optional offset/limit for slicing |
| **Antigravity equivalent** | `view_file` — same thing (with StartLine/EndLine) |
| **Why keep** | The ONE file reader. Essential for code understanding, pre-edit verification. |
| **Is it distinct?** | Yes — the only way to see file contents |

### 3. `read_files` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Reads multiple files at once (batch version of read_file) |
| **Antigravity equivalent** | ❌ None — Antigravity just calls `view_file` multiple times in parallel |
| **Why remove** | **It's just a loop over [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267).** The AI can call [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) 3 times in parallel itself. Having both [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) AND `read_files` makes the AI waste tokens deciding: "should I use read_file or read_files?" Antigravity proves parallel single-file calls work perfectly. |
| **What replaces it** | [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) called multiple times |

### 4. `get_file_tree` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Gets recursive directory tree (with depth control) |
| **Antigravity equivalent** | ❌ None — Antigravity uses [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) repeatedly, or `find_by_name` |
| **Why remove** | **Overlaps with [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296).** The AI can call [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) on "src", then [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) on "src/lib", etc. The tree view sounds useful but adds ~15 lines to definitions.ts for something [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) already handles. Antigravity's [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) has no depth control either — just one level — and works fine. |
| **What replaces it** | [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) (called at different paths) |

### 5. `read_code` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Reads file with structure analysis (shows functions, classes, exports) AND can read specific symbols by name |
| **Antigravity equivalent** | ❌ None |
| **Why remove** | **Overlaps with [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) + `file_outline`.** This tool tries to be both a file reader AND a structure analyzer. The AI gets confused: "Should I use [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) or `read_code`?" This exact confusion is why Antigravity has ONE reader tool. The `file_outline` tool does the structure part better (100x cheaper), and [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) does the reading part. Having three readers (read_file, read_code, read_files) is the #1 cause of wasted tool calls. |
| **What replaces it** | `file_outline` (for structure) + [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) (for content) |

### 6. `file_outline` → ✅ KEEP
| | |
|---|---|
| **What it does** | Shows file structure (functions, classes, types with line ranges) WITHOUT loading content. ~100x cheaper in tokens. |
| **Antigravity equivalent** | ❌ None — Antigravity doesn't have this, but it SHOULD |
| **Why keep** | **Unique capability.** No overlap with anything else. When the AI needs to understand a file's layout before deciding which section to read, this saves massive tokens vs reading the whole file. This is something Volt does BETTER than Antigravity. |
| **Is it distinct?** | Yes — structure-only view that nothing else provides |

---

## 🔍 SEARCH TOOLS

### 7. [workspace_search](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1447-1633) → ✅ KEEP
| | |
|---|---|
| **What it does** | Text/regex search across the codebase |
| **Antigravity equivalent** | `grep_search` — same thing |
| **Why keep** | The ONE text search tool. Essential. Every AI needs this. |
| **Is it distinct?** | Yes — the only way to search file CONTENTS |

### 8. [find_files](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1030-1076) → ✅ KEEP
| | |
|---|---|
| **What it does** | Find files by name with fuzzy matching |
| **Antigravity equivalent** | `find_by_name` — same thing |
| **Why keep** | **Different from [workspace_search](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1447-1633).** Search by name ≠ search by content. When the AI thinks "I need to find [config.ts](file:///c:/tauri/volt/vitest.config.ts)", [find_files](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1030-1076) is the right tool. If it thinks "where is `DATABASE_URL` used?", [workspace_search](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1447-1633) is the right tool. Two distinct jobs. |
| **Is it distinct?** | Yes — file name search vs file content search |

### 9. `search_symbols` → ✅ KEEP
| | |
|---|---|
| **What it does** | LSP-powered search for functions, classes, variables, types |
| **Antigravity equivalent** | ❌ None |
| **Why keep** | **Unique LSP capability.** The AI can ask "find all classes named User*" and get results from the language server, not just text matching. This finds things that [workspace_search](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1447-1633) would miss (e.g., re-exported symbols, type aliases). Volt exclusive advantage. |
| **Is it distinct?** | Yes — semantic search vs text search |

---

## ✏️ FILE WRITE TOOLS

### 10. [write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) → ✅ KEEP
| | |
|---|---|
| **What it does** | Creates a new file or overwrites an existing file entirely |
| **Antigravity equivalent** | `write_to_file` — same thing |
| **Why keep** | **`apply_patch` can't create files from scratch.** When the AI needs to create `src/new-component.ts`, this is the only way. Essential for project scaffolding. |
| **Is it distinct?** | Yes — file creation (nothing else can create new files) |

### 11. `str_replace` → ✅ KEEP
| | |
|---|---|
| **What it does** | Find exact text in a file and replace it |
| **Antigravity equivalent** | `replace_file_content` — same concept |
| **Why keep** | **Simpler than `apply_patch` for small edits.** When the AI wants to change one line, `str_replace` is easier than constructing a full patch. Most AI models are more reliable with find-and-replace than diff format. This mirrors Antigravity's `replace_file_content`. |
| **Is it distinct?** | Yes — targeted single-edit (vs `apply_patch` for multi-hunk) |

### 12. `apply_patch` → ✅ KEEP
| | |
|---|---|
| **What it does** | Applies a Codex-style patch (unified diff) to a file |
| **Antigravity equivalent** | `multi_replace_file_content` — similar (multi-edit in one call) |
| **Why keep** | **The primary edit tool for large/complex changes.** Can handle multiple hunks in one call. Strict canonical tool. |
| **Is it distinct?** | Yes — multi-hunk atomic edit (vs `str_replace` for single edit) |

### 13. `append_file` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Appends text to the end of a file |
| **Antigravity equivalent** | ❌ None — Antigravity has no append tool |
| **Why remove** | **`str_replace` can do this** by matching the last line and adding content after it. Or [write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) can rewrite the whole file. `append_file` is a convenience shortcut that adds tool choice noise. Antigravity doesn't have "append" and works fine. |
| **What replaces it** | `str_replace` or [write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) |

### 14. `replace_lines` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Replaces lines N through M with new content |
| **Antigravity equivalent** | ❌ None — Antigravity uses `replace_file_content` with exact text match |
| **Why remove** | **Line numbers shift after edits → fragile.** If the AI reads line 50, then edits earlier in the file, line 50 is now wrong. `str_replace` with exact text match is MORE reliable because it doesn't depend on line numbers. This is why Antigravity uses text-based replacement, not line-based. |
| **What replaces it** | `str_replace` or `apply_patch` |

### 15. `multi_replace` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Multiple str_replace operations in one call |
| **Antigravity equivalent** | `multi_replace_file_content` — similar |
| **Why remove** | **`apply_patch` already handles this.** A patch can have multiple hunks. Having both `multi_replace` AND `apply_patch` AND `str_replace` means three tools that edit files, and the AI wastes tokens choosing between them. Antigravity has `replace_file_content` (single) and `multi_replace_file_content` (multiple) — just TWO, not three. We keep `str_replace` (single) and `apply_patch` (multiple). Done. |
| **What replaces it** | `apply_patch` (multi-hunk patches) |

### 16. [create_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#415-434) → ✅ KEEP
| | |
|---|---|
| **What it does** | Creates a directory |
| **Antigravity equivalent** | ❌ None (Antigravity's `write_to_file` auto-creates parent dirs) |
| **Why keep** | **Simple, no-approval needed, no shell required.** While `run_command mkdir -p` works, it requires approval. [create_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#415-434) doesn't. Quick and safe. |
| **Is it distinct?** | Yes — directory creation without shell access |

### 17. [delete_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#772-786) → ✅ KEEP
| | |
|---|---|
| **What it does** | Deletes a file or directory (requires approval) |
| **Antigravity equivalent** | ❌ None (Antigravity uses [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) with rm/del) |
| **Why keep** | **Destructive action needs dedicated tool with approval gate.** When the AI needs to remove dead code files during refactoring, this is the safe way. The approval requirement is the safety net. |
| **Is it distinct?** | Yes — the only safe deletion mechanism |

### 18. [rename_path](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#587-676) → ❌ REMOVE
| | |
|---|---|
| **What it does** | Renames or moves a file/directory |
| **Antigravity equivalent** | ❌ None |
| **Why remove** | **[run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) with `mv`/[ren](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#587-676) does this.** The AI knows how to rename files via shell commands. Having a dedicated tool for something the AI already knows how to do via [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) just adds noise. Antigravity doesn't have a rename tool either. |
| **What replaces it** | [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) (e.g., `mv old.ts new.ts`) |

### 19. `format_file` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Formats a file using Prettier |
| **Antigravity equivalent** | ❌ None |
| **Why remove** | **Should be automatic, not a tool call.** Every [write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) or `str_replace` should auto-format on save (if Prettier is configured). Making the AI explicitly call `format_file` wastes a tool call turn. Antigravity doesn't format — it trusts the IDE's format-on-save. |
| **What replaces it** | Auto-format in post-edit hook |

---

## 🖥️ TERMINAL TOOLS

### 20. [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) → ✅ KEEP
| | |
|---|---|
| **What it does** | Executes a shell command and waits for completion |
| **Antigravity equivalent** | [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) — identical |
| **Why keep** | Essential. Install packages, run git, run build commands. Every AI agent needs this. |
| **Is it distinct?** | Yes — short-running shell commands |

### 21. `start_process` → ✅ KEEP
| | |
|---|---|
| **What it does** | Starts a long-running background process (dev servers, watchers) |
| **Antigravity equivalent** | Part of [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) (Antigravity's run_command handles both via `WaitMsBeforeAsync`) |
| **Why keep** | **Distinct from [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189).** [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) waits for exit. `start_process` detaches immediately. The AI needs to know the difference: "npm install" → [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189), "npm run dev" → `start_process`. In Antigravity this is one tool with a param, but separating them is clearer for the AI. |
| **Is it distinct?** | Yes — background process launch vs synchronous execution |

### 22. `get_process_output` → ✅ KEEP
| | |
|---|---|
| **What it does** | Reads output from a background process started by `start_process` |
| **Antigravity equivalent** | `command_status` — same concept |
| **Why keep** | **Must-have companion to `start_process`.** Without this, the AI can't check if the dev server started or see compilation errors. |
| **Is it distinct?** | Yes — the only way to read background process output |

### 23. `stop_process` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Stops a background process by PID |
| **Antigravity equivalent** | `send_command_input` with `Terminate: true` |
| **Why remove** | **[run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) with [kill](file:///c:/tauri/volt/src-tauri/src/domains/terminal/commands.rs#499-567)/`taskkill` does this.** Or the AI just doesn't need to stop processes often — when the task is done, processes can keep running. Antigravity doesn't have a dedicated stop tool; it uses `send_command_input` with `Terminate: true`. Rare use case. |
| **What replaces it** | [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) (`taskkill /PID ...` or `kill PID`) |

### 24. `list_processes` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Lists all background processes and their PIDs |
| **Antigravity equivalent** | ❌ None |
| **Why remove** | **The AI already knows what it started.** It called `start_process` and got a PID back. It doesn't need a separate tool to list what it already knows. Antigravity doesn't have this — the agent tracks its own state. |
| **What replaces it** | Agent memory (the AI remembers PIDs from `start_process` responses) |

### 25. `command_status` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Poll background process for status + new output (with optional wait) |
| **Antigravity equivalent** | `command_status` — Antigravity also has this, BUT as its ONLY output reader |
| **Why remove** | **Overlaps with `get_process_output`.** Having both means the AI must choose: "Do I use `get_process_output` or `command_status`?" They do almost the same thing. The `wait` feature from `command_status` should be merged INTO `get_process_output` as a param. |
| **What replaces it** | `get_process_output` (add `wait` param if needed) |

### 26. `read_terminal` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Read recent output from the "AI terminal session" |
| **Antigravity equivalent** | `read_terminal` — similar |
| **Why remove** | **Overlaps with `get_process_output`.** This reads from "the AI's terminal" which is confusing — which terminal? The one from [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189)? `start_process`? Having three tools that all read terminal output (`get_process_output`, `command_status`, `read_terminal`) is the worst kind of overlap. |
| **What replaces it** | `get_process_output` |

### 27. `send_terminal_input` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Sends text input to an interactive terminal process |
| **Antigravity equivalent** | `send_command_input` — same thing |
| **Why remove** | **Interactive prompts should be avoided, not handled.** The AI should use `--yes`, `-y`, `--non-interactive` flags. If a command MUST be interactive, the user can handle it. In practice this tool is fragile — timing issues, wrong process, etc. Antigravity has this but it's rarely needed. |
| **What replaces it** | Non-interactive flags on commands (`--yes`, `-y`) |

---

## 🔍 DIAGNOSTICS

### 28. `get_diagnostics` → ✅ KEEP
| | |
|---|---|
| **What it does** | Gets compiler/LSP errors and warnings for files |
| **Antigravity equivalent** | ❌ None (Antigravity gets lint errors injected into conversation context automatically) |
| **Why keep** | **Essential for correctness.** After every edit, the AI should check diagnostics. This is the "did I break anything?" tool. Source of truth for code correctness. |
| **Is it distinct?** | Yes — the only way to get compiler feedback |

### 29. `attempt_completion` → ✅ KEEP
| | |
|---|---|
| **What it does** | Signals "I'm done" with a result summary |
| **Antigravity equivalent** | ❌ None (Antigravity just responds naturally) |
| **Why keep** | **Task lifecycle management.** Tells the UI to transition from "working" to "done" state. Shows summary to user. |
| **Is it distinct?** | Yes — the only completion signal |

### 30. `get_tool_metrics` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Shows tool latency/error stats dashboard |
| **Antigravity equivalent** | ❌ None |
| **Why remove** | **Debug tool, not for the AI agent.** The AI shouldn't be monitoring its own tool metrics during a coding task. This is for developers debugging the agent itself. Move to internal dashboard. |
| **What replaces it** | Internal dev dashboard (not an AI tool) |

### 31. [get_file_info](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#677-729) → ❌ REMOVE
| | |
|---|---|
| **What it does** | Gets file metadata (exists, type, size, modified time) |
| **Antigravity equivalent** | ❌ None (Antigravity's [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) shows size/type, or uses `view_file` to check existence) |
| **Why remove** | **[list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) already shows this info.** Or the AI can call [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) — if it fails, the file doesn't exist. Having a dedicated metadata tool adds noise. |
| **What replaces it** | [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) (shows size, type) or [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) (implicit existence check) |

---

## 👁️ EDITOR CONTEXT TOOLS

### 32. `get_active_file` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Gets the file path that's currently open in the editor |
| **Antigravity equivalent** | ❌ None — this info is injected via system context |
| **Why remove** | **This info is already in the system prompt.** Look at `<ADDITIONAL_METADATA>` in every message — it says `Active Document: c:\tauri\volt\src\...`. The AI already knows. Calling a tool to get info that's free in the prompt wastes a turn. |
| **What replaces it** | System prompt metadata (already there) |

### 33. `get_selection` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Gets the text the user has selected in the editor |
| **Antigravity equivalent** | ❌ None — selection is injected via system context |
| **Why remove** | **Same as above.** When the user selects text and asks a question, the selected text is already in the message context. No tool call needed. |
| **What replaces it** | System prompt metadata |

### 34. `get_open_files` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Lists all open tabs in the editor |
| **Antigravity equivalent** | ❌ None |
| **Why remove** | **Marginal value.** The AI rarely needs to know which tabs are open. If it needs to know about a file, it can [find_files](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1030-1076) or [workspace_search](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1447-1633). Knowing that "utils.ts is open in a tab" doesn't help the AI code better. |
| **What replaces it** | Not needed |

---

## 📝 OTHER TOOLS

### 35. `write_plan_file` → ❌ REMOVE
| | |
|---|---|
| **What it does** | Writes a markdown plan to `.volt/plans/` directory |
| **Antigravity equivalent** | ❌ None (Antigravity writes artifacts with `write_to_file`) |
| **Why remove** | **[write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) does this.** [write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) with `path: ".volt/plans/refactor.md"` is identical. Having a separate tool for one specific directory is over-engineering. |
| **What replaces it** | [write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) |

---

## 🌐 BROWSER TOOLS (14 tools — already gated off, keep for now)

These are already behind `VOLT_BROWSER_TOOLS_ENABLED = false` so they're NOT being sent to the AI unless explicitly enabled. Not blocking — we can slim these down separately later.

| Tool | Antigravity Equiv. | Status |
|------|-------------------|--------|
| `browser_get_console_logs` | Part of `browser_subagent` | Keep when enabled |
| `browser_get_errors` | Part of `browser_subagent` | Merge into console_logs |
| [browser_get_network_requests](file:///c:/tauri/volt/src-tauri/src/domains/browser/commands.rs#1466-1478) | Part of `browser_subagent` | Keep when enabled |
| `browser_get_network_request_details` | Part of `browser_subagent` | Merge into network_requests |
| `browser_get_performance` | Part of `browser_subagent` | Niche — remove |
| `browser_get_selected_element` | Part of `browser_subagent` | Niche — remove |
| `browser_get_summary` | Part of `browser_subagent` | Merge into console_logs |
| `browser_get_application_storage` | Part of `browser_subagent` | Niche — remove |
| `browser_get_security_report` | Part of `browser_subagent` | Niche — remove |
| `browser_propose/preview/execute_action` | Part of `browser_subagent` | Over-engineered — remove |
| [browser_navigate](file:///c:/tauri/volt/src-tauri/src/domains/browser/commands.rs#559-608) | Part of `browser_subagent` | Keep when enabled |
| `browser_click` | Part of `browser_subagent` | Keep when enabled |
| `browser_type` | Part of `browser_subagent` | Keep when enabled |
| `browser_get_element(s)` | Part of `browser_subagent` | Keep one, merge |
| `browser_evaluate` | Part of `browser_subagent` | Keep when enabled |
| `browser_scroll` | Part of `browser_subagent` | Keep when enabled |
| `browser_wait_for` | Part of `browser_subagent` | Keep when enabled |
| [browser_screenshot](file:///c:/tauri/volt/src-tauri/src/domains/browser/commands.rs#1197-1202) | Part of `browser_subagent` | Keep when enabled |

---

## 📊 Final Summary

### KEEP: 15 tools (each does ONE unique thing)

| # | Tool | One-line purpose | Antigravity equivalent |
|---|------|-----------------|----------------------|
| 1 | [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) | List directory contents | [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) |
| 2 | [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) | Read file contents | `view_file` |
| 3 | `file_outline` | File structure (no content) | ❌ Volt exclusive |
| 4 | [workspace_search](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1447-1633) | Search text in files | `grep_search` |
| 5 | [find_files](file:///c:/tauri/volt/src-tauri/src/domains/search/commands.rs#1030-1076) | Find files by name | `find_by_name` |
| 6 | `search_symbols` | LSP symbol search | ❌ Volt exclusive |
| 7 | [write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) | Create/overwrite file | `write_to_file` |
| 8 | `str_replace` | Replace exact text | `replace_file_content` |
| 9 | `apply_patch` | Multi-hunk edit | `multi_replace_file_content` |
| 10 | [create_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#415-434) | Create directory | ❌ (auto-created by write_to_file) |
| 11 | [delete_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#772-786) | Delete with approval | [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) |
| 12 | [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) | Execute shell command | [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) |
| 13 | `start_process` | Start background process | [run_command](file:///c:/tauri/volt/src-tauri/src/domains/system/commands.rs#149-189) (async mode) |
| 14 | `get_process_output` | Read process output | `command_status` |
| 15 | `get_diagnostics` | Compiler errors | Auto-injected |
| 16 | `attempt_completion` | Signal task done | Natural response |

### REMOVE: 19 tools

| Tool | Reason (one line) |
|------|------------------|
| `read_files` | Just [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) in a loop |
| `get_file_tree` | [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) is enough |
| `read_code` | [read_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#233-267) + `file_outline` = same thing |
| `append_file` | `str_replace` can append |
| `replace_lines` | Line numbers shift → fragile |
| `multi_replace` | `apply_patch` handles multi-edit |
| [rename_path](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#587-676) | `run_command mv/ren` |
| `format_file` | Should be automatic |
| `stop_process` | `run_command kill` |
| `list_processes` | Agent remembers PIDs |
| `command_status` | Overlaps `get_process_output` |
| `read_terminal` | Overlaps `get_process_output` |
| `send_terminal_input` | Use `--yes` flags instead |
| `get_active_file` | System prompt has this |
| `get_selection` | System prompt has this |
| `get_open_files` | Not useful |
| `get_tool_metrics` | Dev-only debug tool |
| [get_file_info](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#677-729) | [list_dir](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#291-296) shows this |
| `write_plan_file` | [write_file](file:///c:/tauri/volt/src-tauri/src/domains/file_system/commands.rs#268-290) to any path |
