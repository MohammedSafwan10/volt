import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, 'src/lib'),
      $core: path.resolve(__dirname, 'src/lib/core'),
      $features: path.resolve(__dirname, 'src/lib/features'),
      $shared: path.resolve(__dirname, 'src/lib/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src-tauri/**'],
    globals: true,
  },
});
