// T3.12 editor load performance. The built bundle's entry script is at most 350 KB gzip and editor.json names every
// chunk a host must serve; a small plain note and a typical note (a table and a code block) are editable within 1 s
// of navigation with a warm cache, in both engines, served as editor-embed.md §13 asks of a host; the heavy node
// families (charts, the canvas, HTML blocks) load only once a note uses them, and render with no console errors. Every
// run records, per engine, cold and warm: script bytes, when the bundle evaluated, first content paint, editable and
// the bridge calls before ready, plus what a slow bridge and an uncached package cost (test-results/load/*.json).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { EDITOR_DIST, serveEditor, type EditorServer } from './server.ts';
import { coldAndWarm, collect, loadNotes, meta, report, warmMarks, type LoadNote, type LoadRun } from '../lib/load-timing.ts';

const ENTRY_GZIP_BUDGET = 350 * 1024;
/** What both engines log for moss's static HTML preview, a sandboxed srcdoc frame that runs no script until Run. */
const INERT_FRAME = /Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/;
const EDITABLE_BUDGET_MS = 1_000;
const DEMO = readFileSync(new URL('../fixtures/demo-note.md', import.meta.url), 'utf8');
const NOTES = loadNotes(DEMO);
const CONTEXT = { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' as const };
/** The node families that load on first use, by the chunk each one's view lives in. */
const LAZY_FAMILIES = [
  { family: 'chart', chunk: /chart/i, markdown: '```moss-chart\n{"type":"bar","title":"Lazy","data":[{"label":"A","value":3},{"label":"B","value":5}]}\n```', rendered: '.recharts-surface' },
  { family: 'canvas', chunk: /canvas|sketch/i, markdown: '```moss-canvas\n[moss:grid:v2]\n..##..\n```', rendered: 'canvas' },
  { family: 'HTML block', chunk: /html/i, markdown: '```moss-html\n<p>Lazy HTML.</p>\n```', rendered: '[data-moss-html-preview-viewport]' },
];

interface Manifest {
  entry: string;
  hostEntry: string;
  files: Record<string, { bytes: number; sha256: string }>;
  chunks?: string[];
  preload?: string[];
}

/** The part of e2e/editor/fixture/fixture.js this spec drives. */
interface Fixture {
  violations: string[];
  reset(): void;
  seed(segments: string[], note: { markdown: string; meta: object }): string;
  mount(noteId: string): Promise<{ ok: boolean; status: string }>;
  flush(): Promise<{ kind: string }>;
  unmount(options?: object): Promise<{ kind: string; flush: string }>;
  status(): string | null;
  events(): { kind: string }[];
  files(): Record<string, string>;
  externalWrite(path: string, text: string): void;
}

type FixtureWindow = Window & { editorFixture: Fixture };

const manifest = (): Manifest => JSON.parse(readFileSync(join(EDITOR_DIST, 'editor.json'), 'utf8')) as Manifest;
const gzip = (file: string) => gzipSync(readFileSync(join(EDITOR_DIST, file)), { level: 9 }).length;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

let server: EditorServer;

test.beforeAll(async () => {
  server = await serveEditor();
});

test.afterAll(async () => {
  await server?.close();
});

async function loadOnce(page: Page, note: LoadNote, options: { latency?: number; settleMs?: number } = {}): Promise<LoadRun> {
  const consoleErrors: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === 'error' && !INERT_FRAME.test(message.text())) consoleErrors.push(message.text());
  };
  page.on('console', onConsole);
  const spec = { title: note.title, markdown: note.markdown, meta: meta(note.title), probe: note.probe, latency: options.latency ?? 0 };
  await page.addInitScript((value) => {
    (window as unknown as { __load: unknown }).__load = value;
  }, spec);
  const served = server.served.length;
  await page.goto(`${server.url}/fixture/load.html`);
  const run = await collect(page, 'loadResult');
  // The caret is in the body: typing lands there.
  await page.keyboard.type(' typed');
  await expect(page.locator('[data-moss-editor] [data-moss-note-editor-root="true"]')).toContainText(`${note.probe} typed`);
  run.marks.typed = await page.evaluate(() => (window as unknown as { loadResult: LoadRun }).loadResult.marks.typed);
  run.typed = Number.isFinite(run.marks.typed);
  if (options.settleMs) {
    await page.waitForTimeout(options.settleMs);
    run.settledBlocks = await page.evaluate(() => (window as unknown as { settledBlocks(): LoadRun['paintBlocks'] }).settledBlocks());
  }
  await page.evaluate(() => (window as unknown as { loadHandle: { unmount(options: object): Promise<unknown> } }).loadHandle.unmount({ discardUnsaved: true }));
  run.served = server.served.slice(served);
  run.errors.push(...consoleErrors);
  page.off('console', onConsole);
  return run;
}

