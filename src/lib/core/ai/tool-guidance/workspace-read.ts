export const WORKSPACE_READ_GUIDANCE = `Use read tools to establish facts before edits.

Rules:
- Use \`read_file\` for exact source evidence before patching.
- Prefer focused slices: \`read_file({ path, offset, limit })\`.
- Never edit a file before at least one successful read of that file.
- After a search result, read the smallest useful slice instead of loading the whole file.

Failure playbook:
- If read returns file-not-found: use \`workspace_search\` or \`list_dir\` to locate the file, then retry.
- If output is truncated/too large: request smaller offset/limit windows.
- If read fails twice with same args: stop retrying and switch tools.
- If you keep re-reading the same slice with no new progress, expand or shift the window instead of repeating the exact call.`;
