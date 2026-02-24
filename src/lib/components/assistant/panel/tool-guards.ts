export type ReadRequirementKind = 'outline' | 'read';

export interface ReadRequirement {
  paths: string[];
  requiredKind: ReadRequirementKind;
  allowIfTargetMissing?: boolean;
}

const READ_BEFORE_EDIT_TOOLS = new Set([
  'write_file',
  'append_file',
  'str_replace',
  'multi_replace',
  'replace_lines',
  'apply_patch',
  'rename_path',
  'delete_file',
]);

export function requiresReadBeforeEdit(toolName: string): boolean {
  return READ_BEFORE_EDIT_TOOLS.has(toolName);
}

export function getReadRequirement(
  toolName: string,
  args: Record<string, unknown>,
): ReadRequirement | null {
  switch (toolName) {
    case 'write_file': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) return null;
      return {
        paths: [path],
        requiredKind: 'read',
        allowIfTargetMissing: true,
      };
    }
    case 'append_file':
    case 'str_replace':
    case 'multi_replace':
    case 'replace_lines': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) return null;
      return { paths: [path], requiredKind: 'read' };
    }
    case 'apply_patch': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) return null;
      return { paths: [path], requiredKind: 'read' };
    }
    case 'rename_path': {
      const oldPath = typeof args.oldPath === 'string' ? args.oldPath.trim() : '';
      if (!oldPath) return null;
      return { paths: [oldPath], requiredKind: 'read' };
    }
    case 'delete_file': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) return null;
      return { paths: [path], requiredKind: 'outline' };
    }
    default:
      return null;
  }
}

export function buildReadBeforeEditError(path: string, requiredKind: ReadRequirementKind): string {
  if (requiredKind === 'outline') {
    return `Read-before-edit guard: inspect "${path}" before deleting it. Run read_file({ path: "${path}", offset: 0, limit: 120 }).`;
  }
  return `Read-before-edit guard: read "${path}" before editing. Use focused reads: read_file({ path: "${path}", offset, limit }).`;
}
