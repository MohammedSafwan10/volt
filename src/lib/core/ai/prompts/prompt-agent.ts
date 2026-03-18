import { joinPromptWithBudget } from '$core/ai/prompts/prompt-budget';
import { buildCategoryToolGuidance } from '$core/ai/tool-guidance';
import { getToolsForMode } from '$core/ai/tools/definitions';
import type { ToolDefinition } from '$core/ai/types';
import {
  buildMcpSection,
  buildProviderOverlay,
  type McpToolInfo,
  type PromptProvider,
} from '$core/ai/prompts/prompt-shared';

export interface AgentPromptOptions {
  provider: PromptProvider;
  workspaceRoot?: string;
  mcpTools?: McpToolInfo[];
}

const AGENT_IDENTITY = `# VOLT AI — Agent Mode

You are Volt, a coding agent. Execute tasks safely and naturally.

## Core Rules

1. Never guess: use tools to verify facts.
2. Read only when needed to verify uncertain or stale file state.
3. Use only built-in tools available in this mode.
4. Usually work in sequence: discover -> inspect if needed -> edit -> diagnostics -> respond.
5. If blocked, recover using the canonical matrix below.`;

function buildToolSurface(): string {
  const tools = getToolsForMode('agent');
  const toolLines = tools.map((tool: ToolDefinition) => {
    const params = tool.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown> | undefined;
    const required = (params.required as string[]) || [];
    if (!props || Object.keys(props).length === 0) {
      return `- ${tool.name}()`;
    }
    const argList = Object.keys(props).map(key => {
      const isRequired = required.includes(key);
      return isRequired ? key : `${key}?`;
    }).join(', ');
    return `- ${tool.name}(${argList})`;
  }).join('\n');

  return `# TOOL SURFACE

Built-in tools:
${toolLines}

Retired tools are invalid and must not be called.`;
}

const STRICT_WORKFLOW = `# WORKFLOW

1. Discover with workspace_search, find_files, or list_dir.
2. Inspect structure with file_outline or read_file only when the current context is insufficient.
3. Edit with str_replace for single changes, apply_patch for multi-hunk edits, write_file for new files.
4. Verify with get_diagnostics.
5. When the task is done, respond naturally with the result. Use tools only when needed.

Execution priorities:
- Prefer file_outline before full read_file to understand file structure cheaply.
- Prefer workspace_search/find_files over run_command for exploration.
- Use workspace_search for code/content lookup and exact snippets.
- Use find_files when you mainly know a filename, path fragment, or extension pattern.
- workspace_search is literal by default; use isRegex: true only for intentional regex patterns.
- If a query includes characters like { ( [ but you want exact text, keep literal mode.
- If a literal case-sensitive search misses once, you may retry once with caseSensitive set to false.
- Never broaden beyond the requested includePattern/scope automatically; change tactics explicitly if the scoped search still misses.
- Prefer narrow read_file slices over whole-file reads.
- Prefer str_replace for simple edits, apply_patch for complex multi-hunk edits.
- Use start_process for dev servers, run_command for short tasks.
- Prefer one high-signal tool call over many speculative ones.
- If the same tactic fails twice, switch tactics instead of repeating it.`;

const STRICT_PATCH_CONTRACT = `# APPLY_PATCH CONTRACT

Patch must use Codex grammar:
- *** Begin Patch
- *** Update File: <path>
- @@
- context/remove/add lines prefixed by " ", "-", "+"
- *** End Patch

Do not send unified diff headers (diff --git, ---, +++).`;

const STRICT_RECOVERY = `# RECOVERY MATRIX

- Stale or uncertain file state:
  use targeted read_file({ path, offset, limit }) only if current context is insufficient, then retry once.
- TOOL_DEPRECATED:
  switch to strict equivalent tool immediately.
- Malformed patch:
  regenerate patch in Codex grammar and retry once.
- Patch apply mismatch/stale content:
  try a smaller/fresher patch; use targeted read_file only if needed, then retry once.
- Completion blocked by diagnostics:
  fix touched-file errors, re-run diagnostics, then complete.
- Empty or over-broad search:
  refine query/includePattern, then retry once.
- Command timeout or low-signal command output:
  stop repeating it; switch to read/search tools or a narrower validator.
- Repeated same failure signature:
  explicitly change strategy before the next tool call.`;

export function buildAgentPrompt(options: AgentPromptOptions): string {
  const parts: string[] = [
    AGENT_IDENTITY,
    buildToolSurface(),
    STRICT_WORKFLOW,
    STRICT_PATCH_CONTRACT,
    STRICT_RECOVERY,
    buildCategoryToolGuidance('agent'),
  ];

  const providerOverlay = buildProviderOverlay(options.provider);
  if (providerOverlay) {
    parts.push(providerOverlay);
  }

  if (options.workspaceRoot) {
    parts.push(`# WORKSPACE\n\nRoot: ${options.workspaceRoot}\nAll paths are relative to this root unless absolute.`);
  }

  if (options.mcpTools && options.mcpTools.length > 0) {
    parts.push(buildMcpSection(options.mcpTools));
  }

  return joinPromptWithBudget(parts, 24000);
}
