import { describe, expect, it } from 'vitest';

import {
  buildReadBeforeEditError,
  getReadRequirement,
  requiresReadBeforeEdit,
} from './tool-guards';

describe('tool-guards', () => {
  it('identifies mutating tools requiring prior read', () => {
    expect(requiresReadBeforeEdit('str_replace')).toBe(true);
    expect(requiresReadBeforeEdit('apply_patch')).toBe(true);
    expect(requiresReadBeforeEdit('create_dir')).toBe(false);
  });

  it('allows write_file missing target bypass and requires read otherwise', () => {
    const requirement = getReadRequirement('write_file', { path: 'src/new.ts' });
    expect(requirement).not.toBeNull();
    expect(requirement?.allowIfTargetMissing).toBe(true);
    expect(requirement?.requiredKind).toBe('read');
  });

  it('requires outline or read for delete', () => {
    const requirement = getReadRequirement('delete_file', { path: 'src/old.ts' });
    expect(requirement?.requiredKind).toBe('outline');
  });

  it('builds actionable error messages', () => {
    const readError = buildReadBeforeEditError('src/app.ts', 'read');
    const outlineError = buildReadBeforeEditError('src/app.ts', 'outline');
    expect(readError).toContain('read_file');
    expect(outlineError).toContain('read_file');
    expect(readError).toContain('offset');
  });
});
