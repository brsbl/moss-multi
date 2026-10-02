import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const repo = fileURLToPath(new URL('.', import.meta.url));
const vendor = `${repo}vendor/moss/packages`;
// Written by packages/sync/test/pristine.setup.ts: moss's own files at the pin, for L3 and the TDZ control.
const pristine = JSON.stringify(`${repo}.cache/moss-pristine`);

// Moss's aliases (ARCHITECTURE §2), for vendored code and for host code that imports it.
const alias = [
  { find: /^@moss\/shared$/, replacement: `${vendor}/shared/src/index.ts` },
  { find: /^@moss\/shared\/(.*)$/, replacement: `${vendor}/shared/src/$1` },
  { find: /^@\/(.*)$/, replacement: `${vendor}/shared/src/$1` },
  { find: /^@moss-desktop\/(.*)$/, replacement: `${vendor}/desktop/src/$1` },
];

export default defineConfig({
  resolve: { alias },
  test: {
    exclude: ['**/node_modules/**', '**/fixtures/**'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['scripts/**/*.test.mjs', 'apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
        },
      },
      {
        // L2: the converter inside workerd (S-conv §5.1).
        extends: true,
        plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2025-09-02', compatibilityFlags: ['nodejs_compat'] } })],
        define: { __MOSS_PRISTINE__: pristine },
        test: {
          name: 'converter-workerd',
          include: ['packages/sync/test/workerd/**/*.test.ts'],
          globalSetup: ['packages/sync/test/pristine.setup.ts'],
        },
      },
      {
        // L3: parity with moss's pipeline at the pin, and the client node views, in jsdom as moss's tests run.
        extends: true,
        define: { __MOSS_PRISTINE__: pristine },
        test: {
          name: 'converter-parity',
          environment: 'jsdom',
          include: ['packages/sync/test/parity/**/*.test.ts', 'packages/sync/test/views/**/*.test.ts'],
          setupFiles: ['packages/sync/test/parity/setup.ts'],
          globalSetup: ['packages/sync/test/pristine.setup.ts'],
        },
      },
    ],
  },
});
