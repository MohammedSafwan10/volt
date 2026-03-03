import { describe, expect, it } from 'vitest';

import { applyCodexPatch, parseCodexPatch } from '$core/ai/tools/handlers/write-patch';

describe('write-patch parser', () => {
  it('parses codex patch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: game.js',
      '@@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
      '*** End Patch',
    ].join('\n');

    const parsed = parseCodexPatch(patch);
    expect(parsed.path).toBe('game.js');
    expect(parsed.hunks.length).toBe(1);
    expect(parsed.hunks[0].lines.length).toBe(4);
  });

  it('applies parsed hunks', () => {
    const before = ['const a = 1;', 'const b = 2;', 'const c = 4;'].join('\n');
    const parsed = parseCodexPatch('*** Begin Patch\n*** Update File: game.js\n@@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n*** End Patch');
    const after = applyCodexPatch(before, parsed.hunks);
    expect(after).toContain('const b = 3;');
    expect(after).not.toContain('const b = 2;');
  });

  it('throws deterministic message on malformed line', () => {
    const malformed = '*** Begin Patch\n*** Update File: game.js\n@@\n const a = 1;\nthis line has no prefix\n+const b = 2;\n*** End Patch';
    expect(() => parseCodexPatch(malformed)).toThrow('Malformed patch: invalid patch line');
  });

  it('accepts patch body without begin/end wrapper by auto-wrapping', () => {
    const patch = [
      '*** Update File: game.js',
      '@@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
    ].join('\n');
    const parsed = parseCodexPatch(patch);
    expect(parsed.path).toBe('game.js');
    expect(parsed.hunks.length).toBe(1);
  });

  it('accepts fenced diff wrapper around codex patch body', () => {
    const patch = [
      '```diff',
      '*** Begin Patch',
      '*** Update File: game.js',
      '@@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
      '*** End Patch',
      '```',
    ].join('\n');
    const parsed = parseCodexPatch(patch);
    expect(parsed.path).toBe('game.js');
    expect(parsed.hunks.length).toBe(1);
  });
});
