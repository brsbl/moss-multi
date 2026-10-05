// T0.13 read-only viewer acceptance: the built bundle (packages/viewer/dist) mounts a synthetic moss note with
// tabs, tables and post embeds in a plain host page. It paints the title once, never a comment marker or the
// frontmatter, applies the layout sidecar, keeps tabs switchable, accepts no input, opens no socket, sends no
// write, and reaches media and links only through the services the page injected. X's embed frame is moss's
// provider frame; it is answered here by a stand-in at its origin so CI never depends on X.
// T3.8 (viewer 1.0.0): no mutating control in any read-only block, X posts in the viewer's theme, HTML blocks live in
// the bundle's sandboxed frame document when the host serves it, j14's demo note, and video through 206 in both engines.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_DIR, FRAME_POLICY, serveViewer, type ViewerServer } from './server.ts';

const MARKDOWN = readFileSync(join(FIXTURE_DIR, 'seed-library.md'), 'utf8');
const DEMO = readFileSync(new URL('../fixtures/demo-note.md', import.meta.url), 'utf8');
const FRAME_URL = '/viewer/moss-viewer-frame.html';
const LAYOUT: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'layout.json'), 'utf8'));
const TITLE = 'Seed Library Notes';
const PROVIDER = 'https://platform.twitter.com';
const POST = 'https://x.com/seedlibrary_fx/status/1700000000000000001';
const LEGACY_ID = '5b1f3c2a-9d8e-4f70-a1b2-c3d4e5f60718';

type Theme = 'light' | 'dark';

interface Calls {
  assetUrl: { ref: string; kind: string; url: string | null }[];
  notes: number;
  navigate: unknown[];
  unfurl: string[];
}

declare global {
  interface Window {
    viewerFixture: {
      api: number;
      calls: Calls;
      mount(options: MountOptions): Promise<{ title: string; frontmatter: unknown }>;
      setTheme(theme: Theme): void;
      handle: { setTheme(theme: Theme): void };
    };
  }
}

// X's frame at its own origin: a post card that reports its height the way the real widget does.
const postFrame = (statusId: string) => `<!doctype html><html><body style="margin:0;font:15px/1.4 system-ui,sans-serif;color:#0f1419">
<div style="border:1px solid #cfd9de;border-radius:12px;padding:12px 16px;background:#fff">
<div style="font-weight:700">Seed Library <span style="font-weight:400;color:#536471">@seedlibrary_fx</span></div>
<p style="margin:6px 0 0">Stand-in for X's embed frame, post ${statusId}. Seed swap on Saturday.</p></div>
<script>parent.postMessage({'twttr.embed':{method:'twttr.private.resize',params:[{height:document.body.scrollHeight,data:{tweet_id:'${statusId}'}}]}},'*')</script>
</body></html>`;

let server: ViewerServer;

test.beforeAll(async () => {
  server = await serveViewer();
});

test.afterAll(async () => {
  await server?.close();
});

interface Seen {
  requests: { url: string; method: string }[];
  sockets: string[];
  pageErrors: string[];
  downloads: number;
}

function watch(page: Page): Seen {
  const seen: Seen = { requests: [], sockets: [], pageErrors: [], downloads: 0 };
  page.on('request', (request) => seen.requests.push({ url: request.url(), method: request.method() }));
  page.on('websocket', (socket) => seen.sockets.push(socket.url()));
  page.on('pageerror', (error) => seen.pageErrors.push(error.message));
  page.on('download', () => {
    seen.downloads += 1;
  });
  return seen;
}

interface MountOptions {
  markdown: string;
  layout?: unknown;
  theme: Theme;
  noteId: string;
  title?: string;
  /** Pass the bundle's frame document as services.htmlFrameUrl. */
  live?: boolean;
}

