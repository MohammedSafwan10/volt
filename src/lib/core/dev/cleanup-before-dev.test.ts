import { describe, expect, it } from 'vitest';

describe('cleanup-before-dev script', () => {
  it('does not use a system-wide node kill fallback during retry cleanup', async () => {
    const source = await import('../../../../scripts/cleanup-before-dev.mjs?raw').then(
      (module) => module.default,
    );

    expect(source).not.toMatch(/killByPattern\((['"])node\1\)/);
    expect(source).toMatch(/await killNodeProcessesForProject\(PROJECT_ROOT\);/);
    expect(source).toMatch(/await killByExactExePath\(join\(CARGO_DEBUG_DIR, 'node\.exe'\)\);/);
  });
});
