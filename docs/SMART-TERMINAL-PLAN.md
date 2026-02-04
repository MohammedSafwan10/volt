# Smart Terminal Behavior — Plan & UX Spec

## Summary
Make Volt’s terminal “smart” with shell integration and reliable command lifecycle detection. The system should know when commands start/end, detect long-running processes, and avoid asking the user unless needed. Closing a terminal tab must kill its process. On IDE exit, all terminals are terminated cleanly.

## Goals
- Reliable command completion detection (no guessing)
- Clear running vs finished state in UI
- Zero zombie processes
- Minimal user prompts (only when ambiguous)

## Core Behaviors

### 1) IDE Exit
- Kill ALL terminal sessions and their processes.
- Clear terminal session list.

### 2) Long‑Running Commands
Examples: `npm run dev`, `flutter run`, `cargo watch`, `vite dev`
- Detect as long‑running (no “done” event).
- Mark terminal as Running.
- AI should reuse the running session automatically unless user explicitly asks for a new server.

### 3) Smart Reuse Logic (no constant asking)
- If a dev server is already running in an AI terminal:
  - Reuse it automatically.
  - Only ask if the user specifically asks for a new instance or port.
- If user runs a different command (tests/build):
  - Use a new terminal tab automatically.
- Explicit ambiguity rules:
  - Same command + same port (or no port) → reuse silently.
  - Different command type (dev vs test/build) → new tab.
  - User says “new server” or “different port” → new tab.

### 4) Terminal Tab Close
- Closing a terminal tab must **kill the process**.
- No orphaned background processes.

### 5) Multi‑Terminal Tabs
- Support multiple terminal sessions with labels.
- AI can select a specific session (dev/test/build).
- Tabs can be renamed by user or AI.

## UI/UX
- Status badges: Running / Done (exit 0) / Failed (exit code)
- For errors: show exit code + last 10 lines
- For long‑running: show “Live” badge + Stop button
- Terminal list shows active process name (if detected)
- Realtime stream in tool row:
  - Ensure terminal output updates in the chat/tool UI without delay.
  - Show “Running…” immediately on command start.

## Technical Plan

### A) Shell Integration (OSC 633)
- Inject startup script for PowerShell/Bash/Zsh.
- Emit structured events:
  - command started
  - command ended (exit code)
  - cwd updates

### B) Smart Command Runner
- Every command run = unique command ID
- UI waits for completion event
- If no completion event, mark as long‑running

### C) Process Management
- Each terminal session tracks:
  - active command
  - exit code
  - last output lines
- On close or IDE exit → force kill process tree (parent + children)

### D) Terminal Backend (recommended)
- Use PTY + xterm.js (or equivalent) with OSC 633 support.
- Windows: ConPTY backend for accurate exit status + events.

## Edge Cases
- Command fails immediately → exit event should fire and show error
- Multiple commands in same terminal → only track latest
- Command uses interactive prompt → display “waiting for input”

## Acceptance Tests
1. Run `npm run dev` → status = Running (no Done)
2. Run `npm install` → status = Done (exit 0)
3. Close terminal tab while dev server running → process killed
4. Exit IDE → no leftover processes
5. AI runs test while dev server running → new terminal created automatically

## Later Enhancements
- “Detach” option (keep running in background)
- Auto‑assign tab labels based on command
- Terminal history per session