const ms = (value: number | undefined) => String(Number.isFinite(value) ? Math.round(value as number) : '-').padStart(5);
const row = (label: string, marks: Record<string, number>, run: LoadRun) =>
  `${label.padEnd(30)} imported ${ms(marks.imported)}  mount ${ms(marks.mount)}  paint ${ms(marks.paint)}  ready ${ms(marks.ready)}  editable ${ms(marks.editable)}  typed ${ms(marks.typed)}  bridge ${run.readyBridgeCalls ?? '?'}  fetched ${kb((run.served ?? []).reduce((total, entry) => total + entry.bytes, 0))}`;

test('the entry script is at most 350 KB gzip and editor.json names every chunk and the critical ones to preload', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'one engine checks the built files');
  const built = manifest();
  const scripts = readdirSync(EDITOR_DIST, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.js'))
    .sort();
  const sizes = Object.fromEntries(scripts.map((file) => [file, { bytes: readFileSync(join(EDITOR_DIST, file)).length, gzip: gzip(file) }]));
  report(testInfo, 'editor-bundle.json', sizes, ['editor bundle:', ...Object.entries(sizes).map(([file, size]) => `  ${file}: ${kb(size.bytes)}, ${kb(size.gzip)} gzip`)]);
  const files = readdirSync(EDITOR_DIST, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'editor.json')
    .map((entry) => join(entry.parentPath, entry.name).slice(EDITOR_DIST.length + 1))
    .sort();
  expect(Object.keys(built.files).sort(), 'editor.json lists every file in the package').toEqual(files);
  expect(built.chunks, 'editor.json names every script chunk besides the entry and the host helpers').toEqual(scripts.filter((file) => file !== built.entry && file !== built.hostEntry));
  expect(built.preload, 'editor.json names the chunks the entry imports statically').toBeDefined();
  for (const file of built.preload ?? []) expect(built.chunks).toContain(file);
  expect(sizes[built.entry].gzip, `the entry ${built.entry} is ${kb(sizes[built.entry].gzip)} gzip`).toBeLessThanOrEqual(ENTRY_GZIP_BUDGET);
});

