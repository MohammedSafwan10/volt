export const WORKSPACE_READ_GUIDANCE = `Use read tools to establish facts before edits.

Rules:
- Prefer \`file_outline\` first on large or unknown files.
- Use \`read_code\` for symbols/functions/classes.
- Use \`read_file\` when exact raw text/line context is needed.
- Use \`read_files\` only for truly parallel reads.
- Never edit a file before at least one successful read of that file.

Failure playbook:
- If read returns file-not-found: call \`find_files\` with filename fragment, then retry with exact path.
- If output is truncated/too large: use \`file_outline\` first, then targeted \`read_file\` line ranges.
- If read fails twice with same args: stop retrying and switch tools.`;
