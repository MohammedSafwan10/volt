import { describe, expect, it } from 'vitest';
import tauriConfig from '../../../src-tauri/tauri.conf.json';

describe('tauri config schema path', () => {
  it('uses local tauri CLI config schema file', () => {
    const parsed = tauriConfig as { $schema?: string };
    expect(parsed.$schema).toBeDefined();
    expect(parsed.$schema).toBe('../node_modules/@tauri-apps/cli/config.schema.json');
  });
});
