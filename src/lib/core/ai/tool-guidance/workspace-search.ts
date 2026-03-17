export const WORKSPACE_SEARCH_GUIDANCE = `Use search tools to avoid guessing paths and symbols.

Rules:
- Use workspace_search when you know text patterns or exact code snippets. It is literal by default.
- Prefer workspace_search before run_command for codebase exploration.
- Use find_files when you mainly know the filename or path fragment.
- Use regex only when you explicitly need pattern matching, by setting isRegex to true.
- Set includeHidden to true only when you intentionally need hidden/build paths such as .git or .next.
- Narrow broad results with specific terms or file patterns before continuing.
- After finding candidate paths, switch to read_file for exact evidence.

Failure playbook:
- If search returns too many matches: add includePattern or more specific query tokens.
- If no matches on a literal case-sensitive search, you may retry workspace_search once with caseSensitive set to false.
- Do not remove or broaden includePattern automatically; preserve the requested scope exactly.
- If the query contains characters like {, (, or [, keep it in literal mode unless you intentionally want regex.
- Avoid repeating the same empty search more than once.
- If the same scoped search still fails, change tactic explicitly: use find_files, list_dir, or file_outline rather than relying on hidden fallback behavior.`;
