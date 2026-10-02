// One living suite (A§20; S-test §3.2). CI runs `--project=selftest-<engine> --project=<engine>`: the selftests
// always run first (journeys depend on them), and a --grep that matches no test fails with "No tests found".
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const statePath = process.env.STACK_STATE;
const stack = statePath && existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { baseUrl: string }) : null;

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
    { name: 'selftest-chromium', testDir: './selftest', use: { browserName: 'chromium' } },
    { name: 'selftest-webkit', testDir: './selftest', use: { browserName: 'webkit' } },
    { name: 'chromium', testDir: './journeys', dependencies: ['selftest-chromium'], use: { browserName: 'chromium' } },
    { name: 'webkit', testDir: './journeys', dependencies: ['selftest-webkit'], use: { browserName: 'webkit' } },
  ],
});
