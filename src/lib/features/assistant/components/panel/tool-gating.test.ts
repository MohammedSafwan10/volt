import { describe, expect, it } from 'vitest';

import type { ToolDefinition } from '$core/ai/types';
import { filterToolsForChat } from './tool-gating';

describe('filterToolsForChat', () => {
  const tools: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'mcp_git_status',
      description: 'Git status from MCP',
      parameters: { type: 'object', properties: {} },
    },
  ];

  it('keeps built-in tools in chat', () => {
    const filtered = filterToolsForChat(tools);
    expect(filtered.map((t) => t.name)).toEqual(['read_file']);
  });
});