async function mount(page: Page, theme: Theme = 'light', options: Partial<MountOptions> = {}) {
  await page.route(`${PROVIDER}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: postFrame(new URL(route.request().url()).searchParams.get('id') ?? '') }),
  );
  await page.goto(`${server.url}/fixture/`);
  await expect(page.locator('html[data-fixture="ready"]')).toHaveCount(1);
  const mounted = await page.evaluate(
    (options) => window.viewerFixture.mount(options),
    { markdown: MARKDOWN, layout: LAYOUT, theme, noteId: 'note-seed-library', ...options },
  );
  await expect(page.locator('[data-moss-viewer][data-moss-viewer-state="ready"]')).toHaveCount(1);
  return mounted;
}

const calls = (page: Page) => page.evaluate(() => structuredClone(window.viewerFixture.calls));

test('paints the note once, read-only: one title, no markers or frontmatter, the layout sidecar, switchable tabs', async ({ page }) => {
  const seen = watch(page);
  const mounted = await mount(page);
  const viewer = page.locator('[data-moss-viewer]');
  const body = viewer.locator('[data-moss-note-editor-root]');

  // The leading `# Title` is the title, painted once above the body; the body keeps its own content.
  expect(mounted.title).toBe(TITLE);
  await expect(viewer.locator('[data-moss-viewer-title]')).toHaveText(TITLE);
  await expect(viewer.getByText(TITLE, { exact: true })).toHaveCount(1);
  await expect(body.locator('h1')).toHaveCount(0);
  await expect(body).toContainText('A synthetic note shaped like a real moss note.');

  // Frontmatter is data for the host, never canvas text; a comment marker never paints, its sentence does.
  expect(mounted.frontmatter).toEqual({ tags: ['garden', 'fixture'], status: 'draft' });
  await expect(body).toContainText('Volunteers sort the drawer every Saturday. Nothing in this note is real.');
  const text = await viewer.innerText();
  expect(text).not.toContain('%%');
  expect(text).not.toContain('k7q2');
  expect(text).not.toContain('status: draft');

  // Real tables; layout.json's column widths apply (moss infers percentages without them).
  await expect(body.locator('table')).toHaveCount(2);
  await expect(body.locator('table').first().locator('col').first()).toHaveAttribute('style', /width: 260px/);

  // Tabs switch in the read-only view.
  const shelf = body.locator('[data-tab-panel][data-tab-label="Shelf map"]');
  await expect(shelf).toBeHidden();
  await viewer.locator('[role="tab"]', { hasText: 'Shelf map' }).click();
  await expect(shelf).toBeVisible();
  await expect(shelf).toContainText('Tomatoes');
  await expect(viewer.locator('[role="tab"]', { hasText: 'Shelf map' })).toHaveAttribute('aria-selected', 'true');
  expect(seen.pageErrors).toEqual([]);
});

test('accepts no input: nothing is editable and typing, Enter, Backspace and a checkbox click change nothing', async ({ page }) => {
  const seen = watch(page);
  await mount(page);
  const viewer = page.locator('[data-moss-viewer]');
  const body = viewer.locator('[data-moss-note-editor-root]');
  await expect(body).toHaveAttribute('contenteditable', 'false');
  await expect(viewer.locator('[contenteditable="true"]')).toHaveCount(0);
  // HTML previews settle asynchronously; compare text once they have.
  await settleHtmlBlocks(page);
  const before = await body.innerText();

  await body.getByText('Nothing in this note is real.').click();
  await page.keyboard.type('zzqx typed');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await viewer.locator('[data-moss-viewer-title]').click();
  await page.keyboard.type('zzqx title');
  const open = body.locator('li[role="checkbox"]', { hasText: 'Order envelopes' });
  await expect(open).toHaveAttribute('aria-checked', 'false');
  await open.click({ position: { x: 2, y: 10 } });
  // Tabs switch but never edit: no Add tab or Tab options, and a double-click opens no rename.
  await expect(viewer.locator('[role="tablist"] button')).toHaveCount(0);
  await viewer.locator('[data-tab-title]', { hasText: 'Posts' }).dblclick();
  await expect(page.locator('input[aria-label^="Rename"]')).toHaveCount(0);
  await expect(viewer.locator('[role="tab"]')).toHaveText(['Posts', 'Shelf map', 'Photo']);

  await expect(open).toHaveAttribute('aria-checked', 'false');
  await expect(viewer).not.toContainText('zzqx');
  await expect(viewer.locator('[data-moss-viewer-title]')).toHaveText(TITLE);
  expect(await body.innerText()).toBe(before);
  expect(seen.pageErrors).toEqual([]);
});

