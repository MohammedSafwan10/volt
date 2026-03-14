export const WORKSPACE_SEARCH_GUIDANCE = `Use search tools to avoid guessing paths/symbols.

Rules:
- \`workspace_search\` when you know text patterns, symbol names, or filename fragments.
- Prefer \`workspace_search\` before \`run_command\` for codebase exploration.
- Narrow broad results with specific terms or file patterns before continuing.
- After finding candidate paths, switch to \`read_file\` for exact evidence.

Failure playbook:
- If search returns too many matches: add \`includePattern\` or more specific query tokens.
- If no matches: try alternate casing/synonyms and retry \`workspace_search\` once.
- Avoid repeating the same empty search more than once.
- If the same search keeps failing, change tactic: use \`list_dir\` to inspect the folder layout or search for a related symbol/file fragment instead.`;
