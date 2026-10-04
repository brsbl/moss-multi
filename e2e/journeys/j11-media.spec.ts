// j11-media (T3.1; A§16, A§9 images): moss's media set uploads from the web. Ada drops, pastes and picks (the slash
// menu's /media → "From computer") one of every moss type into a note: png, jpg, gif, webp, svg, mp4, webm and mov;
// each renders and survives a reload, and the export keeps moss's relative `assets/` paths. A viewer gets no upload
// control and a raw upload gets 403; a PDF gets 415. A copied note keeps its media, in the same folder and in the
// copier's own Home. A signed-in link reader sees the media, and so does an anonymous one, through the token the asset
// URL carries. Video plays through 206 responses. Alt text edited from the image's context menu reaches the peer and
// the export.
//
// Grants are declared setup through the members API, and the share link through the loopback hook until T2.4's
// links API lands; sharing is not this journey's promise. Files reach the editor as browsers deliver them: a
// DataTransfer on drop and paste, and the file chooser for "From computer".
import { readFileSync } from 'node:fs';
import type { Actor, Actors } from '../lib/actors.ts';
import { APP_STATE_ATTR, BODY_BINDING_ATTR, EDITOR_PANE_ATTR, NAMES, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
const UPLOAD_TIMEOUT = 20_000;
const PEER_TIMEOUT = 10_000;

interface Fixture { name: string; type: string; kind: 'image' | 'video' }

const FIXTURES = new URL('../fixtures/media/', import.meta.url);
const MEDIA: Fixture[] = [
  { name: 'pattern.png', type: 'image/png', kind: 'image' },
  { name: 'pattern.jpg', type: 'image/jpeg', kind: 'image' },
  { name: 'pattern.gif', type: 'image/gif', kind: 'image' },
  { name: 'pattern.webp', type: 'image/webp', kind: 'image' },
  { name: 'pattern.svg', type: 'image/svg+xml', kind: 'image' },
  { name: 'clip.mp4', type: 'video/mp4', kind: 'video' },
  { name: 'clip.webm', type: 'video/webm', kind: 'video' },
  { name: 'clip.mov', type: 'video/quicktime', kind: 'video' },
];
const PNG = MEDIA[0];
const WEBM = MEDIA[6];
const IMAGES = MEDIA.filter((file) => file.kind === 'image').length;
const VIDEOS = MEDIA.length - IMAGES;
const ALT = 'Green stripes on a test card';

const bytes = (name: string) => readFileSync(new URL(name, FIXTURES));
const payload = (files: Fixture[]) => files.map((file) => ({ ...file, base64: bytes(file.name).toString('base64') }));

async function openShell(actors: Actors, label: string, path = '/'): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label), { path });
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  return actor;
}

async function newNote(actor: Actor, title: string): Promise<string> {
  const docId = await ui.createNote(actor);
  await ui.typeTitle(actor, docId, title, { enter: true });
  await ui.typeBody(actor, docId, 'Uploads');
  return docId;
}

async function waitAcked(actor: Actor, docId: string): Promise<void> {
  await expect(ui.pane(actor, docId), `${actor.label}: the DocDO acks every change`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: UPLOAD_TIMEOUT });
}

const images = (actor: Actor, docId: string) => ui.body(actor, docId).locator('img[src*="/assets/"]');
const videos = (actor: Actor, docId: string) => ui.body(actor, docId).locator('[data-video-node-kind="local"]');

/** Every uploaded image in the pane decodes, scrolled into view first (moss loads them lazily). */
async function expectImagesDecode(actor: Actor, docId: string, count: number): Promise<void> {
  await expect(images(actor, docId), `${actor.label}: ${count} images render`).toHaveCount(count, { timeout: UPLOAD_TIMEOUT });
  for (const image of await images(actor, docId).all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), {
      message: `${actor.label}: ${await image.getAttribute('src')} decodes`, timeout: UPLOAD_TIMEOUT,
    }).toBe(true);
  }
  await expect(ui.body(actor, docId).getByText(/could not be found|isn.t available on the web/), `${actor.label}: no missing-media fallback`).toHaveCount(0);
}

