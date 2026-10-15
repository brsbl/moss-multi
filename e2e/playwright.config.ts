// One living suite (A§20; S-test §3.2). CI runs `--project=selftest-<engine> --project=<engine>`: the selftests
// always run first (journeys depend on them), and a --grep that matches no test fails with "No tests found".
// E2E_GROUP narrows the journey projects to one shard's group (scripts/ci/journeys.mjs); `all` or unset runs every
// journey.
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, type ReporterDescription } from '@playwright/test';
import { ALL, journeyMatch } from '../scripts/ci/journeys.mjs';
import { CANARY_REPORTER, isLoopback, RECORD_FAILURES, recordingFor } from '../scripts/deploy/canary-artifacts.mjs';

const statePath = process.env.STACK_STATE;
const stack = statePath && existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { baseUrl: string }) : null;
const group = process.env.E2E_GROUP;
const journeys = group && group !== ALL ? { testMatch: journeyMatch(group) } : {};
// No trace, screenshot or video against a non-loopback target: they would carry real session cookies.
const recording = stack ? recordingFor(stack.baseUrl) : RECORD_FAILURES;
// Nor error text or test output in the log: a failed request's call log lists its cookie header, and a staging run's
// log is public. The JSON results stay on the runner.
const offLoopback = stack !== null && !isLoopback(stack.baseUrl);
const files: ReporterDescription[] = [['json', { outputFile: 'test-results/results.json' }], ['./lib/reporter.ts']];

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  globalTimeout: 18 * 60_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A 2-vCPU runner holds workerd and 2-3 contexts; raise only after repeat_each=5 stays green.
  workers: 1,
  fullyParallel: false,
  reporter: offLoopback
    ? [[CANARY_REPORTER], ...files]
    : [
        ['list'],
        ...(process.env.CI ? [['github'] as const] : []),
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ...files,
      ],
  use: {
    baseURL: stack?.baseUrl,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    ...recording,
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'calibration', testDir: './calibration', use: { browserName: 'chromium' } },
    { name: 'selftest-chromium', testDir: './selftest', use: { browserName: 'chromium' } },
    { name: 'selftest-webkit', testDir: './selftest', use: { browserName: 'webkit' } },
    { name: 'chromium', testDir: './journeys', ...journeys, dependencies: ['selftest-chromium'], use: { browserName: 'chromium' } },
    { name: 'webkit', testDir: './journeys', ...journeys, dependencies: ['selftest-webkit'], use: { browserName: 'webkit' } },
    // The staging canary (A§21, T8.D): j00-shell, the j01 setup legs and j04's @staging leg on a Worker with no hooks,
    // a fixed principal pool and a request budget (STACK_STATE from scripts/deploy/canary-state.mjs). deploy-staging.yml
    // runs it on staging; ci.yml's canary job rehearses it on a production-mode local stack.
    {
      name: 'canary',
      testDir: './journeys',
      testMatch: /j0(?:0-shell|1-coedit|4-hibernation)\.spec\.ts$/,
      grep: /j00-shell\.spec|j01 setup|@staging/,
      // Fails closed: with no target, nothing is recorded.
      use: { browserName: 'chromium', ...recordingFor(stack?.baseUrl) },
    },
    // Shell parity against the Ladle oracle (A§20): the parity job only, in the e2e image's Chromium.
    { name: 'parity', testDir: './parity', use: { browserName: 'chromium' } },
    // The read-only viewer bundle's acceptance fixture (T0.13): the viewer job only, against packages/viewer/dist.
    { name: 'viewer-chromium', testDir: './viewer', use: { browserName: 'chromium' } },
    { name: 'viewer-webkit', testDir: './viewer', use: { browserName: 'webkit' } },
    // The embeddable editor bundle's acceptance fixture (T3.9): the editor job only, against packages/editor/dist.
    { name: 'editor-chromium', testDir: './editor', use: { browserName: 'chromium' } },
    { name: 'editor-webkit', testDir: './editor', use: { browserName: 'webkit' } },
  ],
});
