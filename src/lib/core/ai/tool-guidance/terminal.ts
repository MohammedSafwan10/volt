export const TERMINAL_GUIDANCE = `Use terminal tools for execution, not exploration.

Rules:
- \`run_command\` for short, bounded commands.
- Prefer one command at a time and inspect output before next action.

Failure playbook:
- If command fails, read stderr/stdout fully and correct command before retry.
- Retry transient network/install failures once with backoff; otherwise switch strategy.`;
