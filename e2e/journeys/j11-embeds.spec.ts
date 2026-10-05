// j11-embeds (T3.2; A§16, A§18, R4): moss's web surfaces that Electron draws natively are sandboxed iframes on the
// web. A moss-html block renders live, its scripts running in an opaque-origin sandbox (no allow-same-origin) while
// the page keeps its nonce CSP, and it cannot read the page's cookie. A web embed card shows the page's unfurled
// title. "Open in browser" opens the in-app browser as a sandboxed iframe with a working "Open in new tab", and its
// split view has no back, forward or find controls. A YouTube embed plays.
//
// Third-party pages the browser itself loads (the in-app browser's page, YouTube's thumbnail, player and clip) are
// stand-ins answered by `page.route`, as the viewer's X embed is: what is under test is our framing of them. The web
// embed's card is unfurled by the Worker, which fetches https://example.com itself.
import { readFileSync } from 'node:fs';
import type { Route } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import { APP_STATE_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const LOAD_TIMEOUT = 20_000;
const PEER_TIMEOUT = 15_000;

const FIXTURES = new URL('../fixtures/media/', import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, FIXTURES));

const PROBE = `\`\`\`moss-html
<p id="probe">pending</p>
<script>
  var out = {};
  try { out.cookie = String(document.cookie); } catch (e) { out.cookie = 'blocked:' + e.name; }
  try { out.parentCookie = String(parent.document.cookie); } catch (e) { out.parentCookie = 'blocked:' + e.name; }
  try { out.storage = String(localStorage.length); } catch (e) { out.storage = 'blocked:' + e.name; }
  out.origin = String(self.origin);
  document.getElementById('probe').textContent = 'ran:' + JSON.stringify(out);
</script>
\`\`\``;

const EMBED_URL = 'https://example.com/';
const YOUTUBE_ID = 'dQw4w9WgXcQ';

async function openShell(actors: Actors, label: string, path = '/'): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label), { path });
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  return actor;
}

/** A clipboard paste of markdown into the focused body, as a copied note arrives. */
async function paste(actor: Actor, docId: string, markdown: string): Promise<void> {
  await ui.body(actor, docId).evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    clipboardData.setData('text/markdown', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, markdown);
}

/** Ada's new note holding `markdown` (`prepare` runs first), and Ben, an editor by declared setup, with it open. */
async function sharedNote(actors: Actors, title: string, markdown: string, prepare?: (ada: Actor) => Promise<unknown>): Promise<{ ada: Actor; ben: Actor; docId: string }> {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  await prepare?.(ada);
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, title, { enter: true });
  await paste(ada, docId, markdown);
  await expect(ui.pane(ada, docId), 'the DocDO acks the paste').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await actors.requireDistinct(2);
  await ui.waitLive(ben, docId);
  return { ada, ben, docId };
}

