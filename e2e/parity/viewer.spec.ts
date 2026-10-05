// The viewer against the editor's read-only view (T3.8, A§20): the built Worker shows j14's demo note and the T0.13
// fixture to a vault viewer (a read-only editor); the viewer bundle (packages/viewer/dist, built by this job) mounts
// the same markdown in a plain host page. Per family selector, and for the title, the first match's computed style
// must be equal, in light and dark. Media and post embeds stay with the viewer job: the web reads its assets and
// unfurls through its own routes. Outputs: test-results/parity/viewer-<note>-<theme>.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { APP_STATE_ATTR, DOC_ID_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR, ROLE_ATTR } from '../lib/contract.ts';
import { mintPrincipal, signIn, type Principal } from '../lib/principals.ts';
import { Stack } from '../lib/stack.ts';
import { FIXTURE_DIR, serveViewer, type ViewerServer } from '../viewer/server.ts';
import { PROPERTIES, READ_ONLY_FAMILY_SELECTORS } from './families.ts';
import { THEMES, type Theme } from './targets.ts';

const OUT = join(import.meta.dirname, '../test-results/parity');
const DEMO = readFileSync(new URL('../fixtures/demo-note.md', import.meta.url), 'utf8');
const SEED = readFileSync(join(FIXTURE_DIR, 'seed-library.md'), 'utf8');

/** The note's families both renders show: the fixture's are those that need no media or embed service. */
const NOTES = [
  { id: 'demo', title: 'Demo note', markdown: DEMO, families: Object.keys(READ_ONLY_FAMILY_SELECTORS) },
  {
    id: 'fixture',
    title: 'Seed Library Notes',
    markdown: SEED,
    families: ['paragraph', 'heading 2', 'bulleted list', 'checklist item', 'checked item', 'link', 'table', 'table header cell', 'table cell', 'tabs', 'tab bar', 'wiki link', 'HTML block'],
  },
] as const;
const TARGETS = ['Demo target', 'Planting Calendar', 'Seed Index'];

interface Fixture {
  viewerFixture: { mount(options: Record<string, unknown>): Promise<unknown> };
}

type Styles = Record<string, Record<string, string> | null>;

let stack: Stack;
let viewer: ViewerServer;

test.beforeAll(async () => {
  stack = Stack.fromState();
  await stack.assertProvenance();
  viewer = await serveViewer();
});

test.afterAll(async () => {
  await viewer?.close();
});

async function newPage(browser: Browser, theme: Theme): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await context.newPage();
  // Remote media and embeds are not compared; answer them locally so neither side waits on them.
  await page.route(/^https:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 404, body: '' }));
  return page;
}

/** Waits for the families to render, then reads each first match's computed style and the title's. */
async function readStyles(page: Page, theme: Theme, root: string, title: string, families: readonly string[]): Promise<Styles> {
  const selectors = Object.fromEntries(families.map((family) => [family, READ_ONLY_FAMILY_SELECTORS[family]]));
  await page.locator(root).waitFor({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(({ root, selectors }) => {
    const body = document.querySelector(root);
    return body ? Object.entries(selectors).filter(([, s]) => !body.querySelector(s)).map(([family]) => family) : ['the editor'];
  }, { root, selectors }), { message: 'every family renders', timeout: 30_000 }).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1438, 998);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return page.evaluate(({ root, title, selectors, properties }) => {
    const body = document.querySelector(root)!;
    const read = (element: Element | null) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)]));
    };
    return {
      title: read(document.querySelector(title)),
      ...Object.fromEntries(Object.entries(selectors).map(([family, selector]) => [family, read(body.querySelector(selector))])),
    };
  }, { root, title, selectors, properties: PROPERTIES });
}

