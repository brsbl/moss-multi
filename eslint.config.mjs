import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import regexp from 'eslint-plugin-regexp';
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
    '.oracle/**',
    'e2e/parity/oracle/moss/**',
    '.cache/**',
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
    // Detectors run in the page; Playwright fixtures destructure `{}` when they need no other fixture.
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { 'moss/no-contenteditable-pick': 'error', 'no-empty-pattern': 'off' },
  },
  {
    files: [`apps/**/*.${CODE}`, `packages/**/*.${CODE}`, `vendor/**/*.${CODE}`],
    plugins: { moss },
    rules: { 'moss/no-historic-tag': 'error' },
  },
  // ReDoS guard: our regexes run over user content, so none may backtrack super-linearly (docs/METHOD.md).
  // A `.ref.ts` is a test-only verbatim copy of moss's code, held to moss's bytes like vendor/.
  {
    files: [`apps/**/*.${CODE}`, `packages/**/*.${CODE}`, `scripts/**/*.${CODE}`, `e2e/lib/**/*.${CODE}`],
    ignores: ['vendor/**', '**/*.gen.ts', '**/*.ref.ts'],
    plugins: { regexp },
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      'regexp/no-misleading-capturing-group': 'error',
      'regexp/optimal-quantifier-concatenation': 'error',
    },
  },
  // Inline directives in vendor/ are ignored, so a vendored file can neither disable the ban
  // nor fail on disable comments naming moss's own lint plugins.
  {
    files: [`vendor/**/*.${CODE}`],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
  },
]);
