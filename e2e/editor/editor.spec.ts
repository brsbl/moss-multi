// T3.9 embeddable editor acceptance: the built bundle (packages/editor/dist) mounts moss's own editor, editable,
// on a note in a fixture host's in-memory Moss workspace, under the editor's own CSP. Every node family saves
// byte-identically to T0.6's goldens; Cmd+Shift+A lands a comment as a `%%m:` marker plus a comments.json entry
// that desktop's reader takes back; an external change reloads a clean editor and a stale write is refused with
// "Changed in Moss"; pasted media goes only through the host; and the editor is shot in light and dark.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { serveEditor, type EditorServer } from './server.ts';

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
  violations: string[];
  reset(options?: { caseInsensitive?: boolean }): void;
  seed(segments: string[], note: { markdown: string; meta: object; comments?: string | null; layout?: string | null }): string;
  seedAsset(dir: string, name: string, base64: string): void;
  mount(noteId: string, options?: { theme?: 'light' | 'dark' }): Promise<{ ok: boolean; code?: string; status: string }>;
  setTheme(theme: 'light' | 'dark'): void;
  flush(): Promise<{ kind: string }>;
  unmount(options?: { discardUnsaved?: boolean }): Promise<{ kind: string; flush: string }>;
  status(): string | null;
  events(): { kind: string; cause?: string; status?: string }[];
  files(under?: string): Record<string, string>;
  externalWrite(path: string, text: string): void;
  silentWrite(path: string, text: string): void;
  calls(): { op: string; name?: string; ops?: string[] }[];
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

async function mountNote(page: Page, markdown: string, options: { comments?: string | null; theme?: 'light' | 'dark'; title?: string } = {}) {
  const noteTitle = options.title ?? 'Plan';
  const result = await page.evaluate(
    ({ id, markdown, meta, comments, theme, noteTitle }) => {
      window.editorFixture.reset();
      window.editorFixture.seed(['Notes', noteTitle], { markdown, meta, comments });
      return window.editorFixture.mount(id, { theme });
    },
    { id: ID, markdown, meta: meta(noteTitle), comments: options.comments ?? null, theme: options.theme ?? 'light', noteTitle },
  );
  expect(result, 'the note mounts').toEqual({ ok: true, status: 'clean' });
  await expect(page.locator('[data-moss-editor][data-moss-editor-status="clean"]')).toBeVisible();
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
const mintedIds = (markdown: string, source: string) =>
  markdown.replace(/\bid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g, (match, id: string) => (source.includes(id) ? match : 'id=<minted>'));

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
    expect(await page.evaluate(() => window.editorFixture.events().map((event) => `${event.kind}:${event.cause ?? ''}`))).toContain('reloaded:external');

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
});
