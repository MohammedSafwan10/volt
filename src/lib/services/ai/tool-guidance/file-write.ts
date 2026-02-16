export const FILE_WRITE_GUIDANCE = `Use write tools with minimal, reversible edits.

Rules:
- Prefer \`str_replace\` for small exact changes.
- Prefer \`multi_replace\` for multiple edits in one file.
- Use \`replace_lines\` when exact-match replacement is unstable.
- Use \`write_file\` mainly for new files or complete rewrites.
- After edits, run diagnostics before declaring completion.

Failure playbook:
- If \`str_replace\` fails exact match: re-read file and retry once with exact current text.
- If second attempt fails: switch to \`replace_lines\` with verified line numbers.
- After any write failure, avoid cascading edits; re-validate file state first.`;
