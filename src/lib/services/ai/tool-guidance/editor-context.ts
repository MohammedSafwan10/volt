export const EDITOR_CONTEXT_GUIDANCE = `Use editor-context tools to align with user focus.

Rules:
- Check \`get_active_file\` when user says "this file" or "here".
- Check \`get_selection\` when user references selected code.
- Use \`get_open_files\` to infer nearby dependencies and workflow context.

Failure playbook:
- If active file/selection is empty, do not guess; use \`find_files\` or ask for the target path.
- If context conflicts with user request, prioritize explicit user path and verify with read tools.`;
