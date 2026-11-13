// What pristine moss does when the caret leaves a note's last block by ArrowDown (T9.2): the oracle's TrailingBlock
// stories, the same keys as the j01 leg. Outputs: test-results/parity/arrow-below.json. Pinned to what moss at the pin
// does, so a re-pin that changes it fails here: past a callout the second ArrowDown takes the selection out of the
// editor and the typing is dropped (ours selects the callout instead; DEVIATIONS); past a table the selection stays in
// the editor and the typing lands in a paragraph below it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { InfraBlocked } from '../lib/infra.ts';
import { arrowBelow, type ArrowBelow } from '../lib/arrow-below.ts';
import { serveStatic, type StaticServer } from './serve-static.ts';
import { STORY_NOW } from './targets.ts';

const OUT = join(import.meta.dirname, '../test-results/parity');
const CASES = [
  { story: 'trailing-block--callout', block: '.moss-callout', start: '.moss-callout p', drops: true },
  { story: 'trailing-block--table', block: 'table', start: 'table tr:last-child td:last-child', drops: false },
] as const;

let oracle: StaticServer;
const results: Record<string, ArrowBelow> = {};

test.beforeAll(async () => {
  const dir = process.env.ORACLE_DIR;
  if (!dir) throw new InfraBlocked('ORACLE_DIR is unset; build it with e2e/parity/oracle/build.mjs');
  oracle = await serveStatic(dir);
  const stories = Object.keys((JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { stories: object }).stories);
  for (const { story } of CASES) if (!stories.includes(story)) throw new InfraBlocked(`the oracle has no story ${story}`);
});

test.afterAll(async () => {
  await oracle?.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'arrow-below.json'), `${JSON.stringify(results, null, 2)}\n`);
});

for (const { story, block, start, drops } of CASES) {
  test(`arrow below ${story}: what pristine moss does with two ArrowDowns past the last block, then typing`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(STORY_NOW));
      await page.goto(`${oracle.url}/?story=${story}&mode=preview`);
      const root = page.locator('[data-moss-note-editor-root="true"]').filter({ has: page.locator(block) });
      await root.locator(start).waitFor({ timeout: 30_000 });
      const result = await arrowBelow(page, root, root.locator(start), 2, 'hello');
      results[story] = result;
      console.log(`pristine moss, ${story}: ${JSON.stringify(result)}`);
      test.info().annotations.push({ type: 'pristine moss', description: JSON.stringify(result) });
      if (drops) {
        expect(result.after, 'pristine moss: the second ArrowDown leaves the editor').toEqual(['inside', 'outside']);
        expect(result.text, 'pristine moss: the typing is dropped').not.toContain('hello');
      } else {
        expect(result.after, 'pristine moss: the selection stays in the editor').toEqual(['inside', 'inside']);
        expect(result.last, 'pristine moss: the typing is a paragraph at the end').toEqual({ tag: 'P', text: 'hello' });
      }
    } finally {
      await context.close();
    }
  });
}