test('load timing: plain and typical notes are editable within 1 s warm; cold, warm and every-family runs are recorded', async ({ browser, browserName }, testInfo) => {
  test.setTimeout(300_000);
  server.cache = 'host';
  const results: Record<string, { cold: LoadRun; warm: LoadRun[]; warmMarks: Record<string, number> }> = {};
  const table = [`editor load, ${browserName} (ms since navigation start; warm = median of the warm runs):`];
  try {
    for (const note of NOTES) {
      const { cold, warm } = await coldAndWarm(browser, (page) => loadOnce(page, note, { settleMs: note.key === 'all' ? 1_500 : 0 }), CONTEXT);
      const marks = warmMarks(warm);
      results[note.key] = { cold, warm, warmMarks: marks };
      table.push(row(`${note.key} cold`, cold.marks, cold), row(`${note.key} warm`, marks, warm[warm.length - 1]));
    }
  } finally {
    server.cache = 'no-store';
  }
  const heights = (blocks: LoadRun['paintBlocks']) => (blocks ?? []).map((block) => block.height).join(' ');
  for (const [label, run] of [['all cold', results.all.cold], ['all warm', results.all.warm[results.all.warm.length - 1]]] as const) {
    table.push(`${label}: block heights at first paint ${heights(run.paintBlocks)}; settled ${heights(run.settledBlocks)}`);
  }
  report(testInfo, `editor-load-${browserName}.json`, results, table);
  for (const [key, { cold, warm }] of Object.entries(results)) {
    for (const run of [cold, ...warm]) {
      expect(run.errors, `${key}: no errors`).toEqual([]);
      expect(run.editable && run.typed, `${key}: the caret is placeable and typing lands`).toBe(true);
    }
  }
  for (const run of [results.all.cold, ...results.all.warm]) {
    expect(run.paintBlocks?.map((block) => block.height), 'every-family note: no block changes height after the first paint').toEqual(run.settledBlocks?.map((block) => block.height));
  }
  for (const key of ['plain', 'typical']) {
    const fonts = [results[key].cold, ...results[key].warm].flatMap((run) => run.resources.filter((resource) => /\.woff2?$/.test(resource.name)).map((resource) => resource.name));
    expect(fonts.filter((font) => /cyrillic|greek|vietnamese|latin-ext/.test(font)), `${key}: only latin font subsets load for latin text`).toEqual([]);
    expect(results[key].warmMarks.editable, `${key}: editable ${results[key].warmMarks.editable} ms after navigation, warm`).toBeLessThanOrEqual(EDITABLE_BUDGET_MS);
  }
});

test('host side: what a slow bridge and an uncached package add to a warm load', async ({ browser, browserName }, testInfo) => {
  test.setTimeout(240_000);
  const note = NOTES[0];
  const variants: Record<string, Record<string, number>> = {};
  const table = [`editor host-side costs, ${browserName}, the plain note, warm medians:`];
  const runs: Record<string, LoadRun> = {};
  for (const [label, cache, latency] of [
    ['cached, no latency', 'host', 0],
    ['cached, 50 ms per bridge call', 'host', 50],
    ['uncached (no-store)', 'no-store', 0],
  ] as const) {
    server.cache = cache;
    try {
      const { warm } = await coldAndWarm(browser, (page) => loadOnce(page, note, { latency }), CONTEXT);
      variants[label] = warmMarks(warm);
      runs[label] = warm[warm.length - 1];
      table.push(row(label, variants[label], runs[label]));
    } finally {
      server.cache = 'no-store';
    }
  }
  report(testInfo, `editor-host-${browserName}.json`, { variants, runs }, table);
  for (const run of Object.values(runs)) expect(run.errors).toEqual([]);
});

