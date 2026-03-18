export const FILE_WRITE_GUIDANCE = `Use write tools with minimal, reversible edits.

Rules:
- Use only \`apply_patch\` for code edits.
- Patch format must be Codex grammar: \`*** Begin Patch\` ... \`*** End Patch\`.
- Keep patches small and scoped to one file.
- After edits, run diagnostics before declaring completion.
- After a failed patch, prefer a smaller or more precise follow-up edit instead of brute force.

Failure playbook:
- If patch parse fails: rebuild patch in strict Codex grammar.
- If patch apply fails: regenerate with tighter anchors; read the file only if the current state is genuinely unclear.
- After any write failure, avoid cascading edits; re-validate file state only when needed.
- If the same patch-style failure repeats, stop brute-forcing and change strategy (smaller patch, different anchor context, or targeted refresh).`;
