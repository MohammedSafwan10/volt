import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./handlers/mcp', () => ({
  getMcpToolDefinitions: () => [],
}));

let RETIRED_TOOL_NAMES!: Set<string>;
let STRICT_CANONICAL_TOOL_NAMES!: Set<string>;
let getAllToolsForMode!: (mode: 'ask' | 'plan' | 'agent') => Array<{ name: string }>;
let getSystemPrompt!: (options: {
  mode: 'ask' | 'plan' | 'agent';
  provider: 'gemini' | 'openrouter' | 'anthropic' | 'openai';
  model: string;
}) => string;

beforeAll(async () => {
  const defs = await import('./definitions');
  RETIRED_TOOL_NAMES = defs.RETIRED_TOOL_NAMES;
  STRICT_CANONICAL_TOOL_NAMES = defs.STRICT_CANONICAL_TOOL_NAMES;
  getAllToolsForMode = defs.getAllToolsForMode;
  getSystemPrompt = (await import('../prompts-v4')).getSystemPrompt;
});

describe('strict tool profile', () => {
  it('exposes only canonical built-in tools by default', () => {
    const names = new Set(getAllToolsForMode('agent').map((tool) => tool.name));
    for (const required of STRICT_CANONICAL_TOOL_NAMES) {
      expect(names.has(required)).toBe(true);
    }

    for (const retired of RETIRED_TOOL_NAMES) {
      if (retired.startsWith('mcp_')) continue;
      expect(names.has(retired)).toBe(false);
    }
  });

  it('keeps ask/plan subsets strict', () => {
    const askNames = new Set(getAllToolsForMode('ask').map((tool) => tool.name));
    const planNames = new Set(getAllToolsForMode('plan').map((tool) => tool.name));

    expect(askNames.has('read_file')).toBe(true);
    expect(askNames.has('workspace_search')).toBe(true);
    expect(askNames.has('apply_patch')).toBe(false);

    expect(planNames.has('read_file')).toBe(true);
    expect(planNames.has('workspace_search')).toBe(true);
    expect(planNames.has('apply_patch')).toBe(false);
    expect(planNames.has('write_plan_file')).toBe(false);
  });

  it('prompt and strict registry align by mode', () => {
    const agentPrompt = getSystemPrompt({ mode: 'agent', provider: 'gemini', model: 'test' });
    const askPrompt = getSystemPrompt({ mode: 'ask', provider: 'gemini', model: 'test' });
    const planPrompt = getSystemPrompt({ mode: 'plan', provider: 'gemini', model: 'test' });

    for (const tool of getAllToolsForMode('agent')) {
      expect(agentPrompt).toContain(tool.name);
    }
    expect(askPrompt).not.toContain('`apply_patch` (');
    expect(askPrompt).not.toContain('`run_command` (');
    expect(planPrompt).not.toContain('`apply_patch` (');
    expect(planPrompt).not.toContain('`run_command` (');
  });
});
