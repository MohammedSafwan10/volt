export const TERMINAL_GUIDANCE = `Use terminal tools for execution, not exploration.

Rules:
- \`run_command\` for short, bounded commands.
- \`start_process\` for long-running servers or watchers; use \`get_process_output\` to inspect them afterward.
- Prefer \`workspace_search\`, \`list_dir\`, and \`read_file\` before \`run_command\` when investigating code.
- Prefer one command at a time and inspect output before next action.
- Use terminal mainly for validators, builds, installs, or commands that file tools cannot express.
- Do not prepend \`cd\`, \`Set-Location\`, or similar directory-changing shell text inside the command string; pass \`cwd\` instead.

Failure playbook:
- If command fails, read stderr/stdout fully and correct command before retry.
- Retry transient network/install failures once with backoff; otherwise switch strategy.
- If a command times out or gives low-signal output, prefer a narrower non-terminal tool on the next step instead of repeating the same command.`;
