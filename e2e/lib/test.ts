// The only import journeys use: `test` with the stack, actors and phase clocks, and an auto fixture that checks
// the 9 invariants on every actor after every test (S-test §3.3).
import { test as base } from '@playwright/test';
import { Actors } from './actors.ts';
import { Measure } from './measure.ts';
import { Stack } from './stack.ts';

export { expect } from '@playwright/test';
export * as ui from './ui.ts';

interface TestFixtures { actors: Actors; stack: Stack; measure: Measure }
interface WorkerFixtures { runToken: string; stackW: Stack }

export const test = base.extend<TestFixtures, WorkerFixtures>({
  runToken: [async ({}, use, workerInfo) => use(`${(process.env.RUN_ID ?? 'local').toLowerCase()}-w${workerInfo.workerIndex}`), { scope: 'worker' }],
  stackW: [
    async ({}, use) => {
      const stack = Stack.fromState();
      await stack.assertProvenance();
      await use(stack);
    },
    { scope: 'worker' },
  ],
  stack: async ({ stackW }, use) => use(stackW),
  measure: async ({}, use, testInfo) => use(new Measure(testInfo)),
  actors: [
    async ({ browser, stackW, runToken }, use, testInfo) => {
      testInfo.annotations.push({ type: 'browser', description: `${browser.browserType().name()} ${browser.version()}` });
      const actors = new Actors(browser, testInfo, { stack: stackW, runToken });
      await use(actors);
      try {
        await actors.assertInvariants();
      } finally {
        await actors.dispose();
      }
    },
    { auto: true },
  ],
});
