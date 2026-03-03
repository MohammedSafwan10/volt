/**
 * MCP Tool Handler
 * Bridges MCP tools to the AI tool system
 */

import { mcpStore } from '$features/mcp/stores/mcp.svelte';
import type { ToolResult } from '$core/ai/tools/utils';

function mcpFailure(
  message: string,
  meta: Record<string, unknown> = {},
  warnings: string[] = [],
): ToolResult {
  return {
    success: false,
    output: message,
    error: message,
    data: null,
    meta: {
      source: 'mcp',
      ...meta,
    },
    warnings,
  };
}

function mcpSuccess(
  output: string,
  data: unknown,
  meta: Record<string, unknown> = {},
  warnings: string[] = [],
): ToolResult {
  return {
    success: true,
    output,
    data,
    meta: {
      source: 'mcp',
      ...meta,
    },
    warnings,
  };
}

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

function normalizeMcpToken(value: string): string {
  return value.toLowerCase().replace(/[-_\s]+/g, '');
}

function getKnownServerIds(): string[] {
  const ids = new Set<string>();

  for (const { serverId } of mcpStore.tools) ids.add(serverId);
  for (const id of mcpStore.servers.keys()) ids.add(id);
  for (const id of Object.keys(mcpStore.mergedConfig.mcpServers || {})) ids.add(id);

  return Array.from(ids);
}

function resolveServerId(serverHint: string): string | null {
  const known = getKnownServerIds();
  if (known.length === 0) return null;

  if (known.includes(serverHint)) return serverHint;

  const normalizedHint = normalizeMcpToken(serverHint);
  const exact = known.find((id) => normalizeMcpToken(id) === normalizedHint);
  return exact ?? null;
}