test('heavy families load on first use: none for a plain note, then each renders once pasted, with no console errors', async ({ page }) => {
  const built = manifest();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !INERT_FRAME.test(message.text())) errors.push(message.text());
  });
  for (const { family, chunk } of LAZY_FAMILIES) {
    expect(built.chunks?.some((file) => chunk.test(file) && !(built.preload ?? []).includes(file)), `${family} has its own lazy chunk`).toBe(true);
  }
  const lazy = (path: string) => path.startsWith('/editor/assets/') && LAZY_FAMILIES.some(({ chunk }) => chunk.test(path)) && !(built.preload ?? []).some((file) => path.endsWith(file));
  const before = server.requests.length;
  await page.goto(`${server.url}/fixture/index.html`);
  await expect(page.locator('html[data-fixture="ready"]')).toBeAttached();
  const note = NOTES[0];
  const result = await page.evaluate(
    ({ markdown, meta }) => {
      const fixture = (window as unknown as { editorFixture: Fixture }).editorFixture;
      fixture.reset();
      fixture.seed(['Notes', meta.title], { markdown, meta });
      return fixture.mount(meta.id);
    },
    { markdown: note.markdown, meta: meta(note.title) },
  );
  expect(result).toEqual({ ok: true, status: 'clean' });
  const body = page.locator('[data-moss-editor] [data-moss-note-editor-root="true"]');
  await expect(body).toContainText(note.probe);
  await page.waitForTimeout(500);
  expect(server.requests.slice(before).filter(lazy), 'a plain note loads no family chunk').toEqual([]);
  // Each family's chunk is held back, so its placeholder shows first; the block keeps its height when the view arrives.
  server.delay = { pattern: /\/assets\/.*\.js$/, ms: 1_500 };
  const heights = () =>
    body.evaluate((root) =>
      [...root.querySelectorAll('[data-lexical-decorator="true"]')]
        .filter((element) => element.getBoundingClientRect().height > 100)
        .map((element) => ({
          placeholder: element.querySelector('[data-moss-lazy-view]') !== null,
          height: Math.round(element.getBoundingClientRect().height),
          top: Math.round(element.getBoundingClientRect().top - root.getBoundingClientRect().top),
          below: Math.round((element.nextElementSibling?.getBoundingClientRect().top ?? 0) - root.getBoundingClientRect().top),
        })),
    );
  try {
    await body.getByText('The last line of the note.').click();
    await page.keyboard.press('End');
    await body.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, LAZY_FAMILIES.map(({ markdown }) => markdown).join('\n\n'));
    await expect(body.locator('[data-moss-lazy-view]'), 'each pasted family shows its placeholder while its chunk loads').toHaveCount(LAZY_FAMILIES.length);
    const placeholders = await heights();
    for (const { family, rendered } of LAZY_FAMILIES) {
      await expect(body.locator(rendered).first(), `${family} renders after first use`).toBeVisible({ timeout: 15_000 });
    }
    await expect(body.locator('[data-moss-lazy-view]')).toHaveCount(0);
    await page.waitForTimeout(500);
    const views = await heights();
    expect(placeholders.every((block) => block.placeholder)).toBe(true);
    expect(views.map((block) => block.height), 'no layout jump: each view takes its placeholder\'s height').toEqual(placeholders.map((block) => block.height));
    expect(views.map(({ top, below }) => ({ top, below })), 'no layout jump: each view and the block after it stay where they were').toEqual(placeholders.map(({ top, below }) => ({ top, below })));
  } finally {
    server.delay = { pattern: null, ms: 0 };
  }
  expect(server.requests.slice(before).filter(lazy).length, 'the families loaded their chunks on first use').toBeGreaterThan(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { editorFixture: Fixture }).editorFixture.violations)).toEqual([]);
});

/** The chart family's chunk, which the race tests hold back. */
const CHART_CHUNK = /\/assets\/[^/]*chart[^/]*\.js$/i;

test('a newer external reload wins over an older one still waiting on its family chunk, and edits to the newer one are saved', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.url}/fixture/index.html`);
  await expect(page.locator('html[data-fixture="ready"]')).toBeAttached();
  const path = '/Moss/Notes/Plan/Plan.md';
  const result = await page.evaluate((value) => {
    const fixture = (window as unknown as FixtureWindow).editorFixture;
    fixture.reset();
    fixture.seed(['Notes', 'Plan'], { markdown: '# Plan\n\nFirst line\n', meta: value });
    return fixture.mount(value.id);
  }, meta('Plan'));
  expect(result).toEqual({ ok: true, status: 'clean' });
  const body = page.locator('[data-moss-editor] [data-moss-note-editor-root="true"]');
  await expect(body).toContainText('First line');
  const write = (text: string) => page.evaluate(([file, markdown]) => (window as unknown as FixtureWindow).editorFixture.externalWrite(file, markdown), [path, text]);
  // Version A brings the note's first chart, whose chunk is slow; version B, with no lazy family, lands meanwhile,
  // and the user types into it while A's chunk is still on its way.
  server.delay = { pattern: CHART_CHUNK, ms: 2_500 };
  try {
    await write(`# Plan\n\nVersion A\n\n${LAZY_FAMILIES[0].markdown}\n`);
    await page.waitForTimeout(700);
    await expect(body, 'nothing shows before its views are in').toContainText('First line');
    await write('# Plan\n\nVersion B final\n');
    await expect(body).toContainText('Version B final');
    await body.getByText('Version B final').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed');
    await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.status()), { timeout: 1_000 }).toBe('dirty');
    // Past the chunk's arrival.
    await page.waitForTimeout(3_000);
  } finally {
    server.delay = { pattern: null, ms: 0 };
  }
  await expect(body, 'the older version does not replace the newer one once its chunk arrives').toContainText('Version B final typed');
  await expect(body).not.toContainText('Version A');
  const kinds = (await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.events())).map((event) => event.kind);
  expect(kinds.filter((kind) => kind === 'reloaded')).toHaveLength(1);
  expect(kinds).not.toContain('conflict');
  // The idle save (1.5 s) may already have written the typing during the wait.
  expect((await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.flush())).kind).toMatch(/^(saved|clean)$/);
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.status())).toBe('clean');
  expect((await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.files()))[path]).toMatch(/^# Plan\n\nVersion B final typed\n?$/);
  expect(errors).toEqual([]);
});

