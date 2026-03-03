export const DIAGNOSTICS_GUIDANCE = `Use diagnostics as the source of truth for correctness.

Rules:
- Run \`get_diagnostics\` after code edits and before final response.
- Use \`get_tool_metrics\` to debug flaky tools, retries, and latency hotspots.
- Do not claim success while unresolved diagnostics remain.

Failure playbook:
- If diagnostics tool fails transiently, retry once.
- If diagnostics are stale/empty unexpectedly, re-run after file read to confirm latest state.
- If errors persist, report exact blocking diagnostics instead of claiming done.`;
