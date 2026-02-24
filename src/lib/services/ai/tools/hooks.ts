import { getToolCapabilities } from './capabilities';
import type { CanonicalToolResult } from './utils';

export interface ToolHookContext {
  toolName: string;
  args: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  startedAt: number;
}

export interface ToolHookOutcome {
  parseCategory?: 'patch_parse' | 'patch_apply' | 'schema' | 'none';
}

export function beforeToolHook(_ctx: ToolHookContext): void {
  // Reserved for future policy hooks.
}

export function afterToolHook(
  ctx: ToolHookContext,
  result: CanonicalToolResult,
): ToolHookOutcome {
  const caps = getToolCapabilities(ctx.toolName);
  if (!caps.isMutating) {
    return { parseCategory: 'none' };
  }

  const message = `${result.error} ${result.output}`.toLowerCase();
  if (ctx.toolName === 'apply_patch') {
    if (message.includes('malformed patch')) {
      return { parseCategory: 'patch_parse' };
    }
    if (message.includes('patch apply failed') || message.includes('mismatch')) {
      return { parseCategory: 'patch_apply' };
    }
  }
  if (result.code === 'MISSING_PARAM') {
    return { parseCategory: 'schema' };
  }
  return { parseCategory: 'none' };
}
