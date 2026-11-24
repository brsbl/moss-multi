// What pristine moss does with a click beside a code block, on its line numbers (T9.52b): the oracle's demo note,
// whose `ts` block is e2e/fixtures/demo-note.md:42. Outputs: test-results/parity/block-click.json. Pinned to what moss
// at the pin does, so a re-pin that changes it fails here: the block's React click handler selects it and Lexical's
// own click listener clears that node selection inside the same click, so no outline shows and nothing is selected
// (ours keeps the block selected instead; DEVIATIONS 40, DecoratorBlockPlugin `block-click-select` seam).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { LexicalEditor } from 'lexical';
import { InfraBlocked } from '../lib/infra.ts';
import { serveStatic, type StaticServer } from './serve-static.ts';
import { STORY_NOW } from './targets.ts';

const OUT = join(import.meta.dirname, '../test-results/parity');
const STORY = 'demo-note--default';

let oracle: StaticServer;
let result: { outline: number; selection: string | null } | null = null;

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
  writeFileSync(join(OUT, 'block-click.json'), `${JSON.stringify(result, null, 2)}\n`);
});

test('block click: what pristine moss does with a click on a code block\'s line numbers', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(STORY_NOW));
    await page.route(/^https:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto(`${oracle.url}/?story=${STORY}&mode=preview`);
    const body = page.locator('[data-moss-note-editor-root="true"]').filter({ has: page.locator('.moss-codeblock-gutter') });
    await body.locator('.moss-codeblock-gutter').waitFor({ timeout: 30_000 });
    const key = await body.evaluate((element) => {
      const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
      return [...editor.getEditorState()._nodeMap.values()].find((node) => node.getType() === 'code-block')?.getKey() ?? '';
    });
    expect(key, 'the demo note renders a code block').not.toBe('');
    const code = body.locator(`[data-block-decorator-key="${key}"]`);
    await code.scrollIntoViewIfNeeded();
    await code.locator('.moss-codeblock-gutter').click();
    // The outline and the selection are read 600 ms after the click, long after the click's own work is done.
    await page.waitForTimeout(600);
    const outline = await code.locator('.editor-block-selection-outline').count();
    const selection = await body.evaluate((element) => {
      const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
      const s = editor.getEditorState()._selection as unknown as { _nodes?: Set<string>; anchor?: { key: string; offset: number } } | null;
      if (!s) return null;
      if (s._nodes) return `node[${[...s._nodes].join(',')}]`;
      return s.anchor ? `range ${s.anchor.key}:${s.anchor.offset}` : 'other';
    });
    result = { outline, selection };
    console.log(`pristine moss, a click on the code block's line numbers: ${JSON.stringify(result)}`);
    test.info().annotations.push({ type: 'pristine moss', description: JSON.stringify(result) });
    expect(outline, 'pristine moss: no selection outline after the click').toBe(0);
    expect(selection, 'pristine moss: the click leaves nothing selected').toBeNull();
  } finally {
    await context.close();
  }
});
