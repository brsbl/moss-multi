// One living suite (A§20; S-test §3.2). CI runs `--project=selftest-<engine> --project=<engine>`: the selftests
// always run first (journeys depend on them), and a --grep that matches no test fails with "No tests found".
// E2E_GROUP narrows the journey projects to one shard's group (scripts/ci/journeys.mjs); `all` or unset runs every
// journey.
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { ALL, journeyMatch } from '../scripts/ci/journeys.mjs';

const statePath = process.env.STACK_STATE;
const stack = statePath && existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { baseUrl: string }) : null;
const group = process.env.E2E_GROUP;
const journeys = group && group !== ALL ? { testMatch: journeyMatch(group) } : {};

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
  reporter: [
    ['list'],
    ...(process.env.CI ? [['github'] as const] : []),
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['./lib/reporter.ts'],
  ],
  use: {
    baseURL: stack?.baseUrl,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'calibration', testDir: './calibration', use: { browserName: 'chromium' } },
    { name: 'selftest-chromium', testDir: './selftest', use: { browserName: 'chromium' } },
    { name: 'selftest-webkit', testDir: './selftest', use: { browserName: 'webkit' } },
    { name: 'chromium', testDir: './journeys', ...journeys, dependencies: ['selftest-chromium'], use: { browserName: 'chromium' } },
    { name: 'webkit', testDir: './journeys', ...journeys, dependencies: ['selftest-webkit'], use: { browserName: 'webkit' } },
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
