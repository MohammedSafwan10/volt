import { describe, expect, it } from 'vitest';

import type { ToolDefinition } from '$lib/services/ai/types';
import { filterToolsForChat } from './tool-gating';

describe('filterToolsForChat', () => {
  const tools: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'browser_get_summary',
      description: 'Get browser summary',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'browser_click',
      description: 'Click browser element',
      parameters: { type: 'object', properties: {} },
    },
  ];

  it('removes browser tools when browser tools are disabled', () => {
    const filtered = filterToolsForChat(tools, false);
    expect(filtered.map((t) => t.name)).toEqual(['read_file']);
  });

  it('keeps browser tools when browser tools are enabled', () => {
    const filtered = filterToolsForChat(tools, true);
    expect(filtered.map((t) => t.name)).toEqual([
      'read_file',
      'browser_get_summary',
      'browser_click',
    ]);
  });
});
