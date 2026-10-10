// T3.9 embeddable editor acceptance: the built bundle (packages/editor/dist) mounts moss's own editor, editable,
// on a note in a fixture host's in-memory Moss workspace, under the editor's own CSP. Every node family saves
// byte-identically to T0.6's goldens; Cmd+Shift+A lands a comment as a `%%m:` marker plus a comments.json entry
// that desktop's reader takes back; an external change reloads a clean editor and a stale write is refused with
// "Changed in Moss"; pasted media goes only through the host; and the editor is shot in light and dark.
// T3.10 (editor 0.2.0): `selection()` (feature `selection-1`) with lines golden-compared against the file a save
// writes, exact after an unsaved edit, and moss's Share with Agent button only with services.shareWithAgent.
// T3.11 (editor 0.3.0, API 2): a moss-html block renders inert until the user presses Run (PRODUCT ruling 21), and
// the frame policy refuses a running block's requests and navigations (the WebRTC guard is checked as defense in
// depth, not as a guarantee); copyFromNote
// copies only from a note the user opened; a case-only retitle keeps the markdown entry's spelling as Moss desktop
// does; and an API 1 host (the 0.2.0 host fixture) gets a typed apiMismatch at mount.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { framePolicy, serveEditor, type EditorServer } from './server.ts';
import {
  SELECTION_CASES,
  SELECTION_COMMENTS,
  SELECTION_NOTE,
  SELECTION_TITLE,
  collapseIn,
  expectLinesIn,
  expectNoMarker,
  selectText,
  type MossSelection,
} from '../lib/selection.ts';

const ID = '3f0c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const FAMILIES = fileURLToPath(new URL('../../packages/sync/src/converter/fixtures', import.meta.url));
const MEDIA = fileURLToPath(new URL('../fixtures/media', import.meta.url));
const DEMO = readFileSync(new URL('../fixtures/demo-note.md', import.meta.url), 'utf8');

const meta = (title: string) => ({
  id: ID,
  title,
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_100,
  stickyTabs: [],
  frontmatterMeta: {},
  folderPath: 'Notes',
  trashedAt: null,
  lastOpenedAt: null,
  contentType: 'medium-text',
});

interface Fixture {
  api: number;
  info: { api: number; version: string; features: string[] };
  selection(): MossSelection | null | 'unsupported';
  shared(): (MossSelection | null)[];
  violations: string[];
  reset(options?: { caseInsensitive?: boolean }): void;
  open(noteId: string): void;
  seed(segments: string[], note: { markdown: string; meta: object; comments?: string | null; layout?: string | null }): string;
  seedAsset(dir: string, name: string, base64: string): void;
  mount(noteId: string, options?: { theme?: 'light' | 'dark'; share?: boolean | 'fail' }): Promise<{ ok: boolean; code?: string; status: string }>;
  setTheme(theme: 'light' | 'dark'): void;
  flush(): Promise<{ kind: string }>;
  unmount(options?: { discardUnsaved?: boolean }): Promise<{ kind: string; flush: string }>;
  unmountDetail(options?: { discardUnsaved?: boolean }): Promise<{ kind: string; flush: string; markdown: string | null }>;
  delayWrites(ms: number): void;
  status(): string | null;
  events(): { kind: string; cause?: string; status?: string; op?: string; location?: object }[];
  files(under?: string): Record<string, string>;
  externalWrite(path: string, text: string): void;
  silentWrite(path: string, text: string): void;
  calls(): { op: string; name?: string; ops?: string[]; sourceNoteId?: string; sourceRef?: string; result?: string }[];
  assetUrl(noteId: string, ref: string): string | null;
}

interface Api1Result {
  host: { api: number; version: string; features: string[] };
  editor: { api: number; version: string; features: string[] };
  ready: { ok: boolean; name?: string; code?: string; message?: string };
  status: string;
  placeholder: string | null;
  events: { kind: string; op?: string; status?: string; willRetry?: boolean }[];
  calls: string[];
  unchanged: boolean;
  flush: { kind: string };
  unmount: { kind: string; flush: string };
}

declare global {
  interface Window {
    editorFixture: Fixture;
    api1Fixture: { mount(noteId: string, note: { markdown: string; meta: object }): Promise<Api1Result> };
  }
}

let server: EditorServer;

test.beforeAll(async () => {
  server = await serveEditor();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page): Promise<{ errors: string[] }> {
  const seen = { errors: [] as string[] };
  page.on('pageerror', (error) => seen.errors.push(error.message));
  await page.goto(`${server.url}/fixture/index.html`);
  await expect(page.locator('html[data-fixture="ready"]')).toBeAttached();
  return seen;
}

const title = (page: Page) => page.locator('[data-moss-editor-title]');
const body = (page: Page) => page.locator('[data-moss-editor] [data-moss-note-editor-root="true"]');

/** Selects `word` inside the body's text `line` through the DOM selection, which Lexical adopts on selectionchange. */
async function selectWord(page: Page, line: string, word: string): Promise<void> {
  await body(page).getByText(line).click();
  await body(page).evaluate((root, { line, word }) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(word) ?? -1;
      if (at < 0 || !node.textContent?.includes(line.slice(0, 5))) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`no text node holds ${word}`);
  }, { line, word });
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe(word);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function mountNote(page: Page, markdown: string, options: { comments?: string | null; theme?: 'light' | 'dark'; title?: string; share?: boolean | 'fail' } = {}) {
  const noteTitle = options.title ?? 'Plan';
  const result = await page.evaluate(
    ({ id, markdown, meta, comments, theme, noteTitle, share }) => {
      window.editorFixture.reset();
      window.editorFixture.seed(['Notes', noteTitle], { markdown, meta, comments });
      return window.editorFixture.mount(id, { theme, share });
    },
    { id: ID, markdown, meta: meta(noteTitle), comments: options.comments ?? null, theme: options.theme ?? 'light', noteTitle, share: options.share ?? false },
  );
  expect(result, 'the note mounts').toEqual({ ok: true, status: 'clean' });
  await expect(page.locator('[data-moss-editor][data-moss-editor-status="clean"]')).toBeVisible();
}

/** The scroll offset of the canvas the editor scrolls in. */
const scrollTop = (page: Page) =>
  body(page).evaluate((root) => {
    for (let el = root.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el.scrollTop;
    }
    return document.scrollingElement?.scrollTop ?? 0;
  });

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** The block's own document inside a moss-html preview frame (`layer`: moss's static or interactive frame). */
const blockIn = (page: Page, index = 0, layer: 'static' | 'interactive' = 'static') =>
  body(page)
    .locator('[data-moss-html-preview-viewport]')
    .nth(index)
    .frameLocator(`iframe[title="${layer === 'static' ? 'HTML preview' : 'HTML preview (interactive)'}"]`)
    .frameLocator('iframe');

/** PRODUCT ruling 21: the user activates the `index`th HTML block and presses its Run button. */
async function runBlock(page: Page, index = 0) {
  const viewport = body(page).locator('[data-moss-html-preview-viewport]').nth(index);
  await viewport.getByRole('button', { name: 'Activate live HTML preview' }).click();
  await viewport.frameLocator('iframe[title="HTML preview (interactive)"]').getByRole('button', { name: 'Run' }).click();
}

const files = (page: Page) => page.evaluate(() => window.editorFixture.files());

