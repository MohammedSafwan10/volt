import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./handlers/mcp', () => ({
  getMcpToolDefinitions: () => [],
}));

let RETIRED_TOOL_NAMES!: Set<string>;
let STRICT_CANONICAL_TOOL_NAMES!: Set<string>;
let getAllToolsForMode!: (mode: 'ask' | 'plan' | 'agent') => Array<{ name: string }>;
let getSystemPrompt!: (options: {
  mode: 'ask' | 'plan' | 'agent';
  provider: 'gemini' | 'openrouter' | 'anthropic' | 'openai' | 'mistral';
  model: string;
}) => string;

beforeAll(async () => {
  const defs = await import('$core/ai/tools/definitions');
  RETIRED_TOOL_NAMES = defs.RETIRED_TOOL_NAMES;
  STRICT_CANONICAL_TOOL_NAMES = defs.STRICT_CANONICAL_TOOL_NAMES;
  getAllToolsForMode = defs.getAllToolsForMode;
  getSystemPrompt = (await import('$core/ai/prompts/prompts-v4')).getSystemPrompt;
});

describe('tool profile', () => {
  it('exposes all core tools in agent mode and no retired tools', () => {
    const names = new Set(getAllToolsForMode('agent').map((tool) => tool.name));

    // All strict canonical tools must be present
    for (const required of STRICT_CANONICAL_TOOL_NAMES) {
      expect(names.has(required)).toBe(true);
    }

    // No retired tool should be exposed
    for (const retired of RETIRED_TOOL_NAMES) {
      if (retired.startsWith('mcp_')) continue;
      expect(names.has(retired)).toBe(false);
    }

    // Agent mode should have more than just the strict set (16+ core tools)
    expect(names.size).toBeGreaterThanOrEqual(16);
  });

  it('keeps ask/plan subsets read-only', () => {
    const askNames = new Set(getAllToolsForMode('ask').map((tool) => tool.name));
    const planNames = new Set(getAllToolsForMode('plan').map((tool) => tool.name));

    // Read/search tools available in ask and plan
    expect(askNames.has('read_file')).toBe(true);
    expect(askNames.has('workspace_search')).toBe(true);
    expect(planNames.has('read_file')).toBe(true);
    expect(planNames.has('workspace_search')).toBe(true);

    // Write/terminal tools NOT available in ask/plan
    expect(askNames.has('apply_patch')).toBe(false);
    expect(askNames.has('write_file')).toBe(false);
    expect(askNames.has('run_command')).toBe(false);
    expect(planNames.has('apply_patch')).toBe(false);
    expect(planNames.has('write_file')).toBe(false);
    expect(planNames.has('run_command')).toBe(false);
  });

  it('agent prompt mentions all agent-mode tools', () => {
    const agentPrompt = getSystemPrompt({ mode: 'agent', provider: 'gemini', model: 'test' });

    for (const tool of getAllToolsForMode('agent')) {
      expect(agentPrompt).toContain(tool.name);
    }
  });

  it('ask/plan prompts do not mention write tools', () => {
    const askPrompt = getSystemPrompt({ mode: 'ask', provider: 'gemini', model: 'test' });
    const planPrompt = getSystemPrompt({ mode: 'plan', provider: 'gemini', model: 'test' });

    expect(askPrompt).not.toContain('`apply_patch` (');
    expect(askPrompt).not.toContain('`run_command` (');
    expect(planPrompt).not.toContain('`apply_patch` (');
    expect(planPrompt).not.toContain('`run_command` (');
  });
});
