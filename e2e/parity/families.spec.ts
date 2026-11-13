// Node-family parity (A§20, S-test §5): pristine moss renders the demo note in its own App (the oracle-only
// DemoNote story); the built Worker renders the same markdown imported as a real doc. Per family selector, the
// first match's computed style must equal the oracle's, in light and dark. Layout widths are left to the shell
// targets; this compares how each family is styled. Outputs: test-results/parity/families-<theme>.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { APP_STATE_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR } from '../lib/contract.ts';
import { InfraBlocked } from '../lib/infra.ts';
import { mintPrincipal, signIn } from '../lib/principals.ts';
import { Stack } from '../lib/stack.ts';
import { serveStatic, type StaticServer } from './serve-static.ts';
import { FAMILY_SELECTORS, PROPERTIES } from './families.ts';
import { CROP, STORY_NOW, THEMES, type Theme } from './targets.ts';

const OUT = join(import.meta.dirname, '../test-results/parity');
const STORY = 'demo-note--default';
const DEMO = readFileSync(new URL('../fixtures/demo-note.md', import.meta.url), 'utf8');
const EDITOR = `${CROP} [data-moss-note-editor-root="true"]`;

type Styles = Record<string, Record<string, string> | null>;

let oracle: StaticServer;
let stack: Stack;

test.beforeAll(async () => {
  const dir = process.env.ORACLE_DIR;
  if (!dir) throw new InfraBlocked('ORACLE_DIR is unset; build it with e2e/parity/oracle/build.mjs');
  oracle = await serveStatic(dir);
  const stories = Object.keys((JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { stories: object }).stories);
  if (!stories.includes(STORY)) throw new InfraBlocked(`the oracle has no story ${STORY}`);
  stack = Stack.fromState();
  await stack.assertProvenance();
});

test.afterAll(async () => {
  await oracle?.close();
});

async function newPage(browser: Browser, theme: Theme): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(STORY_NOW));
  // Network media is j11's; answer it locally so neither side waits on it.
  await page.route(/^https:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 404, body: '' }));
  return page;
}

/** Waits for every family to render, then reads each first match's computed style. */
async function readStyles(page: Page, theme: Theme): Promise<Styles> {
  await page.locator(EDITOR).waitFor({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(({ editor, selectors }) => {
    const root = document.querySelector(editor);
    return root ? Object.entries(selectors).filter(([, s]) => !root.querySelector(s)).map(([family]) => family) : ['the editor'];
  }, { editor: EDITOR, selectors: FAMILY_SELECTORS }), { message: 'every family renders', timeout: 30_000 }).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1438, 998);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return page.evaluate(({ editor, selectors, properties }) => {
    const root = document.querySelector(editor)!;
    return Object.fromEntries(Object.entries(selectors).map(([family, selector]) => {
      const element = root.querySelector(selector);
      if (!element) return [family, null];
      const style = getComputedStyle(element);
      return [family, Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)]))];
    }));
  }, { editor: EDITOR, selectors: FAMILY_SELECTORS, properties: PROPERTIES });
}

async function oracleStyles(browser: Browser, theme: Theme): Promise<Styles> {
  const page = await newPage(browser, theme);
  try {
    await page.goto(`${oracle.url}/?story=${STORY}&mode=preview`);
    try {
      return await readStyles(page, theme);
    } catch (error) {
      throw new InfraBlocked(`the oracle did not render the demo note: ${(error as Error).message}`);
    }
  } finally {
    await page.context().close();
  }
}

async function candidateStyles(browser: Browser, theme: Theme): Promise<Styles> {
  const page = await newPage(browser, theme);
  try {
    const principal = await mintPrincipal(stack.baseUrl, `parity-${process.env.RUN_ID ?? 'local'}-${Date.now().toString(36)}`, `families-${theme}`, 1);
    await page.context().addCookies(await signIn(stack.baseUrl, principal));
    const create = async (title: string, markdown: string) => {
      const response = await page.request.post(new URL('/api/docs', stack.baseUrl).href, {
        data: { title, markdown },
        headers: { origin: new URL(stack.baseUrl).origin },
      });
      if (response.status() !== 201) throw new Error(`POST /api/docs: ${response.status()}`);
      return ((await response.json()) as { doc: { id: string } }).doc;
    };
    // The oracle paints its wiki link resolved; here it resolves only when its target note exists.
    await create('Demo target', 'The wiki link\'s target.');
    const doc = await create('Demo note', DEMO);
    await page.goto(new URL(`/d/${encodeURIComponent(doc.id)}`, stack.baseUrl).href);
    await page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
    await page.locator(`[${EDITOR_PANE_ATTR}][${DOC_STATE_ATTR}="live"]`).waitFor({ timeout: 30_000 });
    return await readStyles(page, theme);
  } finally {
    await page.context().close();
  }
}

for (const theme of THEMES) {
  test(`node families ${theme}: every family's computed style equals pristine moss's`, async ({ browser }) => {
    const expected = await oracleStyles(browser, theme);
    const actual = await candidateStyles(browser, theme);
    const differences: string[] = [];
    for (const family of Object.keys(FAMILY_SELECTORS)) {
      for (const name of PROPERTIES) {
        const want = expected[family]?.[name];
        const got = actual[family]?.[name];
        if (want !== got) differences.push(`${family} ${name}: moss ${want}, ours ${got}`);
      }
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `families-${theme}.json`), `${JSON.stringify({ theme, expected, actual, differences }, null, 2)}\n`);
    expect(differences, `${theme}: computed-style differences per family`).toEqual([]);
  });
}