test('reaches the network only through the injected services: media, links and embeds; no socket, no write', async ({ page, browserName }) => {
  const seen = watch(page);
  await mount(page);
  const viewer = page.locator('[data-moss-viewer]');
  const body = viewer.locator('[data-moss-note-editor-root]');
  const pill = (text: string) => body.locator('[data-file-link-node-key]').filter({ hasText: new RegExp(`^${text}$`) });

  // Media: the image and the video come from the URLs assetUrl returned.
  const image = body.locator('img[alt="Sunflower gradient"]');
  await image.scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute('src', '/svc/assets/sunflower.png');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const video = body.locator('[data-video-node-kind="local"]');
  await video.scrollIntoViewIfNeeded();
  await video.locator('[data-video-play-overlay]').locator('..').click();
  await expect(body.locator('video:not([data-video-thumbnail-state])')).toHaveAttribute('src', /^\/svc\/assets\/drawer\.webm/);
  const clip = () => server.media.filter((request) => request.path === '/svc/assets/drawer.webm' && (request.status === 200 || request.status === 206));
  await expect.poll(() => clip().length).toBeGreaterThan(0);
  // Chromium asks for byte ranges from the first load and the service answers 206; WebKit's GStreamer fetches a
  // small file whole and asks for ranges only when it seeks.
  if (browserName === 'chromium') expect(clip().filter((request) => request.range !== null && request.status === 206)).not.toEqual([]);

  // Posts: moss's card asks the unfurl service, and its provider frame is X's.
  await expect.poll(async () => (await calls(page)).unfurl).toContain(POST);
  await expect(body.locator(`iframe[src^="${PROVIDER}/embed/Tweet.html"][src*="id=1700000000000000001"]`)).toHaveCount(1);

  // Wiki links resolve against the injected notes: by title, a legacy [[Title|id]] by id (its pill shows the
  // looked-up title), a heading elsewhere, and a heading here (moss scrolls; nothing leaves).
  await expect(pill('Seed Index')).toHaveCount(1);
  await pill('Planting Calendar').click();
  await pill('Seed Index').click();
  await pill('Planting Calendar > April').click();
  await pill('Seed counts').click();
  // A web link leaves through navigate, not the page's own navigation.
  await body.getByRole('link', { name: 'project page' }).click();
  await expect(page).toHaveURL(`${server.url}/fixture/`);

  const recorded = await calls(page);
  expect(recorded.notes).toBeGreaterThan(0);
  expect(recorded.navigate).toEqual([
    { kind: 'note', noteId: 'note-planting', heading: null },
    { kind: 'note', noteId: LEGACY_ID, heading: null },
    { kind: 'note', noteId: 'note-planting', heading: 'April' },
    { kind: 'url', url: 'https://example.org/seed-library', title: 'project page' },
  ]);
  expect(recorded.assetUrl).toEqual(expect.arrayContaining([
    { ref: 'assets/sunflower.png', kind: 'image', url: '/svc/assets/sunflower.png' },
    { ref: 'assets/drawer.webm', kind: 'video', url: '/svc/assets/drawer.webm' },
  ]));

  // Every request is the bundle, the host page, a URL the services returned, or X's provider frame; all GETs.
  // blob: and data: URLs are the page's own memory (WebKit reports blob: loads as requests), never the network.
  const served = new Set(recorded.assetUrl.flatMap((call) => (call.url ? [call.url] : [])));
  const outside = seen.requests.filter(({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return false;
    if (parsed.origin === server.url) {
      if (parsed.pathname.startsWith('/viewer/') || parsed.pathname.startsWith('/fixture/')) return false;
      return !served.has(parsed.pathname);
    }
    return parsed.origin !== PROVIDER;
  });
  expect(outside, 'requests outside the bundle and the injected services').toEqual([]);
  expect(seen.requests.filter((request) => request.method !== 'GET'), 'writes').toEqual([]);
  expect(seen.sockets, 'sockets').toEqual([]);
  expect(seen.downloads, 'downloads').toBe(0);
  expect(seen.pageErrors).toEqual([]);
});

// moss's cached screenshots of the fixture's three HTML blocks: one in moss's cache, one where older moss wrote it
// (moss's ensure still reads it), and one never captured.
const CACHED = 'assets/.moss-cache/html-preview/html-preview-f6f3e7c49f7eab85.png';
const LEGACY = 'assets/html-preview-cc4467ed46ca7e18.png';
const UNCAPTURED = ['assets/.moss-cache/html-preview/html-preview-7110f0621789a24b.png', 'assets/html-preview-7110f0621789a24b.png'];

const htmlBlocks = (page: Page) => page.locator('[data-moss-viewer] [data-block-decorator-key]:has([data-moss-html-preview-viewport])');

/**
 * Brings each HTML block into view (its preview loads lazily) and waits for its final state: a loaded screenshot,
 * "Preview unavailable", or a live frame.
 */
async function settleHtmlBlocks(page: Page, count = 3) {
  const blocks = htmlBlocks(page);
  await expect(blocks).toHaveCount(count);
  for (const block of await blocks.all()) {
    await block.scrollIntoViewIfNeeded();
    await expect(block.locator('[data-testid="html-preview-loading"]')).toHaveCount(0);
    await expect.poll(() => block.evaluate((element) => {
      const image = element.querySelector<HTMLImageElement>('img[alt="HTML preview"]');
      if (image?.complete && image.naturalWidth > 0) return 'screenshot';
      if (element.querySelector('[data-testid="html-preview-error"]')) return 'unavailable';
      if (element.querySelector('iframe[title="HTML preview"]')) return 'live';
      return 'pending';
    }), { message: 'the HTML block settles' }).not.toBe('pending');
  }
  return blocks;
}

test("HTML blocks show moss's cached screenshot through assetUrl, else Preview unavailable; nothing runs the HTML", async ({ page }) => {
  const seen = watch(page);
  await mount(page);
  const blocks = await settleHtmlBlocks(page);
  const shown = (index: number) => blocks.nth(index).locator('img[alt="HTML preview"]');

  await expect(shown(0)).toHaveAttribute('src', `/svc/${CACHED}?v=0`);
  await expect.poll(() => shown(0).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1280);
  await expect(shown(1)).toHaveAttribute('src', new RegExp(`^/svc/${LEGACY.replace(/[.]/g, '\\.')}\\?v=\\d+$`));
  await expect.poll(() => shown(1).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1280);
  for (const index of [0, 1]) await expect(blocks.nth(index).getByText('Preview unavailable')).toHaveCount(0);
  await expect(blocks.nth(2).getByText('Preview unavailable')).toBeVisible();
  await expect(shown(2)).toHaveCount(0);

  // Pressing a preview neither runs the HTML in a frame nor opens its source.
  await blocks.nth(0).click();
  await blocks.nth(1).dblclick();
  await expect(page.locator('iframe[title^="HTML preview"]')).toHaveCount(0);
  await expect(page.locator('[data-moss-viewer] textarea')).toHaveCount(0);

  // Each screenshot was named by moss's hash and fetched from the URL assetUrl returned for it, and nothing else.
  const recorded = await calls(page);
  const refs = new Set(recorded.assetUrl.map((call) => call.ref));
  for (const ref of [CACHED, LEGACY, ...UNCAPTURED]) expect(refs).toContain(ref);
  const previews = server.media.filter((request) => request.path.includes('html-preview-')).map((request) => request.path);
  expect(new Set(previews)).toEqual(new Set([CACHED, `assets/.moss-cache/html-preview/html-preview-cc4467ed46ca7e18.png`, LEGACY, ...UNCAPTURED].map((ref) => `/svc/${ref}`)));
  expect(seen.requests.filter(({ url }) => url.includes('html-preview-') && !new URL(url).pathname.startsWith('/svc/assets/'))).toEqual([]);
  expect(seen.pageErrors).toEqual([]);
});

/** Controls a reader could press, as `name`, with each block hovered once so hover headers render. */
async function controls(page: Page): Promise<string[]> {
  const viewer = page.locator('[data-moss-viewer]');
  for (const block of await viewer.locator('[data-block-decorator-key]').all()) {
    await block.scrollIntoViewIfNeeded();
    await block.hover();
  }
  return viewer.evaluate((root) => {
    const pressable = root.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"], input, textarea, select, [contenteditable="true"]');
    return [...pressable]
      .filter((element) => !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true')
      .filter((element) => !(element as HTMLInputElement).readOnly && element.checkVisibility())
      // A link pill opens its page.
      .filter((element) => !element.matches('[data-embed-pill-node-key]'))
      .map((element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim() || element.tagName.toLowerCase());
  });
}

// Reading controls: open a post or page, copy a link, retry a preview that failed to load, press a live HTML block.
const READING_CONTROLS = new Set(['Open in browser', 'Open tweet', 'Copy link', 'Retry preview', 'Activate live HTML preview']);

test('no block offers a mutating control: hovered, no Delete, Edit, Fullscreen, comment or insert control renders', async ({ page }) => {
  const seen = watch(page);
  const found: Record<string, string[]> = {};
  for (const [name, options] of [
    ['fixture', {}],
    ['fixture, live HTML', { live: true }],
    ['demo note, live HTML', { markdown: DEMO, title: 'Demo note', layout: undefined, live: true }],
  ] as const) {
    await mount(page, 'light', options);
    await settleHtmlBlocks(page, name.startsWith('demo') ? 1 : 3);
    found[name] = [...new Set(await controls(page))].filter((control) => !READING_CONTROLS.has(control)).sort();
  }
  expect(found).toEqual({ fixture: [], 'fixture, live HTML': [], 'demo note, live HTML': [] });
  expect(seen.pageErrors).toEqual([]);
});

const postThemes = (page: Page) =>
  page.locator(`[data-moss-viewer] iframe[src^="${PROVIDER}/embed/Tweet.html"]`).evaluateAll((frames) =>
    frames.map((frame) => new URL((frame as HTMLIFrameElement).src).searchParams.get('theme')));

test("X posts follow the viewer's theme and re-render when setTheme changes it", async ({ page }) => {
  const seen = watch(page);
  await mount(page, 'dark');
  await expect.poll(() => postThemes(page)).toEqual(['dark', 'dark']);
  // The viewer's own theme, not the page's: the host page stays dark.
  await page.evaluate(() => window.viewerFixture.handle.setTheme('light'));
  await expect.poll(() => postThemes(page)).toEqual(['light', 'light']);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => window.viewerFixture.handle.setTheme('dark'));
  await expect.poll(() => postThemes(page)).toEqual(['dark', 'dark']);
  // Each re-render loads the post again from X's frame, never from anywhere else.
  const posts = seen.requests.filter(({ url }) => url.startsWith(`${PROVIDER}/embed/Tweet.html`));
  expect(new Set(posts.map(({ url }) => new URL(url).searchParams.get('theme')))).toEqual(new Set(['dark', 'light']));
  expect(seen.pageErrors).toEqual([]);
});

// A block whose script reports whether it ran and whether it can read the host page.
const LIVE_NOTE = `# Live HTML

\`\`\`moss-html
<div id="out" style="font:600 24px system-ui;padding:24px">waiting</div>
<script>
  var reach = 'isolated';
  try { reach = parent.document.cookie === undefined ? 'isolated' : 'reached'; } catch (error) {}
  try { if (document.cookie !== undefined && document.cookie.includes('host=secret')) reach = 'reached'; } catch (error) {}
  document.getElementById('out').textContent = 'script ran, ' + reach;
</script>
\`\`\`
`;

test('live HTML: with services.htmlFrameUrl each HTML block runs in a sandboxed frame from that URL and cannot reach the page', async ({ page }) => {
  const seen = watch(page);
  await page.context().addCookies([{ name: 'host', value: 'secret', url: server.url }]);
  await mount(page, 'light', { markdown: LIVE_NOTE, live: true });
  const [block] = await (await settleHtmlBlocks(page, 1)).all();
  const frame = block.locator('iframe[title="HTML preview"]');
  await expect(frame).toHaveAttribute('src', FRAME_URL);
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(block.frameLocator('iframe[title="HTML preview"]').locator('#out')).toHaveText('script ran, isolated');
  // The frame document came from the host with its own policy; no screenshot was looked up.
  const frameResponse = await page.request.get(`${server.url}${FRAME_URL}`);
  expect(frameResponse.headers()['content-security-policy']).toBe(FRAME_POLICY);
  expect((await calls(page)).assetUrl.filter(({ ref }) => ref.includes('html-preview-'))).toEqual([]);

  // A double-click opens no source editor.
  await block.dblclick();
  await expect(page.locator('[data-moss-viewer] textarea')).toHaveCount(0);

  // The fixture's three blocks render live, not as screenshots.
  await mount(page, 'light', { live: true });
  const blocks = await settleHtmlBlocks(page);
  for (const [index, text] of ['Seed swap poster', 'Planting chart', 'Drawer label draft'].entries()) {
    await expect(blocks.nth(index).frameLocator('iframe[title="HTML preview"]').getByText(text)).toBeVisible();
  }
  await expect(page.locator('[data-moss-viewer] img[alt="HTML preview"]')).toHaveCount(0);
  expect(server.media.filter((request) => request.path.includes('html-preview-'))).toEqual([]);
  expect(seen.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  expect(seen.sockets).toEqual([]);
  expect(seen.pageErrors).toEqual([]);
});

test('video plays through 206 Range responses: a seek ahead of the download asks the asset URL for a byte range', async ({ page }) => {
  const clipPath = '/svc/assets/drawer.webm';
  server.slow.add(clipPath);
  try {
    await mount(page);
    const before = server.media.length;
    const body = page.locator('[data-moss-viewer] [data-moss-note-editor-root]');
    const video = body.locator('[data-video-node-kind="local"]');
    await video.scrollIntoViewIfNeeded();
    await video.locator('[data-video-play-overlay]').locator('..').click();
    const player = body.locator('video:not([data-video-thumbnail-state])');
    await expect(player).toHaveAttribute('src', /^\/svc\/assets\/drawer\.webm/);
    await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    const target = await player.evaluate((element: HTMLVideoElement) => {
      const target = element.duration * 0.8;
      element.currentTime = target;
      return target;
    });
    // The player's own reads of the clip: at least one asks for a byte range and is answered 206.
    const reads = () => server.media.slice(before).filter((request) => request.path === clipPath);
    await expect.poll(() => reads().filter((request) => request.range !== null && request.status === 206).length, {
      message: 'a Range read answered 206',
      timeout: 20_000,
    }).toBeGreaterThan(0);
    await expect.poll(() => player.evaluate((element: HTMLVideoElement) => !element.seeking && element.readyState >= 2 && element.currentTime >= 0.75 * element.duration), {
      message: `the clip plays from ${target.toFixed(2)} s`,
      timeout: 20_000,
    }).toBe(true);
    expect(reads().every((request) => request.status === 200 || request.status === 206)).toBe(true);
  } finally {
    server.slow.delete(clipPath);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`demo note shot, ${theme}: every family renders, none falls back to its error placeholder`, async ({ page, browserName }, testInfo) => {
    const seen = watch(page);
    await mount(page, theme, { markdown: DEMO, title: 'Demo note', layout: undefined, live: true });
    const body = page.locator('[data-moss-viewer] [data-moss-note-editor-root]');
    for (const selector of ['h1', 'h2', 'h3', 'h4', 'ul.list-disc', 'ol', 'li[role="checkbox"]', 'strong', 'em', 'code', 'a[href]', '[data-formula-node-key]', '[data-file-link-node-key]', '[data-embed-pill-node-key]', '[data-color-node-key]', 'blockquote', 'table.moss-table', '.moss-callout', '.moss-tab-group', '.moss-codeblock-pre', 'canvas', 'hr']) {
      await expect(body.locator(selector).first(), selector).toBeAttached();
    }
    await settleHtmlBlocks(page, 1);
    await expect(body.locator('[data-node-view-error]')).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const path = testInfo.outputPath(`viewer-demo-${browserName}-${theme}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`viewer-demo-${browserName}-${theme}`, { path, contentType: 'image/png' });
    expect(seen.pageErrors).toEqual([]);
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`fixture shot, ${theme}`, async ({ page, browserName }, testInfo) => {
    await mount(page, theme);
    await expect(page.locator('[data-moss-viewer-title]')).toHaveText(TITLE);
    const frames = page.locator(`iframe[src^="${PROVIDER}/embed/Tweet.html"]`);
    // Post frames load lazily; bring each into view once so the shot shows them.
    for (const frame of await frames.all()) await frame.scrollIntoViewIfNeeded();
    const blocks = await settleHtmlBlocks(page);
    await expect(blocks.nth(0).locator('img[alt="HTML preview"]')).toHaveAttribute('src', `/svc/${CACHED}?v=0`);
    await expect(blocks.nth(2).getByText('Preview unavailable')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(page.locator('[data-moss-viewer]')).toHaveAttribute('data-theme', theme);
    const path = testInfo.outputPath(`viewer-${browserName}-${theme}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`viewer-${browserName}-${theme}`, { path, contentType: 'image/png' });
  });
}
