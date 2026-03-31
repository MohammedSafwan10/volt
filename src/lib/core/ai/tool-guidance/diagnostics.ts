export const DIAGNOSTICS_GUIDANCE = `Use diagnostics as the source of truth for correctness.

Rules:
- Run \`get_diagnostics\` after code edits and before final response.
- Use \`get_tool_metrics\` to debug flaky tools, retries, and latency hotspots.
- Do not claim success while unresolved diagnostics remain.
- If diagnostics are clean for touched files, stop exploring and conclude the task with the final response.

Failure playbook:
- If diagnostics tool fails transiently, retry once.
- If diagnostics are stale/empty unexpectedly, re-run after file read to confirm latest state.
- If errors persist, report exact blocking diagnostics instead of claiming done.
- If the same diagnostics repeat across iterations, stop re-running them blindly and fix the blocking file or explain the blocker explicitly.`;
