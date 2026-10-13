// The actors' own screenshots follow the run's recording policy (A§21): an @evidence checkpoint and an invariant
// failure capture pages only against a loopback target, never staging or an unknown one, and the failure still throws.
import type { Browser, Page, TestInfo } from '@playwright/test';
import { Actors } from '../lib/actors.ts';
import type { Stack } from '../lib/stack.ts';
import type { FixtureServer } from './server.ts';
import { expect, test } from './fixtures.ts';

async function capturing(browser: Browser, testInfo: TestInfo, server: FixtureServer, baseUrl: string | null) {
  const attached: string[] = [];
  const info = {
    file: testInfo.file,
    tags: ['@evidence'],
    annotations: [],
    attach: async (name: string) => { attached.push(name); },
  } as unknown as TestInfo;
  const actors = new Actors(browser, info, { stack: baseUrl === null ? null : ({ baseUrl } as unknown as Stack), runToken: 'selftest' });
  actors.solo('fixture pages have no principals');
  // floating.html breaks invariant 5, so the checkpoint fails.
  const actor = await actors.anonymous(`${server.url}/floating.html`, { label: 'shot' });
  let shots = 0;
  const screenshot = actor.page.screenshot.bind(actor.page);
  actor.page.screenshot = (async (options?: Parameters<Page['screenshot']>[0]) => {
    shots += 1;
    return screenshot(options);
  }) as Page['screenshot'];
  return { actors, attached, shots: () => shots };
}

for (const [target, baseUrl] of [['a staging target', 'https://staging.example.invalid'], ['an unknown target', null]] as const) {
  test(`against ${target}, an @evidence checkpoint and its failure take no screenshot and still throw`, async ({ browser, server }, testInfo) => {
    const { actors, attached, shots } = await capturing(browser, testInfo, server, baseUrl);
    try {
      await expect(actors.checkpoint('mid-test')).rejects.toThrow(/invariant 5/);
      expect(shots(), 'no screenshot').toBe(0);
      expect(attached, 'only the census').toEqual(['checkpoint mid-test-census.json']);
    } finally {
      await actors.dispose();
    }
  });
}

test('against a loopback target, the checkpoint and its failure capture the page (the control)', async ({ browser, server }, testInfo) => {
  const { actors, attached, shots } = await capturing(browser, testInfo, server, server.url);
  try {
    await expect(actors.checkpoint('mid-test')).rejects.toThrow(/invariant 5/);
    expect(shots()).toBe(2);
    expect(attached).toEqual(['mid-test-shot.png', 'checkpoint mid-test-census.json', 'checkpoint mid-test-shot.png']);
  } finally {
    await actors.dispose();
  }
});
