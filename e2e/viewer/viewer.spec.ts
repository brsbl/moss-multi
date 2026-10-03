// T0.13 read-only viewer acceptance: the built bundle (packages/viewer/dist) mounts a synthetic moss note with
// tabs, tables and post embeds in a plain host page. It paints the title once, never a comment marker or the
// frontmatter, applies the layout sidecar, keeps tabs switchable, accepts no input, opens no socket, sends no
// write, and reaches media and links only through the services the page injected. X's embed frame is moss's
// provider frame; it is answered here by a stand-in at its origin so CI never depends on X.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_DIR, serveViewer, type ViewerServer } from './server.ts';

const MARKDOWN = readFileSync(join(FIXTURE_DIR, 'seed-library.md'), 'utf8');
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
      mount(options: { markdown: string; layout: unknown; theme: Theme; noteId: string }): Promise<{ title: string; frontmatter: unknown }>;
      setTheme(theme: Theme): void;
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

async function mount(page: Page, theme: Theme = 'light') {
  await page.route(`${PROVIDER}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: postFrame(new URL(route.request().url()).searchParams.get('id') ?? '') }),
  );
  await page.goto(`${server.url}/fixture/`);
  await expect(page.locator('html[data-fixture="ready"]')).toHaveCount(1);
  const mounted = await page.evaluate(
    ([markdown, layout, theme]) => window.viewerFixture.mount({ markdown, layout, theme, noteId: 'note-seed-library' }),
    [MARKDOWN, LAYOUT, theme] as const,
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

test('reaches the network only through the injected services: media, links and embeds; no socket, no write', async ({ page }) => {
  const seen = watch(page);
  await mount(page);
  const viewer = page.locator('[data-moss-viewer]');
  const body = viewer.locator('[data-moss-note-editor-root]');
  const pill = (text: string) => body.locator('[data-file-link-node-key]').filter({ hasText: new RegExp(`^${text}$`) });

  // Media: the image and the video come from the URLs assetUrl returned, the video over HTTP Range.
  const image = body.locator('img[alt="Sunflower gradient"]');
  await image.scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute('src', '/svc/assets/sunflower.png');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const video = body.locator('[data-video-node-kind="local"]');
  await video.scrollIntoViewIfNeeded();
  await video.locator('[data-video-play-overlay]').locator('..').click();
  await expect(body.locator('video')).toHaveAttribute('src', /^\/svc\/assets\/drawer\.webm/);
  await expect.poll(() => server.media.filter((request) => request.path === '/svc/assets/drawer.webm' && request.range !== null && request.status === 206).length).toBeGreaterThan(0);

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
  const served = new Set(recorded.assetUrl.flatMap((call) => (call.url ? [call.url] : [])));
  const outside = seen.requests.filter(({ url }) => {
    const parsed = new URL(url);
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

for (const theme of ['light', 'dark'] as const) {
  test(`fixture shot, ${theme}`, async ({ page, browserName }, testInfo) => {
    await mount(page, theme);
    await expect(page.locator('[data-moss-viewer-title]')).toHaveText(TITLE);
    const frames = page.locator(`iframe[src^="${PROVIDER}/embed/Tweet.html"]`);
    // Post frames load lazily; bring each into view once so the shot shows them.
    for (const frame of await frames.all()) await frame.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(page.locator('[data-moss-viewer]')).toHaveAttribute('data-theme', theme);
    const path = testInfo.outputPath(`viewer-${browserName}-${theme}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`viewer-${browserName}-${theme}`, { path, contentType: 'image/png' });
  });
}
