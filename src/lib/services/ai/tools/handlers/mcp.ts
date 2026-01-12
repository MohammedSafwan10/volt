/**
 * MCP Tool Handler
 * Bridges MCP tools to the AI tool system
 */

import { mcpStore } from '$lib/stores/mcp.svelte';
import type { ToolResult } from '../utils';

/**
 * Get all MCP tools formatted for Gemini
 */
export function getMcpToolDefinitions(): Array<{
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}> {
  const definitions: Array<{
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
  }> = [];

  for (const { serverId, tool } of mcpStore.tools) {
    // Prefix tool name with server ID to avoid conflicts
    const toolName = `mcp_${serverId}_${tool.name}`;
    
    // Parse input schema or use empty object
    const inputSchema = tool.inputSchema || {};
    const properties = ((inputSchema as Record<string, unknown>).properties || {}) as Record<string, unknown>;
    const required = (inputSchema as Record<string, unknown>).required as string[] | undefined;

    definitions.push({
      name: toolName,
      description: tool.description || `MCP tool: ${tool.name} from ${serverId}`,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    });
  }

  return definitions;
}

/**
 * Check if a tool name is an MCP tool
 */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp_');
}

/**
 * Parse MCP tool name to get server ID and tool name
 */
export function parseMcpToolName(toolName: string): { serverId: string; toolName: string } | null {
  if (!toolName.startsWith('mcp_')) return null;
  
  // Format: mcp_serverId_toolName
  const parts = toolName.slice(4).split('_');
  if (parts.length < 2) return null;
  
  const serverId = parts[0];
  const actualToolName = parts.slice(1).join('_');
  
  return { serverId, toolName: actualToolName };
}

/**
 * Execute an MCP tool
 */
export async function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) {
    return {
      success: false,
      output: `Invalid MCP tool name: ${toolName}`,
    };
  }

  const { serverId, toolName: actualToolName } = parsed;

  try {
    const result = await mcpStore.callTool(serverId, actualToolName, args);
    
    // Format result for AI
    let output: string;
    if (typeof result === 'string') {
      output = result;
    } else if (result && typeof result === 'object') {
      // Check for MCP content format
      const mcpResult = result as { content?: Array<{ type: string; text?: string }> };
      if (mcpResult.content && Array.isArray(mcpResult.content)) {
        output = mcpResult.content
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text)
          .join('\n');
      } else {
        output = JSON.stringify(result, null, 2);
      }
    } else {
      output = String(result);
    }

    return {
      success: true,
      output,
    };
  } catch (error) {
    return {
      success: false,
      output: `MCP tool error: ${error}`,
    };
  }
}

/**
 * Check if an MCP tool should be auto-approved
 */
export function isMcpToolAutoApproved(toolName: string): boolean {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return false;
  
  return mcpStore.isAutoApproved(parsed.serverId, parsed.toolName);
}

/**
 * Get MCP tool info for display
 */
export function getMcpToolInfo(toolName: string): { serverId: string; displayName: string } | null {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return null;
  
  return {
    serverId: parsed.serverId,
    displayName: parsed.toolName,
  };
}
