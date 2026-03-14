export const FILE_WRITE_GUIDANCE = `Use write tools with minimal, reversible edits.

Rules:
- Use only \`apply_patch\` for code edits.
- Patch format must be Codex grammar: \`*** Begin Patch\` ... \`*** End Patch\`.
- Keep patches small and scoped to one file.
- After edits, run diagnostics before declaring completion.
- Do not stack more edits onto a file after a failed patch until you re-read the current file state.

Failure playbook:
- If patch parse fails: rebuild patch in strict Codex grammar.
- If patch apply fails: re-read file, regenerate patch with fresh context.
- After any write failure, avoid cascading edits; re-validate file state first.
- If the same patch-style failure repeats, stop brute-forcing and change strategy (smaller patch, fresher read, or different anchor context).`;