// T0.6's goldens are the headless converter's export. Desktop's editor writes them byte for byte except in three
// ways, each moss's own behaviour at the pin, which the comparison accounts for and nothing else:
// - its editor-read migrations canonicalize a moss-html fragment into a full document (common/moss-html-migration.ts),
//   so a canonical shell's body must equal the golden's fragment;
// - its live editor mints a random id for an anonymous symbolic formula, where the converter's is deterministic, so
//   an id the source did not carry is compared as `<minted>`;
// - its live format transforms split nested emphasis (text-formats).
const MOSS_HTML_SHELL =
  /(`{3,})moss-html\n<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="moss-html-version" content="v1">\n<title>[^<\n]*<\/title>\n<\/head>\n<body>\n([\s\S]*?)\n<\/body>\n<\/html>\n\1/g;
const LIVE_EDITOR: Record<string, [string, string][]> = {
  'text-formats': [['Mixed **bold with *nested italic* inside** text.', 'Mixed **bold with** ***nested italic*** **inside** text.']],
};
// Only an anonymous formula's id (`{{expr|display|id=<uuid>}}`, no name) that the source did not carry, each distinct
// id to its own token in order of appearance, so a duplicated or swapped minted id still fails.
const mintedIds = (markdown: string, source: string) => {
  const tokens = new Map<string, string>();
  return markdown.replace(/(\{\{[^{}]*?\|id=)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}/g, (match, head: string, id: string) => {
    if (source.includes(id)) return match;
    if (!tokens.has(id)) tokens.set(id, `<minted-${tokens.size + 1}>`);
    return `${head}${tokens.get(id)}}}`;
  });
};

const shellBodies = (markdown: string) => markdown.replace(MOSS_HTML_SHELL, (_match, fence: string, body: string) => `${fence}moss-html\n${body}\n${fence}`);

function desktopExpected(name: string, golden: string, source: string): string {
  let expected = golden;
  for (const [from, to] of LIVE_EDITOR[name] ?? []) expected = expected.replace(from, to);
  return mintedIds(shellBodies(expected), source);
}

function desktopActual(written: string, source: string): string {
  return mintedIds(shellBodies(written), source);
}

test.describe('embeddable editor', () => {
  test('every node family saves byte-identically to its T0.6 golden', async ({ page }) => {
    test.setTimeout(600_000);
    const seen = await open(page);
    const names = readdirSync(FAMILIES)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, ''))
      .sort();
    expect(names.length, 'the family corpus').toBeGreaterThanOrEqual(30);
    const mismatches: Record<string, { expected: string; actual: string | undefined }> = {};
    for (const name of names) {
      const markdown = readFileSync(join(FAMILIES, `${name}.md`), 'utf8');
      const sidecar = join(FAMILIES, `${name}.comments.json`);
      await mountNote(page, `# Family\n\n${markdown}`, { comments: existsSync(sidecar) ? readFileSync(sidecar, 'utf8') : null, title: 'Family' });
      // A retitle makes the editor write the whole note, as any edit does.
      await title(page).click();
      await page.keyboard.press('End');
      await page.keyboard.type('!');
      expect(await page.evaluate(() => window.editorFixture.flush()), `${name}: flush`).toMatchObject({ kind: 'saved' });
      const golden = readFileSync(join(FAMILIES, 'goldens', `${name}.export.md`), 'utf8');
      const written = (await files(page))['/Moss/Notes/Family!/Family!.md'];
      const expected = `# Family!\n\n${desktopExpected(name, golden, markdown)}`;
      const actual = written === undefined ? undefined : desktopActual(written, markdown);
      if (actual !== expected) mismatches[name] = { expected, actual };
      await page.evaluate(() => window.editorFixture.unmount({ discardUnsaved: true }));
    }
    expect(mismatches).toEqual({});
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test('Cmd+Shift+A adds a comment that lands as a marker plus a comments.json entry desktop reads back', async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, '# Plan\n\nAlpha beta gamma\n');
    await selectWord(page, 'Alpha beta gamma', 'beta');
    await page.keyboard.press('ControlOrMeta+Shift+A');
    const input = page.getByRole('textbox', { name: 'comment editor' });
    await expect(input).toBeVisible();
    await input.click();
    await page.keyboard.type('Looks right');
    await page.getByRole('button', { name: 'Submit comment' }).click();
    await expect(body(page).locator('mark')).toHaveText('beta');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });

    const written = await files(page);
    const markdown = written['/Moss/Notes/Plan/Plan.md'];
    const marker = /^# Plan\n\nAlpha %%m:([A-Za-z0-9_-]+):start%%beta%%m:\1:end%% gamma\n?$/.exec(markdown);
    expect(marker, `a %%m: marker wraps the selection in ${JSON.stringify(markdown)}`).not.toBeNull();
    const id = marker![1];
    const sidecar = JSON.parse(written['/Moss/Notes/Plan/comments.json']) as Record<string, { text: string; createdAt: number }>;
    expect(Object.keys(sidecar)).toEqual([id]);
    expect(sidecar[id]).toMatchObject({ text: 'Looks right' });
    // Desktop's serializer: compact JSON with no trailing newline.
    expect(written['/Moss/Notes/Plan/comments.json']).toBe(JSON.stringify(sidecar));

    // A fresh mount reads the comment back from the marker and the sidecar, as the Mac app does.
    await page.evaluate(() => window.editorFixture.unmount());
    expect(await page.evaluate((id) => window.editorFixture.mount(id), ID)).toEqual({ ok: true, status: 'clean' });
    await expect(body(page).locator('mark')).toHaveText('beta');
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test('an external change reloads a clean editor, and a stale write is refused with "Changed in Moss"', async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, '# Plan\n\nFirst line\n');
    await page.evaluate(() => window.editorFixture.externalWrite('/Moss/Notes/Plan/Plan.md', '# Plan\n\nChanged in the Mac app\n'));
    await expect(body(page).getByText('Changed in the Mac app')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.editorFixture.events().map((event) => `${event.kind}:${event.cause ?? ''}`))).toContain('reloaded:external');

    // Moss saves again, and bb's next write is based on the version before it.
    await page.evaluate(() => window.editorFixture.silentWrite('/Moss/Notes/Plan/Plan.md', '# Plan\n\nMoss saved this\n'));
    await body(page).getByText('Changed in the Mac app').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' plus bb');
    const banner = page.locator('[data-moss-editor-conflict]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('Changed in Moss');
    expect((await files(page))['/Moss/Notes/Plan/Plan.md']).toBe('# Plan\n\nMoss saved this\n');
    expect(await page.evaluate(() => window.editorFixture.status())).toBe('conflict');

    await banner.getByRole('button', { name: 'Overwrite' }).click();
    await expect(page.locator('[data-moss-editor][data-moss-editor-status="clean"]')).toBeVisible();
    expect((await files(page))['/Moss/Notes/Plan/Plan.md']).toMatch(/^# Plan\n\nChanged in the Mac app plus bb\n?$/);
    expect(seen.errors).toEqual([]);
  });

  test('an in-place reload keeps a body that starts with its own H1, and the next save writes it', async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, '# Plan\n\nIntro\n');
    await page.evaluate(() => window.editorFixture.externalWrite('/Moss/Notes/Plan/Plan.md', '# Plan\n\n# Section\n\nBody\n'));
    await expect(body(page).getByText('Body', { exact: true })).toBeVisible();
    await expect(body(page).locator('h1')).toHaveText('Section');
    await expect.poll(() => page.evaluate(() => window.editorFixture.events().map((event) => event.kind))).toContain('reloaded');
    await body(page).getByText('Body', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    expect((await files(page))['/Moss/Notes/Plan/Plan.md']).toMatch(/^# Plan\n\n# Section\n\nBody more\n?$/);
    expect(seen.errors).toEqual([]);
  });

  test('an in-place reload keeps the caret and the scroll, so the next keystroke lands where it was', async ({ page }) => {
    const seen = await open(page);
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`);
    await mountNote(page, `# Plan\n\n${lines.join('\n\n')}\n`);
    const target = body(page).getByText('Line 30', { exact: true });
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await page.keyboard.press('End');
    await frames(page);
    const before = await scrollTop(page);
    expect(before, 'the note scrolls').toBeGreaterThan(0);
    const changed = lines.map((line) => (line === 'Line 5' ? 'Line 5 changed in Moss' : line));
    await page.evaluate((markdown) => window.editorFixture.externalWrite('/Moss/Notes/Plan/Plan.md', markdown), `# Plan\n\n${changed.join('\n\n')}\n`);
    await expect.poll(() => page.evaluate(() => window.editorFixture.events().map((event) => `${event.kind}:${event.cause ?? ''}`))).toContain('reloaded:external');
    await expect(body(page).getByText('Line 5 changed in Moss')).toBeAttached();
    await frames(page);
    await page.keyboard.type('XYZ');
    await frames(page);
    expect(Math.abs((await scrollTop(page)) - before), 'the view stays where it was').toBeLessThan(40);
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const written = (await files(page))['/Moss/Notes/Plan/Plan.md'];
    expect(written?.replace(/\n?$/, '\n')).toBe(`# Plan\n\n${changed.map((line) => (line === 'Line 30' ? 'Line 30XYZ' : line)).join('\n\n')}\n`);
    expect(seen.errors).toEqual([]);
  });

  test('Undo after an in-place reload does not bring back the text the Mac app replaced', async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, '# Plan\n\nFirst line\n');
    await body(page).getByText('First line').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' bb edit');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    await page.evaluate(() => window.editorFixture.externalWrite('/Moss/Notes/Plan/Plan.md', '# Plan\n\nThe Mac app rewrote this\n'));
    await expect.poll(() => page.evaluate(() => window.editorFixture.events().map((event) => `${event.kind}:${event.cause ?? ''}`))).toContain('reloaded:external');
    await expect(body(page).getByText('The Mac app rewrote this')).toBeVisible();
    await body(page).getByText('The Mac app rewrote this').click();
    await page.keyboard.press('ControlOrMeta+Z');
    await frames(page);
    await expect(body(page)).toContainText('The Mac app rewrote this');
    await expect(body(page)).not.toContainText('bb edit');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'clean' });
    expect((await files(page))['/Moss/Notes/Plan/Plan.md']).toBe('# Plan\n\nThe Mac app rewrote this\n');
    expect(seen.errors).toEqual([]);
  });

  test("moss's comment composer takes no input while unmount waits for its final write", async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, '# Plan\n\nAlpha beta gamma\n');
    await body(page).getByText('Alpha beta gamma').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' delta');
    await selectWord(page, 'Alpha beta gamma delta', 'beta');
    await page.keyboard.press('ControlOrMeta+Shift+A');
    const input = page.getByRole('textbox', { name: 'comment editor' });
    await expect(input).toBeVisible();
    await input.click();
    // The composer renders in a portal, outside the editor root.
    expect(await input.evaluate((el) => el.closest('[data-moss-editor-root]') === null)).toBe(true);
    await page.evaluate(() => window.editorFixture.delayWrites(4_000));
    const unmounting = page.evaluate(() => window.editorFixture.unmountDetail());
    await expect(page.locator('[data-moss-editor-root]')).toHaveAttribute('inert', '');
    await input.click({ force: true, timeout: 1_000 }).catch(() => undefined);
    await page.keyboard.type('Late comment');
    const typed = await input.evaluate((el) => el.textContent ?? '', undefined, { timeout: 1_000 }).catch(() => '');
    await page.getByRole('button', { name: 'Submit comment' }).click({ force: true, timeout: 1_000 }).catch(() => undefined);
    await frames(page);
    // A comment the UI takes now could never reach the note, so the UI must not take it.
    const marks = await body(page).locator('mark').count();
    const result = await unmounting;
    expect(typed).not.toContain('Late comment');
    expect(marks).toBe(0);
    expect(result).toEqual({ kind: 'unmounted', flush: 'saved', markdown: '# Plan\n\nAlpha beta gamma delta' });
    const written = await files(page);
    expect(written['/Moss/Notes/Plan/Plan.md']).toBe('# Plan\n\nAlpha beta gamma delta');
    expect(written['/Moss/Notes/Plan/comments.json']).toBeUndefined();
    expect(seen.errors).toEqual([]);
  });

  test("a focused, unedited title takes the Mac app's rename, and blurring it writes nothing", async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, '# Plan\n\nIntro\n');
    await title(page).click();
    await page.evaluate((renamed) => {
      window.editorFixture.silentWrite('/Moss/Notes/Plan/meta.json', JSON.stringify(renamed, null, 2));
      window.editorFixture.externalWrite('/Moss/Notes/Plan/Plan.md', '# Q3\n\nIntro\n');
    }, meta('Q3'));
    await expect(title(page)).toHaveText('Q3');
    await body(page).getByText('Intro', { exact: true }).click();
    await page.waitForTimeout(2_500);
    const written = await files(page);
    expect(written['/Moss/Notes/Plan/Plan.md']).toBe('# Q3\n\nIntro\n');
    expect(JSON.parse(written['/Moss/Notes/Plan/meta.json']).title).toBe('Q3');
    expect(await page.evaluate(() => window.editorFixture.events().map((event) => event.kind))).not.toContain('saving');
    expect(await page.evaluate(() => window.editorFixture.status())).toBe('clean');
    expect(seen.errors).toEqual([]);
  });

  test('a remount shows the disk version, never a cached editor state', async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, '# Plan\n\nFirst line\n');
    await body(page).getByText('First line', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    await page.evaluate(() => window.editorFixture.externalWrite('/Moss/Notes/Plan/Plan.md', '# Plan\n\nTheirs from Mac\n'));
    await expect(body(page).getByText('Theirs from Mac')).toBeVisible();
    expect(await page.evaluate(() => window.editorFixture.unmount())).toEqual({ kind: 'unmounted', flush: 'clean' });
    await page.evaluate(() => window.editorFixture.silentWrite('/Moss/Notes/Plan/Plan.md', '# Plan\n\nFirst line\n'));
    expect(await page.evaluate((id) => window.editorFixture.mount(id), ID)).toEqual({ ok: true, status: 'clean' });
    await expect(body(page).getByText('First line', { exact: true })).toBeVisible();
    expect(await body(page).innerText()).not.toContain('mine');
    await body(page).getByText('First line', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    expect((await files(page))['/Moss/Notes/Plan/Plan.md']).toMatch(/^# Plan\n\nFirst line!\n?$/);
    expect(seen.errors).toEqual([]);
  });

  test('pasted media is stored only through the host', async ({ page }) => {
    const seen = await open(page);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await mountNote(page, '# Plan\n\nUploads\n');
    const line = body(page).getByText('Uploads', { exact: true });
    await line.click();
    await page.keyboard.press('End');
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const png = readFileSync(join(MEDIA, 'pattern.png')).toString('base64');
    await body(page).evaluate((root, base64) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'pattern.png', { type: 'image/png' }));
      root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    const image = body(page).locator('img').first();
    await expect(image).toBeVisible({ timeout: 10_000 });
    expect(await image.getAttribute('src')).toMatch(/^blob:/);
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });

    const puts = (await page.evaluate(() => window.editorFixture.calls())).filter((call) => call.op === 'assetPut');
    expect(puts).toHaveLength(1);
    expect(puts[0].name).toMatch(/^pattern-\d+-[0-9a-f]{8}\.png$/);
    const written = await files(page);
    expect(written[`/Moss/Notes/Plan/assets/${puts[0].name}`]).toMatch(/^bytes:\d+$/);
    expect(written['/Moss/Notes/Plan/Plan.md']).toContain(`(assets/${puts[0].name})`);
    // Nothing left the page except the bundle, the fixture and blob: media.
    const outside = requests.filter((url) => !url.startsWith('blob:') && !url.startsWith('data:') && !/^http:\/\/127\.0\.0\.1:\d+\/(editor|fixture|src)\//.test(url));
    expect(outside).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test("media pasted from an editor frame is copied or mapped back through the host, never saved as the host's URL", async ({ page }) => {
    const seen = await open(page);
    const OTHER = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
    const png = readFileSync(join(MEDIA, 'pattern.png')).toString('base64');
    const result = await page.evaluate(
      ({ id, plan, source, png }) => {
        window.editorFixture.reset();
        const dir = window.editorFixture.seed(['Notes', 'Plan'], { markdown: '# Plan\n\nPaste here\n', meta: plan });
        const sourceDir = window.editorFixture.seed(['Notes', 'Source'], { markdown: '# Source\n\n![pattern](assets/pattern.png)\n', meta: source });
        window.editorFixture.seedAsset(dir, 'own.png', png);
        window.editorFixture.seedAsset(sourceDir, 'pattern.png', png);
        return window.editorFixture.mount(id);
      },
      { id: ID, plan: meta('Plan'), source: { ...meta('Source'), id: OTHER }, png },
    );
    expect(result).toEqual({ ok: true, status: 'clean' });
    // The user has the source note open in the host, so the host may copy from it.
    await page.evaluate((other) => window.editorFixture.open(other), OTHER);
    const urls = await page.evaluate(({ id, other }) => ({ own: window.editorFixture.assetUrl(id, 'assets/own.png'), other: window.editorFixture.assetUrl(other, 'assets/pattern.png') }), { id: ID, other: OTHER });
    expect(urls.own).toMatch(/^blob:/);
    expect(urls.other).toMatch(/^blob:/);
    await body(page).getByText('Paste here', { exact: true }).click();
    await page.keyboard.press('End');
    await frames(page);
    await body(page).evaluate((root, { own, other }) => {
      const data = new DataTransfer();
      data.setData('text/html', `<p><img src="${other}" alt="pattern"></p><p><img src="${own}" alt="own"></p>`);
      data.setData('text/plain', '');
      root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, urls);
    await expect(body(page).locator('img')).toHaveCount(2, { timeout: 10_000 });
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const copies = (await page.evaluate(() => window.editorFixture.calls())).filter((call) => call.op === 'assetCopy');
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ sourceNoteId: OTHER, sourceRef: 'assets/pattern.png' });
    expect(copies[0].name).toMatch(/^pattern-\d+-[0-9a-f]{8}\.png$/);
    const written = await files(page);
    const markdown = written['/Moss/Notes/Plan/Plan.md'];
    expect(markdown).not.toContain('blob:');
    expect(markdown).toContain(`(assets/${copies[0].name})`);
    expect(markdown).toContain('(assets/own.png)');
    expect(written[`/Moss/Notes/Plan/assets/${copies[0].name}`]).toMatch(/^bytes:\d+$/);
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test('the demo note in the editor, light and dark', async ({ page }, testInfo) => {
    const seen = await open(page);
    for (const theme of ['light', 'dark'] as const) {
      await mountNote(page, DEMO.startsWith('# ') ? DEMO : `# Demo\n\n${DEMO}`, { theme, title: 'Demo' });
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: testInfo.outputPath(`editor-demo-${theme}.png`), fullPage: false });
      await page.evaluate(() => window.editorFixture.unmount({ discardUnsaved: true }));
    }
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test('advertises selection-1 and share-with-agent-1 in MOSS_EDITOR_INFO, as editor 0.3.0 of API 2', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => window.editorFixture.api)).toBe(2);
    expect(await page.evaluate(() => window.editorFixture.info)).toEqual({ api: 2, version: '0.3.0', features: ['selection-1', 'share-with-agent-1'] });
  });

  test('ruling 21: a moss-html block renders inert until the user presses Run, which lasts while the editor is mounted', async ({ page }) => {
    const seen = await open(page);
    const note = [
      '# Plan',
      '',
      '```moss-html',
      '<style>#out { color: rgb(10, 120, 30); }</style>',
      '<p id="out">inert</p>',
      "<script>document.getElementById('out').textContent = 'ran';</script>",
      '```',
      '',
      'After the block.',
      '',
    ].join('\n');
    await mountNote(page, note);
    // Inert: the HTML and its style render, and no script runs, however long the note stays open.
    await expect(blockIn(page).locator('#out')).toHaveText('inert', { timeout: 10_000 });
    expect(await blockIn(page).locator('#out').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(10, 120, 30)');
    await page.waitForTimeout(1_500);
    await expect(blockIn(page).locator('#out')).toHaveText('inert');
    // Activating the block is not consent either: its interactive frame is inert until Run.
    const viewport = body(page).locator('[data-moss-html-preview-viewport]');
    await viewport.getByRole('button', { name: 'Activate live HTML preview' }).click();
    await expect(blockIn(page, 0, 'interactive').locator('#out')).toHaveText('inert', { timeout: 10_000 });
    await page.waitForTimeout(1_000);
    await expect(blockIn(page, 0, 'interactive').locator('#out')).toHaveText('inert');
    await viewport.frameLocator('iframe[title="HTML preview (interactive)"]').getByRole('button', { name: 'Run' }).click();
    await expect(blockIn(page, 0, 'interactive').locator('#out')).toHaveText('ran', { timeout: 10_000 });
    // The choice lasts for the block while the editor is mounted: deselected, its static frame runs too.
    await body(page).getByText('After the block.', { exact: true }).click();
    await expect(viewport.locator('iframe[title="HTML preview (interactive)"]')).toHaveCount(0);
    await expect(blockIn(page).locator('#out')).toHaveText('ran', { timeout: 10_000 });
    // A new mount starts inert again.
    await page.evaluate(() => window.editorFixture.unmount({ discardUnsaved: true }));
    await mountNote(page, note);
    await expect(blockIn(page).locator('#out')).toHaveText('inert', { timeout: 10_000 });
    await page.waitForTimeout(1_000);
    await expect(blockIn(page).locator('#out')).toHaveText('inert');
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test("ruling 21: Run is the one block's, never a twin's with the same HTML, and its fullscreen view shares it", async ({ page }) => {
    const seen = await open(page);
    const twin = ['```moss-html', '<p id="out">twin: inert</p>', "<script>document.getElementById('out').textContent = 'twin: ran';</script>", '```'];
    const note = ['# Plan', '', ...twin, '', ...twin, '', 'After the blocks.', ''].join('\n');
    await mountNote(page, note);
    const viewports = body(page).locator('[data-moss-html-preview-viewport]');
    await expect(viewports).toHaveCount(2, { timeout: 10_000 });
    await expect(blockIn(page, 1).locator('#out')).toHaveText('twin: inert', { timeout: 10_000 });
    await runBlock(page, 0);
    await expect(blockIn(page, 0, 'interactive').locator('#out')).toHaveText('twin: ran', { timeout: 10_000 });
    // Deselected: block 0's static frame runs, and its twin's stays inert.
    await body(page).getByText('After the blocks.', { exact: true }).click();
    await expect(blockIn(page, 0).locator('#out')).toHaveText('twin: ran', { timeout: 10_000 });
    await page.waitForTimeout(1_000);
    await expect(blockIn(page, 1).locator('#out')).toHaveText('twin: inert');
    // Activating the twin is not Run: its interactive frame stays inert.
    await viewports.nth(1).getByRole('button', { name: 'Activate live HTML preview' }).click();
    await expect(blockIn(page, 1, 'interactive').locator('#out')).toHaveText('twin: inert', { timeout: 10_000 });
    await page.waitForTimeout(1_500);
    await expect(blockIn(page, 1, 'interactive').locator('#out')).toHaveText('twin: inert');
    // The fullscreen view, portalled outside its block, shares the block's choice: the twin's opens inert, and Run
    // pressed there is the twin's Run, so its inline frame runs too.
    const fullscreen = page.frameLocator('iframe[title="HTML preview (fullscreen)"]');
    // Every block shows its own Fullscreen button.
    const blocks = body(page).locator('[data-block-decorator-key]', { has: page.locator('[data-moss-html-preview-viewport]') });
    const press = (button: Locator) => button.evaluate((element: HTMLElement) => element.click());
    await press(blocks.nth(1).getByRole('button', { name: 'Fullscreen' }));
    await expect(fullscreen.frameLocator('iframe').locator('#out')).toHaveText('twin: inert', { timeout: 10_000 });
    await fullscreen.getByRole('button', { name: 'Run' }).click();
    await expect(fullscreen.frameLocator('iframe').locator('#out')).toHaveText('twin: ran', { timeout: 10_000 });
    await expect(blockIn(page, 1, 'interactive').locator('#out')).toHaveText('twin: ran', { timeout: 10_000 });
    await press(page.getByRole('button', { name: 'Close lightbox' }));
    await expect(page.locator('iframe[title="HTML preview (fullscreen)"]')).toHaveCount(0);
    // Block 0's fullscreen view opens running, since block 0 ran.
    await press(blocks.nth(0).getByRole('button', { name: 'Fullscreen' }));
    await expect(fullscreen.frameLocator('iframe').locator('#out')).toHaveText('twin: ran', { timeout: 10_000 });
    await press(page.getByRole('button', { name: 'Close lightbox' }));
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test('API 2: a moss-html block renders and runs in its frame, the policy refuses its requests, and (defense in depth, not a guarantee) the guard holds these WebRTC probes', async ({ page }) => {
    const seen = await open(page);
    const collector = server.collector.url;
    const socket = collector.replace(/^http/, 'ws');
    // A peer connection that gathers ICE candidates against the collector's STUN port: CSP governs none of it. Only
    // the in-realm guard stops these probes, as defense in depth; a running block that tampers with prototypes can
    // get past it, an accepted residual risk (PRODUCT ruling 21, contract.ts htmlFrame).
    const rtc = `try { var pc = new RTCPeerConnection({ iceServers: [{ urls: '${server.collector.stun}' }] }); pc.createDataChannel('x'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {}); } catch (e) {}`;
    const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const child = (script: string) => `<iframe srcdoc="${attr(script)}"></iframe>`;
    const inChild = child(`<script>${rtc}</script>`);
    const note = [
      '# Plan',
      '',
      '```moss-html',
      '<style>#out { color: rgb(10, 120, 30); }</style>',
      '<p id="out">waiting</p>',
      `<img src="${collector}/img" alt="">`,
      `<link rel="stylesheet" href="${collector}/link">`,
      `<iframe src="${collector}/iframe"></iframe>`,
      `<script src="${collector}/script"></script>`,
      // WebRTC in a child frame's own realm: a srcdoc child, a javascript: child, and one inside a closed
      // declarative shadow root.
      inChild,
      `<iframe src="${attr(`javascript:"<script>${rtc}</script>"`)}"></iframe>`,
      `<div><template shadowrootmode="closed">${inChild}</template></div>`,
      '<div id="host"></div>',
      '<script>',
      '  var sent = 0;',
      `  try { fetch('${collector}/fetch').catch(function () {}); sent++; } catch (e) {}`,
      `  try { var xhr = new XMLHttpRequest(); xhr.open('GET', '${collector}/xhr'); xhr.send(); sent++; } catch (e) {}`,
      `  try { new WebSocket('${socket}/socket'); sent++; } catch (e) {}`,
      `  try { navigator.sendBeacon('${collector}/beacon', 'x'); sent++; } catch (e) {}`,
      `  try { new Image().src = '${collector}/image'; sent++; } catch (e) {}`,
      `  ${rtc}`,
      // The same from script: a child frame appended late, one in a closed shadow root, one written with a
      // declarative shadow root.
      `  var late = document.createElement('div'); late.innerHTML = ${JSON.stringify(inChild)}; document.body.appendChild(late);`,
      `  try { document.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(inChild)}; } catch (e) {}`,
      `  document.write(${JSON.stringify(`<div><template shadowrootmode="closed">${inChild}</template></div>`)});`,
      // A clonable shadow root copied by cloneNode or importNode, which never calls attachShadow.
      `  try { var c = document.createElement('div'); var cs = c.attachShadow({ mode: 'closed', clonable: true }); cs.innerHTML = ${JSON.stringify(inChild)}; document.body.appendChild(c.cloneNode(true)); document.body.appendChild(document.importNode(c, true)); } catch (e) {}`,
      // DOMParser asked for declarative shadow roots.
      `  try { var d = new DOMParser().parseFromString(${JSON.stringify(`<div><template shadowrootmode="open">${inChild}</template></div>`)}, 'text/html', { includeShadowRoots: true }); document.body.appendChild(document.adoptNode(d.body.firstChild)); } catch (e) {}`,
      "  document.getElementById('out').textContent = 'ran: ' + sent;",
      '</script>',
      '```',
      '',
    ].join('\n');
    server.collector.hits.length = 0;
    await mountNote(page, note);
    const viewport = body(page).locator('[data-moss-html-preview-viewport]');
    const frame = viewport.locator('iframe[title="HTML preview"]');
    await expect(frame).toHaveCount(1, { timeout: 10_000 });
    await expect(frame).toHaveAttribute('src', '/editor/moss-html-frame.html');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await runBlock(page);
    await page.waitForTimeout(4_000);
    expect(server.collector.hits).toEqual([]);
    // The block still renders and runs, in a sandboxed child of the frame document: its inline style applies and
    // its inline script writes.
    const out = blockIn(page, 0, 'interactive').locator('#out');
    await expect(out).toHaveText(/^ran: \d$/, { timeout: 10_000 });
    expect(await out.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(10, 120, 30)');
    // The host serves the frame document with editor.json's policy: inline scripts and styles, data: and blob:
    // images, and no network at all.
    const policy = framePolicy();
    expect(policy).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
    expect((await page.request.get(`${server.url}/editor/moss-html-frame.html`)).headers()['content-security-policy']).toBe(policy);
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test('API 2: a moss-html block cannot navigate its frame, its parent, the page or a popup to another origin', async ({ page }) => {
    const seen = await open(page);
    const collector = server.collector.url;
    // One block per probe, since a navigation that went through would end the block's document.
    const probes = [
      `<script>location.replace('${collector}/replace');</script>`,
      `<script>location.href = '${collector}/assign';</script>`,
      `<meta http-equiv="refresh" content="0;url=${collector}/refresh">`,
      `<a id="a" href="${collector}/click">go</a><script>document.getElementById('a').click();</script>`,
      `<form id="f" action="${collector}/form"><input name="q" value="1"></form><script>document.getElementById('f').submit();</script>`,
      `<script>try { parent.location = '${collector}/parent'; } catch (e) {}</script>`,
      `<script>try { top.location = '${collector}/top'; } catch (e) {}</script>`,
      `<script>try { open('${collector}/popup'); } catch (e) {}</script>`,
    ];
    const note = ['# Plan', '', ...probes.flatMap((probe) => ['```moss-html', `<p>probe</p>${probe}`, '```', '']).slice(0, -1), ''].join('\n');
    server.collector.hits.length = 0;
    await mountNote(page, note);
    await expect(body(page).locator('[data-moss-html-preview-viewport] iframe')).toHaveCount(probes.length, { timeout: 10_000 });
    for (let index = 0; index < probes.length; index++) await runBlock(page, index);
    await page.waitForTimeout(4_000);
    expect(server.collector.hits).toEqual([]);
    // A frame whose block tried to load another page is torn down, in both of moss's layers.
    await expect(body(page).locator('[data-moss-html-preview-viewport]').first().frameLocator('iframe[title="HTML preview"]').getByText('This block tried to open another page')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`^${server.url}/fixture/`));
    // WebKit reports the sandbox's refusals of the parent and top probes as page errors; those are the refusals
    // asserted here.
    expect(seen.errors.filter((error) => !/The frame attempting navigation (of the top-level window )?is sandboxed/.test(error))).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test('API 2: copyFromNote refuses a source note the user has not opened, and the paste keeps no reference to it', async ({ page }) => {
    const seen = await open(page);
    const OTHER = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
    const png = readFileSync(join(MEDIA, 'pattern.png')).toString('base64');
    const result = await page.evaluate(
      ({ id, plan, source, png }) => {
        window.editorFixture.reset();
        const dir = window.editorFixture.seed(['Notes', 'Plan'], { markdown: '# Plan\n\nPaste here\n', meta: plan });
        const sourceDir = window.editorFixture.seed(['Notes', 'Source'], { markdown: '# Source\n\n![pattern](assets/pattern.png)\n', meta: source });
        window.editorFixture.seedAsset(dir, 'own.png', png);
        window.editorFixture.seedAsset(sourceDir, 'pattern.png', png);
        return window.editorFixture.mount(id);
      },
      { id: ID, plan: meta('Plan'), source: { ...meta('Source'), id: OTHER }, png },
    );
    expect(result).toEqual({ ok: true, status: 'clean' });
    // A host-issued URL for a note the user never opened, as pasted content could carry one.
    const urls = await page.evaluate(({ id, other }) => ({ own: window.editorFixture.assetUrl(id, 'assets/own.png'), other: window.editorFixture.assetUrl(other, 'assets/pattern.png') }), { id: ID, other: OTHER });
    await body(page).getByText('Paste here', { exact: true }).click();
    await page.keyboard.press('End');
    await frames(page);
    await body(page).evaluate((root, { own, other }) => {
      const data = new DataTransfer();
      data.setData('text/html', `<p><img src="${other}" alt="pattern"></p><p><img src="${own}" alt="own"></p>`);
      data.setData('text/plain', '');
      root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, urls);
    await expect.poll(() => page.evaluate(() => window.editorFixture.events().filter((event) => event.kind === 'error').map((event) => event.op))).toEqual(['assetCopy']);
    await expect(body(page).locator('img')).toHaveCount(1, { timeout: 10_000 });
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const copies = (await page.evaluate(() => window.editorFixture.calls())).filter((call) => call.op === 'assetCopy');
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ sourceNoteId: OTHER, sourceRef: 'assets/pattern.png', result: 'refused:sourceNotOpen' });
    const written = await files(page);
    expect(Object.keys(written).filter((path) => path.startsWith('/Moss/Notes/Plan/assets/'))).toEqual(['/Moss/Notes/Plan/assets/own.png']);
    const markdown = written['/Moss/Notes/Plan/Plan.md'];
    expect(markdown).not.toContain('blob:');
    expect(markdown).not.toContain('pattern');
    expect(markdown).toContain('(assets/own.png)');
    expect(seen.errors).toEqual([]);
    expect(await page.evaluate(() => window.editorFixture.violations)).toEqual([]);
  });

  test("API 2: a case-only retitle keeps the markdown entry's spelling, as Moss desktop's save does on APFS", async ({ page }) => {
    const seen = await open(page);
    const result = await page.evaluate(
      ({ id, meta }) => {
        window.editorFixture.reset({ caseInsensitive: true });
        window.editorFixture.seed(['Notes', 'Plan'], { markdown: '# Plan\n\nBody\n', meta });
        return window.editorFixture.mount(id);
      },
      { id: ID, meta: meta('Plan') },
    );
    expect(result).toEqual({ ok: true, status: 'clean' });
    await title(page).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('plan');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const written = await files(page);
    // Desktop's golden (pipeline.golden.test.ts): the folder is renamed and the file replaced in place, so the entry
    // keeps its spelling `Plan.md`.
    expect(Object.keys(written)).toEqual(['/Moss/Notes/plan/Plan.md', '/Moss/Notes/plan/meta.json']);
    expect(written['/Moss/Notes/plan/Plan.md']).toMatch(/^# plan\n\nBody\n?$/);
    expect(JSON.parse(written['/Moss/Notes/plan/meta.json']).title).toBe('plan');
    const saved = (await page.evaluate(() => window.editorFixture.events())).filter((event) => event.kind === 'saved');
    expect(saved.at(-1)?.location).toEqual({ folderPath: 'Notes', folderName: 'plan', markdownName: 'plan.md' });
    expect(seen.errors).toEqual([]);
  });

  test('API 2: an API 1 host (the 0.2.0 host fixture) mounting this bundle gets a typed apiMismatch at mount, and nothing is read or written', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.url}/fixture/api1/index.html`);
    await expect(page.locator('html[data-fixture="ready"]')).toBeAttached();
    const result = await page.evaluate(({ id, note }) => window.api1Fixture.mount(id, note), { id: ID, note: { markdown: '# Plan\n\nBody\n', meta: meta('Plan') } });
    expect(result.host).toEqual({ api: 1, version: '0.2.0', features: ['selection-1', 'share-with-agent-1'] });
    expect(result.editor.api).toBe(2);
    expect(result.ready).toEqual({ ok: false, name: 'MossEditorError', code: 'apiMismatch', message: 'bridge.api is 1; this editor implements API 2' });
    expect(result.status).toBe('notLoaded');
    expect(result.placeholder).toContain('API 2');
    expect(result.events).toEqual([{ kind: 'error', op: 'read', status: 'notLoaded', willRetry: false }]);
    expect(result.calls).toEqual([]);
    expect(result.unchanged).toBe(true);
    expect(result.flush).toEqual({ kind: 'notLoaded' });
    expect(result.unmount).toEqual({ kind: 'unmounted', flush: 'notLoaded' });
    expect(errors).toEqual([]);
  });

  for (const { name, from, to, within, nth, toStart, reversed, expected } of SELECTION_CASES) {
    test(`selection ${name}: exact text, markdown, lines and headings, the lines golden in the saved file`, async ({ page, browserName }) => {
      // WebKit's editable root pulls a DOM range ending inside the code block (contenteditable=false) back to the
      // table before it, so the page's selection is not this case there; the viewer covers it in WebKit.
      test.skip(browserName === 'webkit' && name === 'from a list into a code block', 'WebKit clamps the range out of the code block');
      const seen = await open(page);
      await mountSelectionNote(page);
      if (within === 'code') {
        // Pressing a code block opens its source; the selection is the textarea's.
        await body(page).locator('.moss-codeblock-pre').nth(nth ?? 0).click();
        const source = body(page).locator('textarea.moss-codeblock-textarea');
        await expect(source).toBeFocused();
        await source.evaluate((el: HTMLTextAreaElement, { from, to }) => {
          const start = el.value.indexOf(from);
          el.setSelectionRange(start, el.value.indexOf(to, start) + to.length);
        }, { from, to });
      } else {
        await selectText(page, BODY, from, to, within, 0, { toStart, reversed });
      }
      const selection = await page.evaluate(() => window.editorFixture.selection());
      expect(selection).toEqual(expected);
      expectNoMarker(selection as MossSelection);
      expectLinesIn(await savedSelectionNote(page), selection as MossSelection);
      expect(seen.errors).toEqual([]);
    });
  }

  test('selection lines stay exact after an unsaved edit above the selection', async ({ page }) => {
    const seen = await open(page);
    await mountSelectionNote(page);
    await body(page).getByText('Intro with a').first().click();
    // The caret goes to the intro's end through the DOM selection, which Lexical adopts.
    await body(page).evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node as Text).data.endsWith(' inside.')) return document.getSelection()?.collapse(node, (node as Text).data.length);
      }
      throw new Error('no intro text');
    });
    await frames(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('A new line');
    const [first] = SELECTION_CASES;
    await selectText(page, BODY, first!.from, first!.to);
    const selection = (await page.evaluate(() => window.editorFixture.selection())) as MossSelection;
    expect(selection).toEqual({
      ...first!.expected,
      lines: { start: first!.expected.lines.start + 2, end: first!.expected.lines.end + 2 },
      blocks: first!.expected.blocks.map((block) => ({ ...block, line: block.line + 2 })),
    });
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const written = (await files(page))[`/Moss/Notes/${SELECTION_TITLE}/${SELECTION_TITLE}.md`]!;
    expect(written.split('\n')[4]).toBe('A new line');
    expectLinesIn(written, selection);
    expect(seen.errors).toEqual([]);
  });

  test('selection is null when collapsed or outside the note body', async ({ page }) => {
    await open(page);
    await mountSelectionNote(page);
    expect(await page.evaluate(() => window.editorFixture.selection()), 'nothing selected').toBeNull();
    await collapseIn(page, BODY, 'Sow the beans');
    expect(await page.evaluate(() => window.editorFixture.selection()), 'a caret').toBeNull();
    await selectText(page, '[data-moss-editor-title]', 'Field', 'Notes');
    expect(await page.evaluate(() => window.editorFixture.selection()), 'the title is not the body').toBeNull();
  });

  test('a mouse drag across table cells is the selection after mouseup, and Share with Agent hands it over', async ({ page }) => {
    const seen = await open(page);
    await mountSelectionNote(page, { share: true });
    const table = SELECTION_CASES.find((entry) => entry.name === 'inside a table')!;
    const cell = (text: string) => body(page).locator('td, th').filter({ hasText: new RegExp(`^${text}$`) }).first();
    const from = (await cell(table.from).boundingBox())!;
    const to = (await cell(table.to).boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await frames(page);
    expect(await page.evaluate(() => window.editorFixture.selection()), 'after mouseup').toEqual(table.expected);
    await page.locator(SHARE).click();
    await expect.poll(() => page.evaluate(() => window.editorFixture.shared())).toEqual([table.expected]);
    expect(seen.errors).toEqual([]);
  });

  test('a selection in a code block being edited names the edited code, the lines it will be saved on', async ({ page }) => {
    const seen = await open(page);
    await mountSelectionNote(page, { share: true });
    await body(page).locator('.moss-codeblock-pre').first().click();
    const source = body(page).locator('textarea.moss-codeblock-textarea');
    await expect(source).toBeFocused();
    await source.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.type('\n    # sown');
    await source.evaluate((el: HTMLTextAreaElement) => {
      const start = el.value.indexOf('return');
      el.setSelectionRange(start, el.value.length);
    });
    const expected: MossSelection = {
      text: 'return crop\n    # sown',
      markdown: '    return crop\n    # sown',
      lines: { start: 21, end: 22 },
      headings: ['Planting'],
      blocks: [{ type: 'code-block', line: 19, heading: 'Planting' }],
    };
    expect(await page.evaluate(() => window.editorFixture.selection())).toEqual(expected);
    await page.locator(SHARE).click();
    await expect.poll(() => page.evaluate(() => window.editorFixture.shared())).toEqual([expected]);
    // Once the edit is committed and saved, those lines are the selection's markdown.
    await source.evaluate((el: HTMLTextAreaElement) => el.blur());
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    expectLinesIn((await files(page))[`/Moss/Notes/${SELECTION_TITLE}/${SELECTION_TITLE}.md`]!, expected);
    expect(seen.errors).toEqual([]);
  });

  test('a shareWithAgent that throws or rejects stays the host\'s: no page error, and the button keeps working', async ({ page }) => {
    const seen = await open(page);
    await mountSelectionNote(page, { share: 'fail' });
    const [first] = SELECTION_CASES;
    await selectText(page, BODY, first!.from, first!.to);
    const button = page.locator(SHARE);
    await button.click();
    await button.click();
    await expect.poll(() => page.evaluate(() => window.editorFixture.shared())).toEqual([first!.expected, first!.expected]);
    await page.evaluate(() => new Promise((done) => setTimeout(done, 100)));
    expect(seen.errors).toEqual([]);
  });

  test('Share with Agent shows only with services.shareWithAgent, and a press hands it the selection', async ({ page }) => {
    await open(page);
    await mountSelectionNote(page);
    await expect(page.locator(SHARE), 'hidden without the service').toHaveCount(0);
    await page.evaluate(() => window.editorFixture.unmount({ discardUnsaved: true }));

    await mountSelectionNote(page, { share: true });
    const button = page.locator(SHARE);
    await expect(button).toBeVisible();
    await expect(button).toHaveText('Share with Agent');
    const [first] = SELECTION_CASES;
    await selectText(page, BODY, first!.from, first!.to);
    await button.click();
    await expect.poll(() => page.evaluate(() => window.editorFixture.shared())).toEqual([first!.expected]);
  });
});

// T3.13: a decorator's open draft survives unmount, and typing after a slash-menu chart lands after it.
test.describe('editor fixes before 0.3.0', () => {
  const CHART = '```moss-chart\n{"type":"bar","title":"Draft","data":[{"label":"A","value":3},{"label":"B","value":5}]}\n```';
  const HTML = '```moss-html\n<p>Saved HTML.</p>\n```';

  test('a chart JSON draft and an HTML source draft left open at unmount are in the final write, frozen while it waits', async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, `# Plan\n\nFirst line\n\n${CHART}\n\n${HTML}\n`);
    await expect(body(page).locator('.recharts-surface')).toHaveCount(1);
    // The chart's JSON editor and the HTML block's source, changed without pressing Apply or Done.
    await body(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await body(page).locator('textarea').first().fill('{"type":"bar","title":"Edited","data":[{"label":"A","value":9}]}');
    // moss's preview layer covers the block's header buttons until hover, so the press goes to the button itself.
    await body(page).getByRole('button', { name: 'Edit HTML' }).dispatchEvent('click');
    await expect(body(page).locator('textarea')).toHaveCount(2);
    await body(page).locator('textarea').last().fill('<p>HTML draft.</p>');
    await page.evaluate(() => window.editorFixture.delayWrites(1_500));
    const unmounting = page.evaluate(() => window.editorFixture.unmountDetail());
    await expect(page.locator('[data-moss-editor-root]')).toHaveAttribute('inert', '');
    const result = await unmounting;
    expect(result.kind).toBe('unmounted');
    expect(result.flush).toBe('saved');
    const written = (await files(page))['/Moss/Notes/Plan/Plan.md'];
    expect(written, 'the chart draft is written').toContain('"title": "Edited"');
    expect(written, 'the HTML draft is written').toContain('<p>HTML draft.</p>');
    expect(result.markdown).toBe(written);
    expect(seen.errors).toEqual([]);
  });

  const slashChart = async (page: Page, { behind = false } = {}) => {
    await mountNote(page, '# Plan\n\nFirst line\n');
    await body(page).getByText('First line').click();
    // The caret at the end of the line (End is not a line end in every engine).
    await body(page).evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node as Text).data === 'First line') return document.getSelection()?.collapse(node, (node as Text).data.length);
      }
      throw new Error('no First line');
    });
    await frames(page);
    await page.keyboard.press('Enter');
    if (behind) {
      // The menu lists every command. Then, as on a busy main thread (j11's flake), the search for "bar" runs but
      // React has not yet committed its results: zero-delay timers are held while typing, then run with React's
      // scheduler (MessagePort) held, so the menu still shows the list for "/" when Enter comes.
      await page.keyboard.type('/');
      await expect(page.locator('button[data-index]').first()).toBeVisible();
      await page.evaluate(() => {
        const w = window as unknown as { held: { timers: (() => void)[]; messages: (() => void)[] }; realSetTimeout: typeof setTimeout; realPost: MessagePort['postMessage'] };
        w.held = { timers: [], messages: [] };
        w.realSetTimeout = window.setTimeout;
        w.realPost = MessagePort.prototype.postMessage;
        window.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
          if (ms) return w.realSetTimeout(fn, ms, ...args);
          w.held.timers.push(() => fn(...args));
          return 0;
        }) as typeof setTimeout;
      });
      await page.keyboard.type('bar');
      await frames(page);
      await page.evaluate(async () => {
        const w = window as unknown as { held: { timers: (() => void)[]; messages: (() => void)[] }; realSetTimeout: typeof setTimeout; realPost: MessagePort['postMessage'] };
        MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
          w.held.messages.push(() => (w.realPost as (...a: unknown[]) => void).apply(this, args));
        } as MessagePort['postMessage'];
        window.setTimeout = w.realSetTimeout;
        for (const run of w.held.timers.splice(0)) run();
        await Promise.resolve();
      });
      await frames(page);
      await expect(page.locator('button[data-index="0"]'), 'the menu still shows the search for "/"').not.toContainText('Bar Chart');
      await page.keyboard.press('Enter');
      await page.evaluate(() => {
        const w = window as unknown as { held: { messages: (() => void)[] }; realPost: MessagePort['postMessage'] };
        MessagePort.prototype.postMessage = w.realPost;
        for (const post of w.held.messages.splice(0)) post();
      });
    } else {
      await page.keyboard.type('/bar');
      await expect(page.getByText('Bar Chart', { exact: true })).toBeVisible();
      await page.keyboard.press('Enter');
    }
    await expect(body(page).locator('.recharts-surface')).toHaveCount(1);
  };
  const AFTER_CHART = (text: string) => new RegExp(`^# Plan\\n\\nFirst line\\n\\n\`\`\`moss-chart\\n[\\s\\S]*\\n\`\`\`\\n\\n${text}\\n?$`);

  test('typing after inserting a chart from the slash menu lands after the chart, in order', async ({ page }) => {
    const seen = await open(page);
    await slashChart(page);
    await page.keyboard.type('abc');
    await frames(page);
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const written = (await files(page))['/Moss/Notes/Plan/Plan.md'];
    expect(written).toMatch(AFTER_CHART('abc'));
    expect(seen.errors).toEqual([]);
  });

  test('Enter in the slash menu runs the command for the whole query, even before the menu\'s search catches up', async ({ page }) => {
    const seen = await open(page);
    await slashChart(page, { behind: true });
    await expect(body(page).locator('table'), 'no command from the stale list ran').toHaveCount(0);
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const written = (await files(page))['/Moss/Notes/Plan/Plan.md'];
    expect(written).toMatch(/^# Plan\n\nFirst line\n\n```moss-chart\n/);
    expect(written, 'no table was inserted').not.toContain('|');
    expect(seen.errors).toEqual([]);
  });

  test('an IME or dead-key composition after a slash-menu chart lands after the chart', async ({ page, browserName }) => {
    const seen = await open(page);
    await slashChart(page);
    if (browserName === 'chromium') {
      // A real composition, as an IME (or a macOS dead key) drives it: no keydown Lexical acts on, no insertText beforeinput.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
      await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
      await cdp.send('Input.insertText', { text: '日本' });
      await frames(page);
      expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
      expect((await files(page))['/Moss/Notes/Plan/Plan.md']).toMatch(AFTER_CHART('日本'));
    } else {
      // Playwright drives no IME in WebKit: start the composition on the root as the engine does, and check the caret is
      // in a new paragraph below the chart, where the engine then composes.
      await body(page).evaluate((root) => root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
      await frames(page);
      const caret = await body(page).evaluate((root) => {
        let block = document.getSelection()?.anchorNode ?? null;
        while (block && block.parentNode !== root) block = block.parentNode;
        const element = block instanceof Element ? block : null;
        return { tag: element?.tagName ?? null, afterChart: Boolean(element?.previousElementSibling?.querySelector('.recharts-surface')) };
      });
      expect(caret).toEqual({ tag: 'P', afterChart: true });
    }
    expect(seen.errors).toEqual([]);
  });
});

