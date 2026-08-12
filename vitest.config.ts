import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [{
      find: /^@ambiental\/core$/,
      replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    }],
  },
  test: { exclude: ['tests/**', '**/node_modules/**', '**/dist/**'] },
});
