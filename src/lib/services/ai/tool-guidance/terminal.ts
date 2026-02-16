export const TERMINAL_GUIDANCE = `Use terminal tools for execution, not exploration.

Rules:
- \`run_command\` for short, bounded commands.
- \`start_process\` + \`command_status\` for long-running tasks.
- Prefer one command at a time and inspect output before next action.
- Stop background processes when they are no longer needed.

Failure playbook:
- If command fails, read stderr/stdout fully and correct command before retry.
- Retry transient network/install failures once with backoff; otherwise switch strategy.
- If process hangs with no output, poll with \`command_status\` and stop/restart intentionally.`;
