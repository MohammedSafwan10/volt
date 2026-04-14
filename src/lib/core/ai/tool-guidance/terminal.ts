export const TERMINAL_GUIDANCE = `Use terminal tools for execution, not exploration.

Tool surface:
- \`run_in_terminal\` — Primary tool. Two modes:
  - mode "sync" (default): Runs command and waits for completion. Use for bounded tasks (install, build, git, test).
  - mode "async": Starts command and returns a terminal ID. Use for dev servers, watchers, or interactive commands.
- \`get_terminal_output\` — Read output from an async terminal by its ID. Shows detected URLs and waiting-for-input indicators.
- \`send_to_terminal\` — Send input to an async terminal (answer prompts, provide selections, send follow-up commands).
- \`kill_terminal\` — Terminate an async terminal session. Use after stopping servers or when done.
- \`run_command\` is an alias for \`run_in_terminal(mode="sync")\`. Prefer \`run_in_terminal\` for new usage.

Rules:
- Prefer \`workspace_search\`, \`list_dir\`, and \`read_file\` before terminal when investigating code.
- Prefer one command at a time and inspect output before next action.
- Use terminal mainly for validators, builds, installs, or commands that file tools cannot express.
- Do not prepend \`cd\`, \`Set-Location\`, or similar directory-changing shell text inside the command string; pass \`cwd\` instead.
- For dev servers, use mode "async" and \`get_terminal_output\` to check for the localhost URL.

Interactive commands:
- If a command prompts for input (Y/n, password, selection), the tool will detect it and return context.
- Use \`send_to_terminal\` with the terminal ID to answer the prompt.
- Never assume what input is needed — read the prompt context from the tool output first.

Output handling (CRITICAL):
- NEVER declare a command succeeded or failed before the tool result is fully returned.
- When reporting what a command did, QUOTE the actual output text — do not paraphrase or summarize it into your own words.
- If the output is empty or truncated, say so explicitly. Do not invent or infer output that was not returned.
- If multiple tool calls run in parallel, carefully attribute each result to the correct command. Do not merge or confuse them.
- If a command times out, do NOT claim it succeeded. Report the timeout and suggest alternatives.

Failure playbook:
- If command fails, read stderr/stdout fully and correct command before retry.
- Retry transient network/install failures once with backoff; otherwise switch strategy.
- If a command times out or gives low-signal output, prefer a narrower non-terminal tool on the next step instead of repeating the same command.`;