test('a comment reply made while a reload waits for its chart chunk lands in the document on screen, and the reload becomes a conflict', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.url}/fixture/index.html`);
  await expect(page.locator('html[data-fixture="ready"]')).toBeAttached();
  const path = '/Moss/Notes/Plan/Plan.md';
  const result = await page.evaluate((value) => {
    const fixture = (window as unknown as FixtureWindow).editorFixture;
    fixture.reset();
    fixture.seed(['Notes', 'Plan'], { markdown: '# Plan\n\nAlpha beta gamma\n', meta: value });
    return fixture.mount(value.id);
  }, meta('Plan'));
  expect(result).toEqual({ ok: true, status: 'clean' });
  const body = page.locator('[data-moss-editor] [data-moss-note-editor-root="true"]');
  // A root comment on "beta", saved.
  await body.getByText('Alpha beta gamma').click();
  await body.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf('beta') ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 4);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      return;
    }
  });
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('beta');
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.keyboard.press('ControlOrMeta+Shift+A');
  const composer = page.getByRole('textbox', { name: 'comment editor' });
  await composer.click();
  await page.keyboard.type('Root');
  await page.getByRole('button', { name: 'Submit comment' }).click();
  await expect(body.locator('mark')).toHaveText('beta');
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.flush())).toMatchObject({ kind: 'saved' });
  const saved = (await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.files()))[path];
  // The thread is open, its reply composer ready.
  await page.getByRole('button', { name: 'View comment' }).first().click();
  const reply = page.getByRole('textbox', { name: 'comment editor' });
  await expect(reply).toBeVisible();
  const eventsBefore = (await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.events())).length;
  const external = `${saved.replace('Alpha', 'External edit: Alpha').replace(/\n?$/, '')}\n\n${LAZY_FAMILIES[0].markdown}\n`;
  server.delay = { pattern: CHART_CHUNK, ms: 2_500 };
  try {
    await page.evaluate(([file, markdown]) => (window as unknown as FixtureWindow).editorFixture.externalWrite(file, markdown), [path, external]);
    // The reload is waiting for the chart's chunk; the user replies in the thread still on screen.
    await page.waitForTimeout(500);
    await reply.click({ timeout: 1_000 });
    await page.keyboard.type('Late reply');
    await page.getByRole('button', { name: 'Submit comment' }).click({ timeout: 1_000 });
    // Past the idle save (1.5 s) and the chunk's arrival.
    await page.waitForTimeout(4_000);
  } finally {
    server.delay = { pattern: null, ms: 0 };
  }
  await expect(page.getByText('Late reply'), 'the reply stays in the thread on screen').toBeVisible();
  await expect(body).not.toContainText('External edit');
  await expect(body.locator('.recharts-surface')).toHaveCount(0);
  const files = await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.files());
  expect(files[path], 'the external version, its chart included, is still on disk').toBe(external);
  const after = (await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.events())).slice(eventsBefore).map((event) => event.kind);
  expect(after, 'the reply made the editor dirty, so the reload became a conflict').toContain('conflict');
  expect(after).not.toContain('reloaded');
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.status())).toBe('conflict');
  const flushed = (await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.flush())) as { kind: string; draft?: { files: { comments: string } } };
  expect(flushed.kind).toBe('conflict');
  expect(flushed.draft?.files.comments, 'the draft keeps the reply').toContain('Late reply');
  expect(errors).toEqual([]);
});

test('a title typed while a reload waits for its chart chunk is kept, and the reload becomes a conflict', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.url}/fixture/index.html`);
  await expect(page.locator('html[data-fixture="ready"]')).toBeAttached();
  const path = '/Moss/Notes/Plan/Plan.md';
  const result = await page.evaluate((value) => {
    const fixture = (window as unknown as FixtureWindow).editorFixture;
    fixture.reset();
    fixture.seed(['Notes', 'Plan'], { markdown: '# Plan\n\nFirst line\n', meta: value });
    return fixture.mount(value.id);
  }, meta('Plan'));
  expect(result).toEqual({ ok: true, status: 'clean' });
  const body = page.locator('[data-moss-editor] [data-moss-note-editor-root="true"]');
  const title = page.locator('[data-moss-editor-title]');
  await expect(body).toContainText('First line');
  const external = `# Plan\n\nFirst line\n\n${LAZY_FAMILIES[0].markdown}\n`;
  server.delay = { pattern: CHART_CHUNK, ms: 2_500 };
  try {
    await page.evaluate(([file, markdown]) => (window as unknown as FixtureWindow).editorFixture.externalWrite(file, markdown), [path, external]);
    await page.waitForTimeout(500);
    // The title commits only on blur, Enter or Tab: this typing is a draft the reload must not overwrite.
    await title.click({ timeout: 1_000 });
    await page.keyboard.press('End');
    await page.keyboard.type(' renamed');
    await expect(title).toHaveText('Plan renamed');
    await page.waitForTimeout(3_000);
  } finally {
    server.delay = { pattern: null, ms: 0 };
  }
  await expect(title, 'the typed title survives the reload').toHaveText('Plan renamed');
  const kinds = (await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.events())).map((event) => event.kind);
  expect(kinds).not.toContain('reloaded');
  expect(kinds).toContain('conflict');
  const flushed = (await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.flush())) as { kind: string; draft?: { files: { markdown: string } } };
  expect(flushed.kind).toBe('conflict');
  expect(flushed.draft?.files.markdown).toMatch(/^# Plan renamed\n/);
  expect((await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.files()))[path]).toBe(external);
  expect(errors).toEqual([]);
});

