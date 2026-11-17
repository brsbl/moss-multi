// What one Cmd+Z takes back in pristine moss (T9.13): the oracle's UndoNote story, the same keys as the j01-undo leg
// (e2e/lib/undo-steps.ts). Outputs: test-results/parity/undo-steps.json. Pinned to MOSS_UNDO_STEPS, which the j01 leg
// asserts of the web build, so a re-pin that changes moss's steps fails here. The clock runs: Lexical's history
// merges typing by time.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { InfraBlocked } from '../lib/infra.ts';
import { CARET_SCENARIOS, MOSS_UNDO_CARET, MOSS_UNDO_STEPS, UNDO_SCENARIOS, undoCaret, undoSteps, type UndoSteps } from '../lib/undo-steps.ts';
import { serveStatic, type StaticServer } from './serve-static.ts';

const OUT = join(import.meta.dirname, '../test-results/parity');
const STORY = 'undo-note--start';

let oracle: StaticServer;
const results: Record<string, UndoSteps> = {};

test.beforeAll(async () => {
  const dir = process.env.ORACLE_DIR;
  if (!dir) throw new InfraBlocked('ORACLE_DIR is unset; build it with e2e/parity/oracle/build.mjs');
  oracle = await serveStatic(dir);
  const stories = Object.keys((JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { stories: object }).stories);
  if (!stories.includes(STORY)) throw new InfraBlocked(`the oracle has no story ${STORY}`);
});

test.afterAll(async () => {
  await oracle?.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'undo-steps.json'), `${JSON.stringify(results, null, 2)}\n`);
});

for (const scenario of UNDO_SCENARIOS) {
  test(`undo steps, ${scenario.name}: what one Cmd+Z takes back in pristine moss`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(`${oracle.url}/?story=${STORY}&mode=preview`);
      const root = page.locator('[data-moss-note-editor-root="true"]').filter({ hasText: 'Start.' });
      await root.locator('p').first().waitFor({ timeout: 30_000 });
      const result = await undoSteps(page, root, scenario);
      results[scenario.name] = result;
      console.log(`pristine moss, ${scenario.name}: ${JSON.stringify(result)}`);
      test.info().annotations.push({ type: 'pristine moss', description: JSON.stringify(result) });
      expect(result, `pristine moss: ${scenario.name}`).toEqual(MOSS_UNDO_STEPS[scenario.name]);
    } finally {
      await context.close();
    }
  });
}

// T9.14: where the next word lands after undo and redo in pristine moss.
for (const scenario of CARET_SCENARIOS) {
  test(`undo caret, ${scenario.name}: where the next word lands in pristine moss`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(`${oracle.url}/?story=${STORY}&mode=preview`);
      const root = page.locator('[data-moss-note-editor-root="true"]').filter({ hasText: 'Start.' });
      await root.locator('p').first().waitFor({ timeout: 30_000 });
      const result = await undoCaret(page, root, scenario);
      console.log(`pristine moss, caret, ${scenario.name}: ${JSON.stringify(result)}`);
      test.info().annotations.push({ type: 'pristine moss', description: JSON.stringify(result) });
      expect(result, `pristine moss: ${scenario.name}`).toEqual(MOSS_UNDO_CARET[scenario.name]);
    } finally {
      await context.close();
    }
  });
}
