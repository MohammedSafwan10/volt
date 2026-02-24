import { describe, expect, it, vi } from 'vitest';

vi.mock('./handlers/mcp', () => ({
  getMcpToolDefinitions: () => [],
}));
vi.mock('./tools/handlers/mcp', () => ({
  getMcpToolDefinitions: () => [],
}));

import { getSystemPrompt } from './prompts-v4';

describe('strict prompts', () => {
  it('agent prompt includes strict required tools', () => {
    const prompt = getSystemPrompt({
      mode: 'agent',
      provider: 'gemini',
      model: 'test',
      workspaceRoot: 'C:/repo',
    });
    expect(prompt).toContain('list_dir');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('workspace_search');
    expect(prompt).toContain('apply_patch');
    expect(prompt).toContain('run_command');
    expect(prompt).toContain('get_diagnostics');
    expect(prompt).toContain('attempt_completion');
  });

  it('agent prompt mentions codex patch grammar', () => {
    const prompt = getSystemPrompt({
      mode: 'agent',
      provider: 'gemini',
      model: 'test',
    });
    expect(prompt).toContain('*** Begin Patch');
    expect(prompt).toContain('*** End Patch');
    expect(prompt).not.toContain('unified diff style');
  });

  it('agent prompt excludes retired tool guidance', () => {
    const prompt = getSystemPrompt({
      mode: 'agent',
      provider: 'gemini',
      model: 'test',
    });
    expect(prompt).not.toContain('str_replace');
    expect(prompt).not.toContain('multi_replace');
    expect(prompt).not.toContain('replace_lines');
    expect(prompt).not.toContain('find_files');
    expect(prompt).not.toContain('search_symbols');
    expect(prompt).not.toContain('get_file_tree');
    expect(prompt).not.toContain('read_code');
  });

  it('ask/plan prompts exclude mutating tools', () => {
    const ask = getSystemPrompt({ mode: 'ask', provider: 'gemini', model: 'test' });
    const plan = getSystemPrompt({ mode: 'plan', provider: 'gemini', model: 'test' });

    expect(ask).not.toContain('`apply_patch` (');
    expect(ask).not.toContain('`run_command` (');
    expect(plan).not.toContain('`apply_patch` (');
    expect(plan).not.toContain('`run_command` (');
  });
});
