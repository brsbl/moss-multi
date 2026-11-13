// What pristine moss does with the first click into a table just inserted from the slash menu (T9.21): the oracle's
// NewTable story (a new, empty note) and TrailingBlock's callout story (a note with text), the same steps as the j01
// leg. Outputs: test-results/parity/first-click.json. Pinned to what moss at the pin does, so a re-pin that changes
// it fails here: in a new note a quick click (the pointer arrives and clicks at once) is dropped and the typing goes
// to the cell the insert left the caret in; a paced click, and any click in a note with text, lands in its cell.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { InfraBlocked } from '../lib/infra.ts';
import { firstClick, slashTable, type ClickPace, type FirstClick } from '../lib/first-click.ts';
import { serveStatic, type StaticServer } from './serve-static.ts';
import { STORY_NOW } from './targets.ts';

const OUT = join(import.meta.dirname, '../test-results/parity');
const NOTES = [
  { note: 'new', story: 'new-table--empty', line: '[aria-label="Note title"]' },
  { note: 'existing', story: 'trailing-block--callout', line: 'p:has-text("Budget notes.")' },
] as const;
const CLICKED: [number, number] = [1, 0];
const INSERTED: [number, number] = [2, 2];
/** Where pristine moss puts the typing. */
const MOSS: Record<string, [number, number]> = { 'new quick': INSERTED, 'new paced': CLICKED, 'existing quick': CLICKED, 'existing paced': CLICKED };

let oracle: StaticServer;
const results: Record<string, FirstClick> = {};

test.beforeAll(async () => {
  const dir = process.env.ORACLE_DIR;
  if (!dir) throw new InfraBlocked('ORACLE_DIR is unset; build it with e2e/parity/oracle/build.mjs');
  oracle = await serveStatic(dir);
  const stories = Object.keys((JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { stories: object }).stories);
  for (const { story } of NOTES) if (!stories.includes(story)) throw new InfraBlocked(`the oracle has no story ${story}`);
});

test.afterAll(async () => {
  await oracle?.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'first-click.json'), `${JSON.stringify(results, null, 2)}\n`);
});

for (const { note, story, line } of NOTES) {
  for (const pace of ['quick', 'paced'] as ClickPace[]) {
    test(`first click into a new table, ${note} note, ${pace} click: what pristine moss does`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date(STORY_NOW));
        await page.goto(`${oracle.url}/?story=${story}&mode=preview`);
        const root = page.locator('[data-moss-note-editor-root="true"]').first();
        const start = page.locator(line).first();
        await start.waitFor({ timeout: 30_000 });
        // A new note: the title, then Enter to the body's empty line. A note with text: a new line after its first.
        await start.click();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        const table = await slashTable(page, root);
        const result = await firstClick(page, root, table, CLICKED, pace, 'x');
        results[`${note} ${pace}`] = result;
        console.log(`pristine moss, ${note} note, ${pace} click: ${JSON.stringify(result)}`);
        test.info().annotations.push({ type: 'pristine moss', description: JSON.stringify(result) });
        expect(result.inserted, 'pristine moss: the insert leaves the caret in the last cell').toEqual(INSERTED);
        expect(result.cells[0][0], 'pristine moss: the first header cell reads "Header"').toBe('Header');
        expect(result.landed, `pristine moss: where the typing lands after a ${pace} click in a ${note} note`).toEqual(MOSS[`${note} ${pace}`]);
      } finally {
        await context.close();
      }
    });
  }
}
