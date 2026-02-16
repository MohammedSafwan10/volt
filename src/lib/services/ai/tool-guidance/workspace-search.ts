export const WORKSPACE_SEARCH_GUIDANCE = `Use search tools to avoid guessing paths/symbols.

Rules:
- \`find_files\` when you know filename fragments.
- \`search_symbols\` when you know function/class/type names.
- \`workspace_search\` when you know text patterns or call sites.
- Narrow broad results with specific terms or file patterns before continuing.

Failure playbook:
- If search returns too many matches: add \`includePattern\` or more specific query tokens.
- If no matches: try alternate casing/synonyms, then fallback from \`search_symbols\` to \`workspace_search\`.
- Avoid repeating the same empty search more than once.`;
