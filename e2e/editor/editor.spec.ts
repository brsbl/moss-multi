// T3.9 embeddable editor acceptance: the built bundle (packages/editor/dist) mounts moss's own editor, editable,
// on a note in a fixture host's in-memory Moss workspace, under the editor's own CSP. Every node family saves
// byte-identically to T0.6's goldens; Cmd+Shift+A lands a comment as a `%%m:` marker plus a comments.json entry
// that desktop's reader takes back; an external change reloads a clean editor and a stale write is refused with
// "Changed in Moss"; pasted media goes only through the host; and the editor is shot in light and dark.
// T3.10 (editor 0.2.0): `selection()` (feature `selection-1`) with lines golden-compared against the file a save
// writes, exact after an unsaved edit, and moss's Share with Agent button only with services.shareWithAgent.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { serveEditor, type EditorServer } from './server.ts';
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
  seed(segments: string[], note: { markdown: string; meta: object; comments?: string | null; layout?: string | null }): string;
  seedAsset(dir: string, name: string, base64: string): void;
  mount(noteId: string, options?: { theme?: 'light' | 'dark'; share?: boolean }): Promise<{ ok: boolean; code?: string; status: string }>;
  setTheme(theme: 'light' | 'dark'): void;
  flush(): Promise<{ kind: string }>;
  unmount(options?: { discardUnsaved?: boolean }): Promise<{ kind: string; flush: string }>;
  unmountDetail(options?: { discardUnsaved?: boolean }): Promise<{ kind: string; flush: string; markdown: string | null }>;
  delayWrites(ms: number): void;
  status(): string | null;
  events(): { kind: string; cause?: string; status?: string }[];
  files(under?: string): Record<string, string>;
  externalWrite(path: string, text: string): void;
  silentWrite(path: string, text: string): void;
  calls(): { op: string; name?: string; ops?: string[]; sourceNoteId?: string; sourceRef?: string }[];
  assetUrl(noteId: string, ref: string): string | null;
}

declare global {
  interface Window {
    editorFixture: Fixture;
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

async function mountNote(page: Page, markdown: string, options: { comments?: string | null; theme?: 'light' | 'dark'; title?: string; share?: boolean } = {}) {
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

  test('advertises selection-1 and share-with-agent-1 in MOSS_EDITOR_INFO, as editor 0.2.0 of API 1', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => window.editorFixture.info)).toEqual({ api: 1, version: '0.2.0', features: ['selection-1', 'share-with-agent-1'] });
  });

  for (const { name, from, to, within, expected } of SELECTION_CASES) {
    test(`selection ${name}: exact text, markdown, lines and headings, the lines golden in the saved file`, async ({ page }) => {
      const seen = await open(page);
      await mountSelectionNote(page);
      if (within === 'code') {
        // Pressing a code block opens its source; the selection is the textarea's.
        await body(page).locator('.moss-codeblock-pre').click();
        const source = body(page).locator('textarea.moss-codeblock-textarea');
        await expect(source).toBeFocused();
        await source.evaluate((el: HTMLTextAreaElement, { from, to }) => {
          const start = el.value.indexOf(from);
          el.setSelectionRange(start, el.value.indexOf(to, start) + to.length);
        }, { from, to });
      } else {
        await selectText(page, BODY, from, to, within);
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

const BODY = '[data-moss-editor] [data-moss-note-editor-root="true"]';
const SHARE = 'button[aria-label="Share with Agent"]';

function mountSelectionNote(page: Page, options: { share?: boolean } = {}) {
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