function resolveToolNameForServer(serverId: string, toolHint: string): string {
  const serverTools = mcpStore.tools
    .filter((t) => t.serverId === serverId)
    .map((t) => t.tool.name);

  if (serverTools.length === 0) {
    return toolHint.replace(/_/g, '-');
  }

  if (serverTools.includes(toolHint)) return toolHint;

  const hyphenated = toolHint.replace(/_/g, '-');
  if (serverTools.includes(hyphenated)) return hyphenated;

  const normalizedHint = normalizeMcpToken(toolHint);
  const matched = serverTools.find((name) => normalizeMcpToken(name) === normalizedHint);
  if (matched) return matched;

  return hyphenated;
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
  
  const serverHint = rest.slice(0, firstUnderscore);
  const safeName = rest.slice(firstUnderscore + 1);

  // First pass: basic "mcp_<server>_<tool>" parsing with normalization
  const matchedServer = resolveServerId(serverHint);
  if (matchedServer) {
    return {
      serverId: matchedServer,
      toolName: resolveToolNameForServer(matchedServer, safeName),
    };
  }

  // Second pass: server IDs can contain underscores; try longest prefix match.
  const segments = rest.split('_').filter(Boolean);
  const knownServerIds = getKnownServerIds();
  for (let i = segments.length - 1; i >= 1; i--) {
    const serverCandidate = segments.slice(0, i).join('_');
    const toolCandidate = segments.slice(i).join('_');
    const matchedServer = knownServerIds.find(
      (id) => normalizeMcpToken(id) === normalizeMcpToken(serverCandidate)
    );
    if (!matchedServer) continue;
    return {
      serverId: matchedServer,
      toolName: resolveToolNameForServer(matchedServer, toolCandidate),
    };
  }

  return { serverId: serverHint, toolName: safeName.replace(/_/g, '-') };
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
  properties: Record<string, unknown>,
  actualToolName?: string
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const firstNonEmptyStringDeep = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = firstNonEmptyStringDeep(item);
        if (found) return found;
      }
      return undefined;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) {
        const found = firstNonEmptyStringDeep(v);
        if (found) return found;
      }
    }
    return undefined;
  };
  const looksLikeUrl = (value: string): boolean => {
    const v = value.trim();
    if (!v) return false;
    if (/^https?:\/\//i.test(v)) return true;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(v)) return true;
    if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(v)) return true;
    return false;
  };
  const normalizeToUrl = (value: string): string => {
    const v = value.trim();
    if (!v) return v;
    if (/^https?:\/\//i.test(v)) return v;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(v)) return `http://${v}`;
    if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(v)) return `https://${v}`;
    return v;
  };

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

  // Heuristic aliases for MCP tools whose server-side schema is stricter
  // than what gets surfaced in inputSchema.required/properties.
  if (typeof out.query !== 'string' || out.query.trim() === '') {
    const queryAliases = [
      'library',
      'library_name',
      'libraryName',
      'name',
      'package',
      'package_name',
      'packageName',
      'term',
      'search',
      'keyword',
    ];
    for (const alias of queryAliases) {
      const v = out[alias];
      if (typeof v === 'string' && v.trim().length > 0) {
        out.query = v;
        break;
      }
    }

    // Context7 resolve-library-id often needs a single "query" string.
    // If no known alias exists, use first non-empty string arg as fallback.
    if (
      (typeof out.query !== 'string' || out.query.trim() === '') &&
      actualToolName === 'resolve-library-id'
    ) {
      const firstString = firstNonEmptyStringDeep(out);
      if (firstString) {
        out.query = firstString;
      }
    }
  }

  // Common MCP "fetch" compatibility: many models send uri/link/href/website instead of url.
  if (typeof out.url !== 'string' || out.url.trim() === '') {
    const urlAliases = [
      'uri',
      'href',
      'link',
      'website',
      'target',
      'address',
      'source',
      'web',
      'page',
    ];
    for (const alias of urlAliases) {
      const v = out[alias];
      if (typeof v === 'string' && looksLikeUrl(v)) {
        out.url = normalizeToUrl(v);
        break;
      }
    }

    if ((typeof out.url !== 'string' || out.url.trim() === '')) {
      const deep = firstNonEmptyStringDeep(out);
      if (deep && looksLikeUrl(deep)) {
        out.url = normalizeToUrl(deep);
      }
    }

    // If model put URL inside query for fetch tool, recover it.
    if (
      (typeof out.url !== 'string' || out.url.trim() === '') &&
      (actualToolName === 'fetch' || actualToolName === 'fetch-url') &&
      typeof out.query === 'string' &&
      looksLikeUrl(out.query)
    ) {
      out.url = normalizeToUrl(out.query);
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
    return mcpFailure(`Invalid MCP tool name: ${toolName}`, {
      code: 'MCP_INVALID_TOOL_NAME',
    });
  }

  let { serverId, toolName: actualToolName } = parsed;

  // If server label is wrong/hallucinated, recover by matching tool name on connected servers.
  const configuredServer = !!mcpStore.mergedConfig.mcpServers?.[serverId];
  const connectedServer = mcpStore.servers.get(serverId);
  if (!configuredServer && !connectedServer) {
    const matches = mcpStore.tools.filter(
      (t) => normalizeMcpToken(t.tool.name) === normalizeMcpToken(actualToolName)
    );
    if (matches.length === 1) {
      serverId = matches[0].serverId;
      actualToolName = matches[0].tool.name;
    }
  }

  // Auto-start configured server on demand if not connected yet.
  const serverState = mcpStore.servers.get(serverId);
  if (!serverState || serverState.status !== 'connected') {
    const configured = !!mcpStore.mergedConfig.mcpServers?.[serverId];
    if (configured) {
      try {
        await mcpStore.startServer(serverId);
      } catch {
        // Continue to call; error surface below will include details.
      }
    }
  }

  const { required, properties } = getMcpToolSchema(serverId, actualToolName);
  const normalizedArgs = normalizeMcpArgsToSchema(args, properties, actualToolName);
  const missingRequired = validateRequiredArgs(required, normalizedArgs);

  if (missingRequired.length > 0) {
    const providedKeys = Object.keys(args);
    const requiredText = required.length > 0 ? required.join(', ') : '(none)';
    const missingText = missingRequired.join(', ');
    return mcpFailure(
      `MCP validation failed for ${serverId}/${actualToolName}: missing required argument(s): ${missingText}. Required: ${requiredText}. Provided keys: ${providedKeys.length > 0 ? providedKeys.join(', ') : '(none)'}`,
      {
        code: 'MCP_MISSING_REQUIRED_ARGS',
        serverId,
        toolName: actualToolName,
        missingRequired,
        required,
      },
    );
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

    return mcpSuccess(
      output,
      result,
      {
        code: 'MCP_OK',
        serverId,
        toolName: actualToolName,
      },
    );
  } catch (error) {
    const msg = String(error ?? '');
    if (msg.includes('Server') && msg.includes('not found')) {
      const availableServers = getKnownServerIds();
      const suggestions = availableServers.length > 0
        ? `Available MCP servers: ${availableServers.join(', ')}`
        : 'No MCP servers are currently configured/connected.';
      const merged = `MCP tool error: ${error}. ${suggestions}`;
      return mcpFailure(merged, {
        code: 'MCP_SERVER_NOT_FOUND',
        serverId,
        toolName: actualToolName,
      });
    }
    return mcpFailure(`MCP tool error: ${error}`, {
      code: 'MCP_TOOL_ERROR',
      serverId,
      toolName: actualToolName,
    });
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