test.describe('desktop editor session commit and naming', () => {
  test("legacy comment colors hydrate as their comments' source colors and are saved that way, through a meta.json refresh", async ({ page }) => {
    const seen = await open(page);
    const at = 1_780_000_300;
    const comments = JSON.stringify({
      a: { text: 'Mine', createdAt: at, updatedAt: at, source: 'user' },
      b: { text: 'From the agent', createdAt: at + 1, updatedAt: at + 1, source: 'agent' },
    });
    const markdown = '# Plan\n\nAlpha %%m:a:start%%beta%%m:a:end%% gamma %%m:b:start%%delta%%m:b:end%%\n';
    const result = await page.evaluate(
      ({ id, markdown, meta, comments }) => {
        window.editorFixture.reset();
        window.editorFixture.seed(['Notes', 'Plan'], { markdown, meta, comments });
        return window.editorFixture.mount(id);
      },
      { id: ID, markdown, meta: { ...meta('Plan'), commentColors: { a: 1, b: 0 } }, comments },
    );
    expect(result).toEqual({ ok: true, status: 'clean' });
    await expect(body(page).locator('mark')).toHaveCount(2);
    // Moss rewrites meta.json alone, with other legacy colors; the editor takes the new baseline.
    await page.evaluate((next) => window.editorFixture.externalWrite('/Moss/Notes/Plan/meta.json', JSON.stringify(next, null, 2)), { ...meta('Plan'), commentColors: { a: 2, b: 2 } });
    await expect.poll(() => page.evaluate(() => window.editorFixture.calls().filter((call) => call.op === 'read').length)).toBeGreaterThan(1);
    await body(page).getByText('Alpha', { exact: false }).first().click();
    await page.keyboard.press('Home');
    await page.keyboard.type('Edited ');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const written = await files(page);
    expect(written['/Moss/Notes/Plan/Plan.md']).toMatch(/^# Plan\n\nEdited Alpha %%m:a:start%%beta%%m:a:end%% gamma %%m:b:start%%delta%%m:b:end%%\n?$/);
    expect(JSON.parse(written['/Moss/Notes/Plan/meta.json']).commentColors).toEqual({ a: 0, b: 3 });
    expect(seen.errors).toEqual([]);
  });
});

// T3.B18: a draft in a focused source field (an HTML block's, a code block's inside a tab panel) is in the export a
// selection reads, without a blur; and a real mouse drag from a list into a code block reads what the engine selects.
test.describe('selection across blocks', () => {
  const DRAFTS = 'Drafts';
  const DRAFT_NOTE = [
    `# ${DRAFTS}`,
    '',
    'Intro.',
    '',
    '```moss-html',
    '<p>Hello</p>',
    '```',
    '',
    ':::tabs',
    '=== Code',
    '```javascript',
    'let a = 1;',
    'let b = 2;',
    '```',
    '',
    '=== Text',
    'Plain words.',
    '',
    ':::',
    '',
    '',
    'Outro.',
    '',
  ].join('\n');
  const lineOf = (file: string, text: string) => file.split('\n').indexOf(text) + 1;
  const written = async (page: Page) => (await files(page))[`/Moss/Notes/${DRAFTS}/${DRAFTS}.md`]!;

  test("a selection in an HTML block's uncommitted source names the draft and the lines it is saved on", async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, DRAFT_NOTE, { title: DRAFTS });
    await body(page).locator('[data-moss-html-preview-viewport]').first().hover();
    await body(page).getByTitle('Edit HTML').first().click();
    const source = body(page).locator('textarea.moss-codeblock-textarea');
    await expect(source).toBeFocused();
    await source.evaluate((el: HTMLTextAreaElement) => {
      const at = el.value.indexOf('<p>Hello</p>') + '<p>Hello</p>'.length;
      el.setSelectionRange(at, at);
    });
    await page.keyboard.type('\n<p>Draft line</p>');
    await source.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.indexOf('Hello'), el.value.indexOf('Draft line') + 'Draft line'.length));
    const selection = (await page.evaluate(() => window.editorFixture.selection())) as MossSelection;
    await page.keyboard.press('ControlOrMeta+Enter');
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const file = await written(page);
    expect(selection).toEqual({
      text: 'Hello</p>\n<p>Draft line',
      markdown: '<p>Hello</p>\n<p>Draft line</p>',
      lines: { start: lineOf(file, '<p>Hello</p>'), end: lineOf(file, '<p>Draft line</p>') },
      headings: [],
      blocks: [{ type: 'html-block', line: lineOf(file, '```moss-html') }],
    });
    expectLinesIn(file, selection);
    expect(seen.errors).toEqual([]);
  });

  test('a selection in a tab panel\'s code block being edited names the draft and the lines it is saved on', async ({ page }) => {
    const seen = await open(page);
    await mountNote(page, DRAFT_NOTE, { title: DRAFTS });
    await body(page).locator('.moss-codeblock-pre').first().click();
    const source = body(page).locator('textarea.moss-codeblock-textarea');
    await expect(source).toBeFocused();
    await source.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.type('\nlet c = 3;');
    await source.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.indexOf('b = 2'), el.value.indexOf('c = 3') + 'c = 3'.length));
    const selection = (await page.evaluate(() => window.editorFixture.selection())) as MossSelection;
    await source.evaluate((el: HTMLTextAreaElement) => el.blur());
    expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
    const file = await written(page);
    expect(selection).toEqual({
      text: 'b = 2;\nlet c = 3',
      markdown: 'let b = 2;\nlet c = 3;',
      lines: { start: lineOf(file, 'let b = 2;'), end: lineOf(file, 'let c = 3;') },
      headings: [],
      blocks: [{ type: 'tab-group', line: lineOf(file, ':::tabs') }],
    });
    expectLinesIn(file, selection);
    expect(seen.errors).toEqual([]);
  });

  test('a real mouse drag from a list into a code block exports only what the engine selected, in both engines', async ({ page }) => {
    const seen = await open(page);
    await mountSelectionNote(page);
    const at = (which: 'start' | 'end') =>
      body(page).evaluate((root, which) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const code = root.querySelector('.moss-codeblock-code');
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node as Text;
          const inCode = !!code?.contains(text);
          const index = which === 'start' ? (inCode ? -1 : text.data.indexOf('Third item')) : inCode ? text.data.indexOf('crop') : -1;
          if (index < 0) continue;
          const range = document.createRange();
          // The first character of "Third item", or the last of the first "crop" in the code.
          const char = which === 'start' ? index : index + 3;
          range.setStart(text, char);
          range.setEnd(text, char + 1);
          const rect = range.getBoundingClientRect();
          return { x: which === 'start' ? rect.left + 1 : rect.right - 1, y: rect.top + rect.height / 2 };
        }
        throw new Error(`no ${which} point`);
      }, which);
    const from = await at('start');
    const to = await at('end');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await frames(page);
    // What both engines make: the selection stops at the code block's edge (contenteditable=false), none of its code in
    // it, where a programmatic range ending in the code (the case above) stays in Chromium.
    const made = await body(page).evaluate((root) => {
      const range = document.getSelection()!.getRangeAt(0);
      const block = [...root.children].find((child) => child.querySelector('.moss-codeblock-code'))!;
      const before = document.createRange();
      before.setStart(block, 0);
      before.setEnd(range.endContainer, range.endOffset);
      return {
        start: (range.startContainer.textContent ?? '').slice(range.startOffset),
        atCodeStart: block.contains(range.endContainer) && before.toString() === '',
        page: document.getSelection()!.toString(),
      };
    });
    expect(made.start, `the drag starts at "Third item" (${JSON.stringify(made)})`).toBe('Third item');
    expect(made.atCodeStart, `the drag ends at the code block's start (${JSON.stringify(made)})`).toBe(true);
    const selection = (await page.evaluate(() => window.editorFixture.selection())) as MossSelection;
    // None of the code is selected, so none of it is exported.
    expect(selection).toEqual({
      text: 'Third item\nCrop\tWeeks\nBeans\t8\nPeas\t10',
      markdown: '- Third item\n\n| Crop | Weeks |\n| --- | --- |\n| Beans | 8 |\n| Peas | 10 |',
      lines: { start: 12, end: 17 },
      headings: ['Planting'],
      blocks: [
        { type: 'list', line: 9, heading: 'Planting' },
        { type: 'table', line: 14, heading: 'Planting' },
      ],
    });
    expectLinesIn(await savedSelectionNote(page), selection);
    expect(seen.errors).toEqual([]);
  });
});

const BODY = '[data-moss-editor] [data-moss-note-editor-root="true"]';
const SHARE = 'button[aria-label="Share with Agent"]';

function mountSelectionNote(page: Page, options: { share?: boolean | 'fail' } = {}) {
  return mountNote(page, SELECTION_NOTE, { title: SELECTION_TITLE, comments: SELECTION_COMMENTS, ...options });
}

/** The note as a save writes it (a retitle makes the editor write the whole file), with the original title line. */
async function savedSelectionNote(page: Page): Promise<string> {
  await title(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await page.evaluate(() => window.editorFixture.flush())).toMatchObject({ kind: 'saved' });
  const written = (await files(page))[`/Moss/Notes/${SELECTION_TITLE}!/${SELECTION_TITLE}!.md`];
  expect(written, 'the retitled note is written').toBeDefined();
  // The export is the fixture itself: moss writes the note back byte for byte.
  expect(written!.replace(/\n$/, '')).toBe(SELECTION_NOTE.replace(`# ${SELECTION_TITLE}`, `# ${SELECTION_TITLE}!`));
  return written!;
}
