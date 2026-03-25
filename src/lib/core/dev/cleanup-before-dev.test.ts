import { readFile } from 'fs/promises';
import { describe, expect, it } from 'vitest';

describe('cleanup-before-dev script', () => {
  it('does not use a system-wide node kill fallback during retry cleanup', async () => {
    const source = await readFile(new URL('../../../../scripts/cleanup-before-dev.mjs', import.meta.url), 'utf8');

    expect(source).not.toMatch(/killByPattern\((['"])node\1\)/);
    expect(source).toMatch(/await killNodeProcessesForProject\(PROJECT_ROOT\);/);
    expect(source).toMatch(/await killByExactExePath\(join\(CARGO_DEBUG_DIR, 'node\.exe'\)\);/);
  });
});
