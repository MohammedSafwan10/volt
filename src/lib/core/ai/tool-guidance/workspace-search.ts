export const WORKSPACE_SEARCH_GUIDANCE = `Use search tools to avoid guessing paths/symbols.

Rules:
- \`workspace_search\` when you know text patterns, symbol names, or filename fragments.
- Narrow broad results with specific terms or file patterns before continuing.

Failure playbook:
- If search returns too many matches: add \`includePattern\` or more specific query tokens.
- If no matches: try alternate casing/synonyms and retry \`workspace_search\` once.
- Avoid repeating the same empty search more than once.`;
