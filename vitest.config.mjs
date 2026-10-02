import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/fixtures/**'],
  },
});
