import type { ToolResult } from '$core/ai/tools/utils';
import { specStore } from '$features/specs/stores/specs.svelte';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing "${field}"`);
  }
  return value.trim();
}

export async function handleGetSpecState(): Promise<ToolResult> {
  const state = specStore.getSpecStateSummary();
  return {
    success: true,
    output: JSON.stringify(state, null, 2),
    data: state,
  };
}

export async function handleStageSpecRequirements(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const result = specStore.stageRequirementsDraftFromTool({
      title: requireString(args.title, 'title'),
      slug: requireString(args.slug, 'slug'),
      requirementsMarkdown: requireString(args.requirementsMarkdown, 'requirementsMarkdown'),
    });

    return {
      success: true,
      output: result.message,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stage requirements draft.',
    };
  }
}

export async function handleWriteSpecPhase(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const phase = requireString(args.phase, 'phase') as 'requirements' | 'design' | 'tasks';
    const result = await specStore.writePhaseFromTool({
      phase,
      title: typeof args.title === 'string' ? args.title : undefined,
      slug: typeof args.slug === 'string' ? args.slug : undefined,
      requirementsMarkdown:
        typeof args.requirementsMarkdown === 'string' ? args.requirementsMarkdown : undefined,
      designMarkdown: typeof args.designMarkdown === 'string' ? args.designMarkdown : undefined,
      tasks: Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : undefined,
    });

    return {
      success: true,
      output: result.message,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to write spec phase.',
    };
  }
}
