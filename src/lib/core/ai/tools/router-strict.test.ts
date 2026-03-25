import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('$shared/stores/project.svelte', () => ({
  projectStore: { rootPath: null },
}));
vi.mock('$features/assistant/stores/assistant.svelte', () => ({
  assistantStore: {},
}));
vi.mock('$features/assistant/stores/tool-observability.svelte', () => ({
  toolObservabilityStore: { record: () => undefined },
}));
vi.mock('$features/assistant/stores/agent-telemetry.svelte', () => ({
  agentTelemetryStore: { record: () => undefined },
}));
vi.mock('./handlers', () => ({
  toolHandlers: {},
}));
vi.mock('./handlers/mcp', () => ({
  isMcpTool: () => false,
  executeMcpTool: async () => ({ success: false, error: 'mock' }),
  isMcpToolAutoApproved: () => true,
  getMcpToolInfo: () => null,
  getMcpToolDefinitions: () => [],
}));

let normalizeToolName!: (toolName: string) => string;
let validateToolCall!: (
  toolName: string,
  args: Record<string, unknown>,
  mode: 'ask' | 'plan' | 'agent',
) => { valid: boolean; error?: string };
let executeToolCall!: (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ success: boolean; code: string; error: string }>;

beforeAll(async () => {
  const router = await import('$core/ai/tools/router');
  normalizeToolName = router.normalizeToolName;
  validateToolCall = router.validateToolCall;
  executeToolCall = router.executeToolCall;
});

describe('router strict validation', () => {
  it('keeps shell_command alias and blocks removed aliases', () => {
    expect(normalizeToolName('shell_command')).toBe('run_command');
    expect(normalizeToolName('command')).toBe('command');
  });

  it('rejects retired legacy tools deterministically', () => {
    const result = validateToolCall('get_file_tree', { path: 'src' }, 'agent');
    expect(result.valid).toBe(false);
    expect(result.error ?? '').toContain('removed from strict profile');
  });

  it('maps retired tool execution to TOOL_DEPRECATED', async () => {
    const result = await executeToolCall('get_file_tree', {
      path: 'src',
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('TOOL_DEPRECATED');
  });

  it('rejects retired browser tooling deterministically', () => {
    const result = validateToolCall('browser_navigate', { url: 'https://example.com' }, 'agent');
    expect(result.valid).toBe(false);
    expect(result.error ?? '').toContain('removed from strict profile');
  });

  it('rejects old read_file line-range args', () => {
    const result = validateToolCall(
      'read_file',
      { path: 'src/app.ts', start_line: 1, end_line: 20 },
      'ask',
    );
    expect(result.valid).toBe(false);
    expect(result.error ?? '').toContain('offset');
  });

  it('accepts new read_file args', () => {
    const result = validateToolCall(
      'read_file',
      { path: 'src/app.ts', offset: 0, limit: 120 },
      'ask',
    );
    expect(result.valid).toBe(true);
  });

  it('allows write_file with only path for empty file creation', () => {
    const result = validateToolCall(
      'write_file',
      { path: 'src/mmm' },
      'agent',
    );
    expect(result.valid).toBe(true);
  });

  it('keeps retired get_file_tree guidance out of tool execution paths', async () => {
    const result = await executeToolCall('get_file_tree', { path: '.' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('TOOL_DEPRECATED');
    expect(result.error).toContain('removed from strict profile');
  });
});