async function expectVideos(actor: Actor, docId: string, count: number): Promise<void> {
  await expect(videos(actor, docId), `${actor.label}: ${count} videos render`).toHaveCount(count, { timeout: UPLOAD_TIMEOUT });
  await expect(ui.body(actor, docId).locator('[data-video-error-state]'), `${actor.label}: no video fallback`).toHaveCount(0);
}

/** A browser file drop on the body: dragenter, dragover, then drop, carrying `files`. */
async function drop(actor: Actor, docId: string, files: Fixture[]): Promise<boolean> {
  const box = await ui.body(actor, docId).boundingBox();
  if (!box) throw new Error(`${actor.label}: the body has no box`);
  return ui.body(actor, docId).evaluate((root, { files, x, y }) => {
    const data = new DataTransfer();
    for (const file of files) {
      data.items.add(new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
    }
    const init = { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true };
    root.dispatchEvent(new DragEvent('dragenter', init));
    root.dispatchEvent(new DragEvent('dragover', init));
    const event = new DragEvent('drop', init);
    root.dispatchEvent(event);
    return event.defaultPrevented;
  }, { files: payload(files), x: box.x + 24, y: box.y + 12 });
}

/** The caret at the end of the note's first line, where each paste and the slash command land. */
async function caretAfterFirstLine(actor: Actor, docId: string): Promise<void> {
  await ui.body(actor, docId).getByText('Uploads', { exact: true }).click();
  await actor.page.keyboard.press('End');
}

/** A clipboard paste of one file, as a copied file or a screenshot arrives. */
async function paste(actor: Actor, docId: string, file: Fixture): Promise<boolean> {
  await caretAfterFirstLine(actor, docId);
  return ui.body(actor, docId).evaluate((root, file) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    root.dispatchEvent(event);
    return event.defaultPrevented;
  }, payload([file])[0]);
}

const origin = (actor: Actor) => new URL(actor.page.url()).origin;

