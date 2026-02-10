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
    // Replace hyphens with underscores for valid function names
    const safeName = tool.name.replace(/-/g, '_');
    const toolName = `mcp_${serverId}_${safeName}`;
    
    // Parse input schema or use empty object
    const inputSchema = tool.inputSchema || {};
    const properties = ((inputSchema as Record<string, unknown>).properties || {}) as Record<string, unknown>;
    const required = (inputSchema as Record<string, unknown>).required as string[] | undefined;

    // Build a better description that includes required params
    let description = tool.description || `MCP tool: ${tool.name} from ${serverId}`;
    if (required && required.length > 0) {
      description += ` (Required: ${required.join(', ')})`;
    }

    definitions.push({
      name: toolName,
      description,
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
  
  // Format: mcp_serverId_safeName (where safeName has underscores instead of hyphens)
  const rest = toolName.slice(4); // Remove 'mcp_'
  const firstUnderscore = rest.indexOf('_');
  if (firstUnderscore === -1) return null;
  
  const serverId = rest.slice(0, firstUnderscore);
  const safeName = rest.slice(firstUnderscore + 1);
  
  // Convert underscores back to hyphens for the actual tool name
  // But only for tool names that originally had hyphens
  // Try the safe name first, then try with hyphens
  const actualToolName = safeName.replace(/_/g, '-');
  
  // Check if the tool exists with hyphens or underscores
  const toolExists = mcpStore.tools.some(
    t => t.serverId === serverId && (t.tool.name === safeName || t.tool.name === actualToolName)
  );
  
  if (toolExists) {
    // Find the actual tool name
    const found = mcpStore.tools.find(
      t => t.serverId === serverId && (t.tool.name === safeName || t.tool.name === actualToolName)
    );
    return { serverId, toolName: found?.tool.name || actualToolName };
  }
  
  // Fallback - try with hyphens
  return { serverId, toolName: actualToolName };
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function toCamelCase(value: string): string {
  const normalized = value.replace(/[-\s]+/g, '_');
  return normalized.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function getMcpToolSchema(serverId: string, toolName: string): {
  required: string[];
  properties: Record<string, unknown>;
} {
  const entry = mcpStore.tools.find((t) => t.serverId === serverId && t.tool.name === toolName);
  const inputSchema = (entry?.tool.inputSchema ?? {}) as Record<string, unknown>;
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((x): x is string => typeof x === 'string')
    : [];
  const properties =
    inputSchema.properties && typeof inputSchema.properties === 'object'
      ? (inputSchema.properties as Record<string, unknown>)
      : {};
  return { required, properties };
}

function normalizeMcpArgsToSchema(
  args: Record<string, unknown>,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };

  for (const schemaKey of Object.keys(properties)) {
    if (out[schemaKey] !== undefined) continue;

    const snake = toSnakeCase(schemaKey);
    const camel = toCamelCase(schemaKey);
    const kebab = schemaKey.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

    const candidates = [snake, camel, kebab];
    for (const c of candidates) {
      if (out[c] !== undefined) {
        out[schemaKey] = out[c];
        break;
      }
    }
  }

  return out;
}

function validateRequiredArgs(
  required: string[],
  args: Record<string, unknown>
): string[] {
  return required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
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
  const { required, properties } = getMcpToolSchema(serverId, actualToolName);
  const normalizedArgs = normalizeMcpArgsToSchema(args, properties);
  const missingRequired = validateRequiredArgs(required, normalizedArgs);

  if (missingRequired.length > 0) {
    const providedKeys = Object.keys(args);
    const requiredText = required.length > 0 ? required.join(', ') : '(none)';
    const missingText = missingRequired.join(', ');
    return {
      success: false,
      output: `MCP validation failed for ${serverId}/${actualToolName}: missing required argument(s): ${missingText}. Required: ${requiredText}. Provided keys: ${providedKeys.length > 0 ? providedKeys.join(', ') : '(none)'}`,
    };
  }

  try {
    const result = await mcpStore.callTool(serverId, actualToolName, normalizedArgs);
    
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
