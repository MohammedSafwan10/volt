# Streaming Diff (Live Preview + Final Diff) — Plan

## Summary
Implement true streaming diff for file edits by showing a lightweight “live diff preview” during writes, then swapping to the full Monaco diff once the write completes. This keeps UI smooth, avoids editor flicker, and guarantees correctness.

## Goals
- Live feedback while edits are being written
- Final diff accuracy using Monaco DiffEditor (red/green)
- Minimal flicker or editor reflow
- Works for `write_file`, `str_replace`, `append_file`, `replace_lines`

## Non‑Goals
- Replacing Monaco as the final diff authority
- Streaming diffs for binary files

## UX Behavior
- File edit cards show: `Queued → Writing → Done`
- During `Writing`, a **Live Diff Preview** block appears in the chat tool card
- After write completes, the Live Preview collapses and the user can open the **Full Diff**

## Design: Two‑Phase Diff
1. **Phase A — Live Preview**
   - Show incremental diff chunks while writing
   - No Monaco rendering (performance safe)
   - Mark as “Writing…”

2. **Phase B — Final Diff**
   - After disk write succeeds, store before/after content in meta
   - Full Diff uses Monaco DiffEditor

## Data Model (ToolCall)
Extend tool metadata for live preview:

```
meta.diffPreview = {
  status: 'queued' | 'writing' | 'done' | 'failed',
  chunks: Array<{ type: 'add' | 'del' | 'ctx', text: string }>,
  totalChunks?: number,
  lastUpdatedAt?: number
}
```

## Backend / Tool Flow
### A) write.ts (file tools)
- Capture `beforeContent`
- During write, generate incremental diff chunks
  - For `write_file` / `append_file`: chunk by line
  - For `str_replace`: chunk only changed block
- Update tool call meta during write (streaming)
- On success, set `diffPreview.status = 'done'`

### B) Assistant tool loop (AssistantPanel.svelte)
- When file edit tool is `running`, allow periodic `updateToolCallInMessage` with `diffPreview`
- Maintain write‑complete status: only mark `completed` after disk write resolves

## UI (FileEditCard)
- Show Live Preview only when `diffPreview.status === 'writing'`
- Render chunks with subtle green/red + monospace
- Collapse when status is `done`
- Keep Full Diff button for final check

## Performance Guards
- Cap diff preview size (e.g., last 200 lines)
- Debounce UI updates (e.g., every 150–250ms)
- Avoid Monaco reflows during preview

## Error Handling
- If write fails → `diffPreview.status = 'failed'`
- Show error banner + keep preview visible for context

## Acceptance Tests
1. `write_file` streams preview → finishes → Full Diff works
2. `str_replace` shows only changed block in preview
3. Large file edit doesn’t freeze UI
4. Failed write keeps preview + shows error

## Rollout Plan
- Feature flag: `settings.streamingDiffPreview` (default off)
- Enable for internal testing first
- Gradual rollout after stability

## Future Enhancements
- Inline “Apply/Reject” directly in Live Preview
- Animated “Writing…” shimmer
- Visual “Diff Timeline” with timestamps