test('j11-media: drop, paste and /media → From computer upload every moss type, which renders and survives a reload; a viewer cannot upload @p:note-8 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada, 'Every media type');

  // Drop all eight at once.
  expect(await drop(ada, docId, MEDIA), 'the editor takes the dropped files').toBe(true);
  await expectImagesDecode(ada, docId, IMAGES);
  await expectVideos(ada, docId, VIDEOS);

  // Paste each, one file per paste.
  for (const file of MEDIA) {
    expect(await paste(ada, docId, file), `the editor takes the pasted ${file.type}`).toBe(true);
    const count = file.kind === 'image' ? images(ada, docId) : videos(ada, docId);
    await expect.poll(() => count.count(), { message: `the pasted ${file.name} lands`, timeout: UPLOAD_TIMEOUT })
      .toBe((file.kind === 'image' ? IMAGES : VIDEOS) + 1 + MEDIA.filter((f) => f.kind === file.kind).indexOf(file));
  }

  // "/media", then "From computer", then the browser's file chooser with all eight.
  await caretAfterFirstLine(ada, docId);
  await ada.page.keyboard.press('Enter');
  await ada.page.keyboard.type('/media');
  await expect(ada.page.locator('button[data-index]').filter({ hasText: 'Media' })).toHaveCount(1);
  await ada.page.keyboard.press('Enter');
  const chooser = ada.page.waitForEvent('filechooser', { timeout: BIND_TIMEOUT });
  await ada.page.getByRole('button', { name: /From computer/ }).click();
  await (await chooser).setFiles(MEDIA.map((file) => ({ name: file.name, mimeType: file.type, buffer: bytes(file.name) })));
  await expectImagesDecode(ada, docId, IMAGES * 3);
  await expectVideos(ada, docId, VIDEOS * 3);
  await waitAcked(ada, docId);

  // A reload renders the same media from the server.
  ada.expectReconnects(1, docId);
  await ada.page.reload();
  await ui.waitLive(ada, docId);
  await ada.declareRemount(docId);
  await expectImagesDecode(ada, docId, IMAGES * 3);
  await expectVideos(ada, docId, VIDEOS * 3);
  await actors.checkpoint('uploaded');

  // The export keeps moss's relative form; identical bytes under one name are one asset.
  const exported = await (await ada.context.request.get(`/api/docs/${docId}/export`)).text();
  for (const file of MEDIA) expect(exported, `the export references ${file.name}`).toContain(`(assets/${file.name})`);
  expect(exported).not.toContain('/api/docs/');
  const svg = await ada.context.request.get(`/api/docs/${docId}/assets/pattern.svg`);
  expect(svg.headers()['content-security-policy'], 'SVG is sandboxed').toMatch(/^sandbox\b/);
  expect(svg.headers()['x-content-type-options']).toBe('nosniff');

  // A PDF is not media.
  const pdf = await ada.context.request.post(`/api/docs/${docId}/assets?filename=not-media.pdf`, {
    headers: { origin: origin(ada), 'content-type': 'application/pdf' }, data: bytes('not-media.pdf'),
  });
  expect(pdf.status(), 'a PDF upload is refused as an unsupported type').toBe(415);

  // Ben reads at viewer: the media renders, and he has no way to upload.
  await grantDoc(ada, docId, benPrincipal, 'viewer');
  const ben = await openShell(actors, 'ben', `/d/${docId}`);
  await actors.requireDistinct(2);
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
  await expectImagesDecode(ben, docId, IMAGES * 3);
  const uploads: string[] = [];
  ben.page.on('request', (request) => {
    if (request.method() === 'POST' && /\/assets/.test(request.url())) uploads.push(request.url());
  });
  await ui.body(ben, docId).click();
  await ben.page.keyboard.type('/media');
  await expect(ben.page.locator('button[data-index]'), 'a viewer gets no slash menu').toHaveCount(0);
  await drop(ben, docId, [PNG]);
  await paste(ben, docId, PNG);
  await expect(images(ben, docId), 'nothing lands in a read-only note').toHaveCount(IMAGES * 3);
  expect(uploads, 'a viewer sends no upload').toEqual([]);
  const raw = await ben.context.request.post(`/api/docs/${docId}/assets?filename=pattern.png`, {
    headers: { origin: origin(ben), 'content-type': 'image/png' }, data: bytes(PNG.name),
  });
  expect(raw.status(), 'a raw upload by a viewer is forbidden').toBe(403);
});

