// Selftest fixtures: a fixture-page server per worker and an Actors that never asserts on its own, because each
// selftest decides which findings it expects.
import { test as base } from '@playwright/test';
import { Actors } from '../lib/actors.ts';
import { startFixtureServer, type FixtureServer } from './server.ts';

export { expect } from '@playwright/test';

export const test = base.extend<{ actors: Actors }, { server: FixtureServer }>({
  server: [
    async ({}, use) => {
      const server = await startFixtureServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  actors: async ({ browser }, use, testInfo) => {
    testInfo.annotations.push({ type: 'browser', description: `${browser.browserType().name()} ${browser.version()}` });
    const actors = new Actors(browser, testInfo, { stack: null, runToken: 'selftest' });
    actors.solo('fixture pages have no principals; the guard has its own selftest');
    await use(actors);
    await actors.dispose();
  },
});
