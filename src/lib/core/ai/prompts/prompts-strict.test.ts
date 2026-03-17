import { describe, expect, it, vi } from 'vitest';

vi.mock('$core/ai/tools/handlers/mcp', () => ({
  getMcpToolDefinitions: () => [],
}));

import { getSystemPrompt } from '$core/ai/prompts/prompts-v4';

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

  it('agent prompt includes extended tools', () => {
    const prompt = getSystemPrompt({
      mode: 'agent',
      provider: 'gemini',
      model: 'test',
    });
    // These are now active tools that should be in the prompt
    expect(prompt).toContain('str_replace');
    expect(prompt).toContain('find_files');
    expect(prompt).toContain('file_outline');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('start_process');
  });

  it('agent prompt excludes truly retired tools', () => {
    const prompt = getSystemPrompt({
      mode: 'agent',
      provider: 'gemini',
      model: 'test',
    });
    // These are retired and should NOT appear
    expect(prompt).not.toContain('multi_replace');
    expect(prompt).not.toContain('replace_lines');
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