test('j11-media: a copied note keeps its media in its folder and in the copier\'s Home; link readers see it; video plays through 206 @p:note-8', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada, 'Media to copy');
  expect(await drop(ada, docId, [PNG, WEBM])).toBe(true);
  await expectImagesDecode(ada, docId, 1);
  await expectVideos(ada, docId, 1);
  await waitAcked(ada, docId);

  // The video plays from the asset route, which answers the player's Range requests with 206.
  const partial: number[] = [];
  ada.page.on('response', (response) => {
    if (response.url().includes(`/assets/${WEBM.name}`)) partial.push(response.status());
  });
  await videos(ada, docId).click();
  const player = ui.body(ada, docId).locator('video');
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState), { message: 'the video has frames', timeout: UPLOAD_TIMEOUT })
    .toBeGreaterThanOrEqual(2);
  expect(partial, 'the player read the video through Range').toContain(206);

  // Duplicate in Ada's folder.
  await ada.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  const copyPane = ada.page.locator(`[${EDITOR_PANE_ATTR}]:not([${NAMES.docId}="${docId}"])`);
  await expect(copyPane).toHaveCount(1, { timeout: BIND_TIMEOUT });
  const copyId = (await copyPane.getAttribute(NAMES.docId)) ?? '';
  await ui.waitLive(ada, copyId);
  await ada.declareRemount(copyId);
  await expectImagesDecode(ada, copyId, 1);
  await expectVideos(ada, copyId, 1);

  // Ben edits only this note, so his copy lands in his own Home, and its media comes with it.
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openShell(actors, 'ben', `/d/${docId}`);
  await actors.requireDistinct(2);
  await ui.waitLive(ben, docId);
  await ben.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`).click({ button: 'right' });
  await ben.page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  const benCopy = ben.page.locator(`[${EDITOR_PANE_ATTR}]:not([${NAMES.docId}="${docId}"])`);
  await expect(benCopy).toHaveCount(1, { timeout: BIND_TIMEOUT });
  const benCopyId = (await benCopy.getAttribute(NAMES.docId)) ?? '';
  await ui.waitLive(ben, benCopyId);
  await ben.declareRemount(benCopyId);
  const folderOf = async (actor: Actor, id: string) =>
    ((await (await actor.context.request.get(`/api/docs/${id}`)).json()) as { doc: { folderId: string } }).doc.folderId;
  expect(await folderOf(ben, benCopyId), "Ben's copy is in another folder").not.toBe(await folderOf(ada, docId));
  await expectImagesDecode(ben, benCopyId, 1);
  await expectVideos(ben, benCopyId, 1);
  await actors.checkpoint('copied');

  // A signed-in reader with only a link sees the media through it.
  const token = await stack.shareLink(docId, 'viewer');
  const cy = await openShell(actors, 'cy', `/d/${docId}?share=${encodeURIComponent(token)}`);
  await expect(ui.body(cy, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
  await expectImagesDecode(cy, docId, 1);
  await expectVideos(cy, docId, 1);
  const src = (await images(cy, docId).getAttribute('src')) ?? '';
  expect(src, "the image URL carries the reader's link").toContain(`share=${encodeURIComponent(token)}`);

  // An anonymous visitor holding the link gets the same bytes, and Range for video; a forged link gets the 404.
  const anon = await actors.anonymous('/login');
  const width = await anon.page.evaluate((url) => new Promise<number>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth);
    image.onerror = () => resolve(0);
    image.src = url;
  }), src);
  expect(width, 'an anonymous browser holding the link renders the image').toBeGreaterThan(0);
  const webm = await anon.context.request.get(`/api/docs/${docId}/assets/${WEBM.name}?share=${encodeURIComponent(token)}`, { headers: { range: 'bytes=0-99' } });
  expect(webm.status(), 'an anonymous video read is a 206').toBe(206);
  expect((await anon.context.request.get(`/api/docs/${docId}/assets/${PNG.name}?share=forged`)).status()).toBe(404);
  expect((await anon.context.request.get(`/api/docs/${docId}/assets/${PNG.name}`)).status()).toBe(404);
});

test("j11-media: alt text edited from the image's context menu reaches the peer and the export @p:note-8", async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada, 'Alt text');
  expect(await drop(ada, docId, [PNG])).toBe(true);
  await expectImagesDecode(ada, docId, 1);
  await waitAcked(ada, docId);
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openShell(actors, 'ben', `/d/${docId}`);
  await actors.requireDistinct(2);
  await ui.waitLive(ben, docId);
  await expectImagesDecode(ben, docId, 1);

  await images(ada, docId).click({ button: 'right' });
  const item = ada.page.getByRole('menuitem', { name: 'Edit Alt Text…', exact: true });
  await expect(item, 'the image context menu offers Edit Alt Text…').toBeVisible();
  await item.click();
  const field = ui.body(ada, docId).getByRole('textbox', { name: 'Alt text' });
  await expect(field, "moss's alt-text editor opens focused").toBeFocused();
  await field.fill(ALT);
  await field.press('Enter');
  await expect(images(ada, docId)).toHaveAttribute('alt', ALT);
  await expect(images(ben, docId), 'the peer sees the new alt text').toHaveAttribute('alt', ALT, { timeout: PEER_TIMEOUT });
  await waitAcked(ada, docId);
  await expect.poll(async () => (await ada.context.request.get(`/api/docs/${docId}/export`)).text(), { message: 'the export carries the alt text' })
    .toContain(`![${ALT}](assets/${PNG.name})`);

  // A plain right-click elsewhere in the note keeps the browser's own menu.
  await ui.body(ada, docId).getByText('Uploads', { exact: true }).click({ button: 'right' });
  await expect(ada.page.getByRole('menuitem', { name: 'Edit Alt Text…' })).toHaveCount(0);
});