/** Answers a request from `body`, honoring a single Range as a media server does (WebKit plays only through 206). */
async function fulfillRanged(route: Route, body: Buffer, contentType: string): Promise<void> {
  const range = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers().range ?? '');
  if (!range) {
    await route.fulfill({ status: 200, body, headers: { 'content-type': contentType, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' } });
    return;
  }
  const start = range[1] === '' ? Math.max(0, body.length - Number(range[2])) : Number(range[1]);
  const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  await route.fulfill({
    status: 206,
    body: body.subarray(start, end + 1),
    headers: { 'content-type': contentType, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}`, 'access-control-allow-origin': '*' },
  });
}

test('j11-embeds: a moss-html block runs its script live in an opaque-origin sandbox under the page CSP and cannot read the page cookie @p:note-2 @p:note-8 @evidence', async ({ actors }) => {
  // A cookie the page's own scripts can read, set before the block exists: the block must not read it.
  const { ada, ben, docId } = await sharedNote(actors, 'Live HTML', PROBE, (adaActor) =>
    adaActor.page.evaluate(() => { document.cookie = 'j11probe=page-secret; path=/'; }));

  // The page keeps its nonce policy: inline scripts in the page itself are refused.
  const policy = (await ada.page.request.get(`/d/${docId}`)).headers()['content-security-policy'] ?? '';
  const scriptSrc = /script-src ([^;]*)/.exec(policy)?.[1] ?? '';
  expect(scriptSrc, 'the page allows scripts only by nonce').toMatch(/'nonce-[^']+'/);
  expect(scriptSrc, 'the page never allows inline scripts').not.toContain('unsafe-inline');

  for (const actor of [ada, ben]) {
    // The cookie is per browser context, so Ben's page holds none until it sets one.
    if (actor === ben) await actor.page.evaluate(() => { document.cookie = 'j11probe=page-secret; path=/'; });
    expect(await actor.page.evaluate(() => document.cookie), `${actor.label}: the page reads its cookie`).toContain('j11probe=page-secret');
    const viewport = ui.body(actor, docId).locator('[data-moss-html-preview-viewport]');
    await expect(viewport, `${actor.label}: the HTML block renders`).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    await expect(viewport.getByText('Preview unavailable'), `${actor.label}: no screenshot placeholder`).toHaveCount(0);
    const frame = viewport.locator('iframe');
    await expect(frame, `${actor.label}: the block is a live iframe`).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    await expect(frame, `${actor.label}: sandboxed to scripts only, never allow-same-origin`).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame, `${actor.label}: served by the frame document, not a data: URL`).toHaveAttribute('src', /\/frame\/html$/);
    const probe = viewport.frameLocator('iframe').locator('#probe');
    await expect(probe, `${actor.label}: the block's own script ran`).toHaveText(/^ran:/, { timeout: LOAD_TIMEOUT });
    const ran = JSON.parse(((await probe.textContent()) ?? '').slice('ran:'.length)) as Record<string, string>;
    expect(ran.origin, `${actor.label}: the block runs in an opaque origin`).toBe('null');
    expect(ran.cookie, `${actor.label}: the block cannot read the page's cookie`).not.toContain('j11probe');
    expect(ran.parentCookie, `${actor.label}: nor reach the page's document`).toMatch(/^blocked:/);
    expect(ran.storage, `${actor.label}: nor the app's storage`).toMatch(/^blocked:/);
  }
  await actors.checkpoint('html-block');
});

test('j11-embeds: a web embed card shows the unfurled page; the in-app browser is a sandboxed iframe with a working "Open in new tab" and no back, forward or find @p:note-2 @p:R4 @evidence', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Web embed', `![](${EMBED_URL})`, ({ context }) =>
    context.route(`${EMBED_URL}**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Stand-in</title><h1 id="standin">Stand-in page</h1>' })));

  for (const actor of [ada, ben]) {
    const card = ui.body(actor, docId).locator('[data-web-embed-node][data-web-embed-kind="webpage"]');
    await expect(card, `${actor.label}: the web embed renders as a card`).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('[data-web-embed-metadata]'), `${actor.label}: the card carries the unfurled title`).toContainText('Example Domain', { timeout: LOAD_TIMEOUT });
  }
  await actors.checkpoint('web-embed-card');

  // "Open in browser" on the card opens the in-app browser: a sandboxed iframe of the page.
  const { page } = ada;
  const card = ui.body(ada, docId).locator('[data-web-embed-node]');
  await card.hover();
  await card.getByRole('button', { name: 'Open in browser' }).click();
  const live = page.locator('[data-web-embed-lightbox-live]');
  const frame = live.locator('iframe');
  await expect(frame, 'the in-app browser is an iframe').toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(frame).toHaveAttribute('src', EMBED_URL);
  const sandbox = (await frame.getAttribute('sandbox')) ?? '';
  expect(sandbox.split(/\s+/), 'sandboxed with scripts').toContain('allow-scripts');
  expect(sandbox, 'never same-origin with anything').not.toContain('allow-same-origin');
  await expect(live.frameLocator('iframe').locator('#standin'), 'the page loads inside it').toHaveText('Stand-in page', { timeout: LOAD_TIMEOUT });

  // "Open in new tab" opens the page itself in a browser tab, for sites that refuse framing.
  const opened = page.context().waitForEvent('page', { timeout: LOAD_TIMEOUT });
  await live.getByRole('link', { name: 'Open in new tab' }).click();
  const tab = await opened;
  await tab.waitForLoadState('domcontentloaded');
  expect(tab.url(), 'the new tab shows the page').toBe(EMBED_URL);
  await expect(tab.locator('#standin')).toHaveText('Stand-in page');
  await tab.close();

  // The split view keeps the page framed, without the Electron-only back, forward and find controls.
  await page.getByRole('button', { name: 'Open in split view' }).click();
  const split = page.locator('[data-browser-split-pane]');
  await expect(split.locator('[data-browser-split-live] iframe'), 'the split browser is an iframe').toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(split.locator('[data-browser-split-live]').frameLocator('iframe').locator('#standin')).toHaveText('Stand-in page', { timeout: LOAD_TIMEOUT });
  await expect(split.locator('[data-browser-split-live]').getByRole('link', { name: 'Open in new tab' })).toBeVisible();
  for (const name of ['Go back', 'Go forward', 'Search in browser']) {
    await expect(split.getByRole('button', { name }), `no "${name}" control`).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Close browser split tab' }).click();
  await expect(split).toHaveCount(0);
});

test('j11-embeds: a YouTube embed plays in its sandboxed frame @p:note-8 @evidence', async ({ actors }) => {
  const clip = bytes('clip.webm');
  const thumbnail = bytes('pattern.png');
  const { ada, docId } = await sharedNote(actors, 'YouTube', `![A talk](https://www.youtube.com/watch?v=${YOUTUBE_ID})`, async ({ context }) => {
    await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: thumbnail }));
    await context.route('https://www.youtube.com/standin/clip.webm', (route) => fulfillRanged(route, clip, 'video/webm'));
    await context.route(`https://www.youtube.com/embed/${YOUTUBE_ID}**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Player</title><video id="player" src="/standin/clip.webm" autoplay muted playsinline loop></video>',
    }));
  });

  const video = ui.body(ada, docId).locator('[data-video-node-kind="youtube"]');
  await expect(video, 'the YouTube link is a video block').toHaveCount(1, { timeout: LOAD_TIMEOUT });
  const thumb = video.locator('img');
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { message: 'the thumbnail shows', timeout: LOAD_TIMEOUT }).toBe(true);
  await thumb.click();
  const frame = video.locator('iframe');
  await expect(frame, 'the player is an iframe').toHaveAttribute('src', `https://www.youtube.com/embed/${YOUTUBE_ID}?autoplay=1`, { timeout: LOAD_TIMEOUT });
  await expect(frame).toHaveAttribute('allow', /autoplay/);
  const player = video.frameLocator('iframe').locator('#player');
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime), { message: 'the clip plays', timeout: LOAD_TIMEOUT }).toBeGreaterThan(0.1);
  await actors.checkpoint('youtube');
});