async function api(page: Page, method: 'GET' | 'POST', path: string, data?: unknown) {
  const origin = new URL(stack.baseUrl).origin;
  const response = await page.request.fetch(new URL(path, stack.baseUrl).href, { method, data, headers: { origin } });
  if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${(await response.text()).slice(0, 200)}`);
  return response.json() as Promise<Record<string, unknown>>;
}

interface Seeded {
  reader: Principal;
  docs: Record<string, string>;
}

let seeded: Promise<Seeded> | null = null;

/** The owner's notes, and a reader holding viewer on the owner's vault; once for both themes (sign-up is rate limited). */
async function seed(browser: Browser): Promise<Seeded> {
  const run = `parity-${process.env.RUN_ID ?? 'local'}-${Date.now().toString(36)}`;
  const owner = await mintPrincipal(stack.baseUrl, run, 'viewer-owner', 1);
  const reader = await mintPrincipal(stack.baseUrl, run, 'viewer-reader', 2);
  const page = await newPage(browser, 'light');
  try {
    await page.context().addCookies(await signIn(stack.baseUrl, owner));
    for (const title of TARGETS) await api(page, 'POST', '/api/docs', { title, markdown: `${title}, a wiki link's target.` });
    const docs: Record<string, string> = {};
    for (const note of NOTES) docs[note.id] = ((await api(page, 'POST', '/api/docs', { title: note.title, markdown: note.markdown })).doc as { id: string }).id;
    const vault = ((await api(page, 'GET', `/api/workspace?doc=${encodeURIComponent(docs.demo)}`)).vault as { id: string }).id;
    await api(page, 'POST', `/api/folders/${encodeURIComponent(vault)}/members`, { email: reader.email, role: 'viewer' });
    return { reader, docs };
  } finally {
    await page.context().close();
  }
}

async function editorStyles(browser: Browser, theme: Theme, reader: Principal, docId: string, families: readonly string[]): Promise<Styles> {
  const page = await newPage(browser, theme);
  try {
    await page.context().addCookies(await signIn(stack.baseUrl, reader));
    await page.goto(new URL(`/d/${encodeURIComponent(docId)}`, stack.baseUrl).href);
    await page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
    const pane = `[${EDITOR_PANE_ATTR}][${DOC_ID_ATTR}="${docId}"]`;
    await page.locator(`${pane}[${DOC_STATE_ATTR}="live"]`).waitFor({ timeout: 30_000 });
    await expect(page.locator(pane), 'the reader holds viewer: the editor is read-only').toHaveAttribute(ROLE_ATTR, 'viewer');
    return await readStyles(page, theme, `${pane} [data-moss-note-editor-root="true"]`, `${pane} div.text-h1`, families);
  } finally {
    await page.context().close();
  }
}

async function viewerStyles(browser: Browser, theme: Theme, note: (typeof NOTES)[number]): Promise<Styles> {
  const page = await newPage(browser, theme);
  try {
    await page.goto(`${viewer.url}/fixture/`);
    await expect(page.locator('html[data-fixture="ready"]')).toHaveCount(1);
    // The fixture's file has its title as a leading H1; the viewer lifts it, so the web note is imported with it too.
    await page.evaluate((options) => void (window as unknown as Fixture).viewerFixture.mount(options), { markdown: note.markdown, title: note.title, theme, noteId: `note-${note.id}`, live: true });
    await page.locator('[data-moss-viewer][data-moss-viewer-state="ready"]').waitFor({ timeout: 30_000 });
    return await readStyles(page, theme, '[data-moss-viewer] [data-moss-note-editor-root]', '[data-moss-viewer-title]', note.families);
  } finally {
    await page.context().close();
  }
}

for (const theme of THEMES) {
  test(`viewer ${theme}: every family and the title compute the styles the editor's read-only view does`, async ({ browser }) => {
    seeded ??= seed(browser);
    const { reader, docs } = await seeded;
    const differences: string[] = [];
    mkdirSync(OUT, { recursive: true });
    for (const note of NOTES) {
      const expected = await editorStyles(browser, theme, reader, docs[note.id], note.families);
      const actual = await viewerStyles(browser, theme, note);
      for (const family of ['title', ...note.families]) {
        for (const name of PROPERTIES) {
          const want = expected[family]?.[name];
          const got = actual[family]?.[name];
          if (want !== got) differences.push(`${note.id} ${family} ${name}: editor ${want}, viewer ${got}`);
        }
      }
      writeFileSync(join(OUT, `viewer-${note.id}-${theme}.json`), `${JSON.stringify({ theme, expected, actual }, null, 2)}\n`);
    }
    expect(differences, `${theme}: computed-style differences between the viewer and the read-only editor`).toEqual([]);
  });
}
