import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import moss from './scripts/lint/moss-plugin.mjs';

const CODE = '{js,mjs,cjs,jsx,ts,mts,cts,tsx}';

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
  // Our code. Vendored moss stays byte-identical, so vendor/ gets only the HISTORIC_TAG ban below.
  {
    files: [`**/*.${CODE}`],
    ignores: ['vendor/**'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: [`packages/ui/**/*.${CODE}`],
    plugins: { moss },
    rules: { 'moss/no-raw-color': 'error' },
  },
  {
    files: [`e2e/**/*.${CODE}`],
    plugins: { moss },
    rules: { 'moss/no-contenteditable-pick': 'error' },
  },
  {
    files: [`apps/**/*.${CODE}`, `packages/**/*.${CODE}`, `vendor/**/*.${CODE}`],
    plugins: { moss },
    rules: { 'moss/no-historic-tag': 'error' },
  },
  // Inline directives in vendor/ are ignored, so a vendored file can neither disable the ban
  // nor fail on disable comments naming moss's own lint plugins.
  {
    files: [`vendor/**/*.${CODE}`],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
  },
]);
