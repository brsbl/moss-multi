import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const CODE = '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/.wrangler/**',
    '.refs/**',
    '.claude/**',
    '.local-stack/**',
    'test-results/**',
    'playwright-report/**',
    'scripts/ci/fixtures/**',
  ]),
  {
    files: [CODE],
    ignores: ['vendor/**'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
]);