test('unmounting while the first mount waits for its chart chunk rejects ready with unmounted', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.url}/fixture/index.html`);
  await expect(page.locator('html[data-fixture="ready"]')).toBeAttached();
  server.delay = { pattern: CHART_CHUNK, ms: 2_500 };
  try {
    await page.evaluate(
      ({ value, chart }) => {
        const fixture = (window as unknown as FixtureWindow).editorFixture;
        const w = window as unknown as { __ready: unknown };
        fixture.reset();
        fixture.seed(['Notes', 'Plan'], { markdown: `# Plan\n\nHas a chart\n\n${chart}\n`, meta: value });
        w.__ready = 'pending';
        void fixture.mount(value.id).then((outcome) => {
          w.__ready = outcome;
        });
      },
      { value: meta('Plan'), chart: LAZY_FAMILIES[0].markdown },
    );
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.status())).toBe('loading');
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).editorFixture.unmount())).toEqual({ kind: 'unmounted', flush: 'notLoaded' });
    // ready rejects at once, before the chunk would arrive.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __ready: unknown }).__ready), { timeout: 1_500 })
      .toEqual({ ok: false, code: 'unmounted', status: 'unmounted' });
    await page.waitForTimeout(2_500);
  } finally {
    server.delay = { pattern: null, ms: 0 };
  }
  expect(await page.evaluate(() => (window as unknown as { __ready: unknown }).__ready)).toEqual({ ok: false, code: 'unmounted', status: 'unmounted' });
  expect(errors).toEqual([]);
});

