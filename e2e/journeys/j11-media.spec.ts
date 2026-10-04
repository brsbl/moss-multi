// j11-media (T3.1; A§16, A§9 images): moss's media set uploads from the web. Ada drops, pastes and picks (the slash
// menu's /media → "From computer") one of every moss type into a note: png, jpg, gif, webp, svg, mp4, webm and mov;
// each renders and survives a reload, and the export keeps moss's relative `assets/` paths. A viewer gets no upload
// control and a raw upload gets 403; a PDF gets 415. A note's media are its own: a copy shows the source's files even
// in a Home whose other note holds a different file under the same name, and a note moved into a folder holding a
// same-named file keeps showing its own. A signed-in link reader sees the media, and an anonymous one opens the note
// through the link and sees them too; a signed-in editor-link holder uploads; a grant or link on the note reaches only
// the media placed in it, even after an editor writes another note's file name into it. A video's poster is its first
// frame, and it seeks and plays through 206 responses. Alt text edited from the image's context menu reaches the peer
// and the export. A paste over a selection replaces it at once, and while its upload is held both peers' typing
// survives and the media lands between the same characters.
//
// Grants and links are declared setup through the members and links APIs; sharing is not this journey's promise.
// Files reach the editor as browsers deliver them: a DataTransfer on drop and paste, and the file chooser for
// "From computer".
import { readFileSync } from 'node:fs';
import type { Actor, Actors } from '../lib/actors.ts';
import { APP_STATE_ATTR, BODY_BINDING_ATTR, EDITOR_PANE_ATTR, NAMES, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { grantDoc, linkDoc } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
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
const GIF = MEDIA[2];
const WEBM = MEDIA[6];
const IMAGES = MEDIA.filter((file) => file.kind === 'image').length;
const VIDEOS = MEDIA.length - IMAGES;
const ALT = 'Green stripes on a test card';

const bytes = (name: string) => readFileSync(new URL(name, FIXTURES));
const payload = (files: Fixture[]) => files.map((file) => ({ ...file, base64: bytes(file.name).toString('base64') }));

async function openShell(actors: Actors, who: string | Principal, path = '/'): Promise<Actor> {
  const actor = await actors.open(typeof who === 'string' ? await actors.principal(who) : who, { path });
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

/**
 * The video's poster is its own first frame, decoded and painted with real content: never the blank box moss shows
 * while a desktop-derived thumbnail is missing.
 */
async function expectPoster(actor: Actor, docId: string): Promise<void> {
  const poster = videos(actor, docId).locator('video[data-video-thumbnail-state="frame"]');
  await expect(poster, `${actor.label}: the video shows a frame as its poster`).toHaveCount(1, { timeout: UPLOAD_TIMEOUT });
  await expect.poll(() => poster.evaluate((video: HTMLVideoElement) => {
    if (video.readyState < 2 || !video.videoWidth) return 0;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) colors.add(((pixels[i] >> 5) << 6) | ((pixels[i + 1] >> 5) << 3) | (pixels[i + 2] >> 5));
    return colors.size;
  }), { message: `${actor.label}: the poster paints the clip's first frame`, timeout: UPLOAD_TIMEOUT }).toBeGreaterThanOrEqual(4);
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

/**
 * The caret at the end of the note's first line, where each paste and the slash command land. Lexical reads the
 * browser's selection on `selectionchange`, a task after the key, so the paste waits until it has.
 */
async function caretAfterFirstLine(actor: Actor, docId: string): Promise<void> {
  const line = ui.body(actor, docId).getByText('Uploads', { exact: true });
  await line.click();
  await actor.page.keyboard.press('End');
  await expect.poll(() => line.evaluate((el) => {
    const selection = document.getSelection();
    return !!selection?.isCollapsed && el.contains(selection.focusNode) && selection.focusOffset === (selection.focusNode?.textContent ?? '').length;
  }), { message: `${actor.label}: the caret ends the first line` }).toBe(true);
  await actor.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** A clipboard paste of one file, as a copied file or a screenshot arrives. */
async function paste(actor: Actor, docId: string, file: Fixture, caret = true): Promise<boolean> {
  if (caret) await caretAfterFirstLine(actor, docId);
  return ui.body(actor, docId).evaluate((root, file) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    root.dispatchEvent(event);
    return event.defaultPrevented;
  }, payload([file])[0]);
}

const origin = (actor: Actor) => new URL(actor.page.url()).origin;

/** Declared setup: `file`'s name with `data` uploaded into `docId` through the asset API. */
async function upload(actor: Actor, docId: string, file: Fixture, data: Buffer): Promise<void> {
  const response = await actor.context.request.post(`/api/docs/${docId}/assets?filename=${encodeURIComponent(file.name)}`, {
    headers: { origin: origin(actor), 'content-type': file.type }, data,
  });
  expect(response.status(), `${actor.label}: ${file.name} is uploaded`).toBe(201);
}

/** Declared setup: a note of `actor`'s in `folderId` that holds `file` with other bytes, as another note's media. */
async function noteHolding(actor: Actor, folderId: string, file: Fixture, data: Buffer): Promise<string> {
  const made = await actor.context.request.post('/api/docs', {
    headers: { origin: origin(actor), 'content-type': 'application/json' }, data: { folderId, title: `Holds ${file.name}` },
  });
  expect(made.status(), `${actor.label}: a note in the folder`).toBe(201);
  const docId = ((await made.json()) as { doc: { id: string } }).doc.id;
  await upload(actor, docId, file, data);
  return docId;
}

/** The byte length the image's own URL serves now, past the browser's cache. */
const shownBytes = (image: ReturnType<typeof images>) =>
  image.evaluate(async (img: HTMLImageElement) => (await (await fetch(img.currentSrc, { cache: 'no-store' })).arrayBuffer()).byteLength);

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
  await ada.page.getByRole('option', { name: /From computer/ }).click();
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
  const exported = await (await ada.context.request.get(`/api/docs/${docId}/content`)).text();
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
  const ben = await openShell(actors, benPrincipal, `/d/${docId}`);
  await actors.requireDistinct(2);
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
  await expectImagesDecode(ben, docId, IMAGES * 3);
  const uploads: string[] = [];
  ben.page.on('request', (request) => {
    if (request.method() === 'POST' && /\/assets/.test(request.url())) uploads.push(request.url());
  });
  await ui.body(ben, docId).click({ force: true });
  await ben.page.keyboard.type('/media');
  await expect(ben.page.locator('button[data-index]'), 'a viewer gets no slash menu').toHaveCount(0);
  await drop(ben, docId, [PNG]);
  await paste(ben, docId, PNG, false);
  await expect(images(ben, docId), 'nothing lands in a read-only note').toHaveCount(IMAGES * 3);
  expect(uploads, 'a viewer sends no upload').toEqual([]);
  const raw = await ben.context.request.post(`/api/docs/${docId}/assets?filename=pattern.png`, {
    headers: { origin: origin(ben), 'content-type': 'image/png' }, data: bytes(PNG.name),
  });
  expect(raw.status(), 'a raw upload by a viewer is forbidden').toBe(403);
});

test('j11-media: a copied or moved note keeps its media; link readers see only the note\'s own media; an editor link uploads; video plays and seeks through 206 @p:note-8 @evidence', async ({ actors, browserName }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada, 'Media to copy');
  // Every read of the clip, the poster's and the player's (WebKit's player may reuse what the poster read).
  const partial: number[] = [];
  const rangedReads: number[] = [];
  ada.page.on('response', (response) => {
    if (!new URL(response.url()).pathname.endsWith(`/assets/${WEBM.name}`)) return;
    partial.push(response.status());
    if (response.request().headers().range) rangedReads.push(response.status());
  });
  expect(await drop(ada, docId, [PNG, WEBM])).toBe(true);
  await expectImagesDecode(ada, docId, 1);
  await expectVideos(ada, docId, 1);
  await waitAcked(ada, docId);

  // The video plays from the asset route, which answers the player's Range requests with 206.
  await expectPoster(ada, docId);
  await actors.checkpoint('poster');
  await videos(ada, docId).click();
  const player = ui.body(ada, docId).locator('video:not([data-video-thumbnail-state])');
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState), { message: 'the video has frames', timeout: UPLOAD_TIMEOUT })
    .toBeGreaterThanOrEqual(2);
  // It seeks and plays in both engines: WebKit plays a clip only from a server that honors Range.
  const seekedTo = await player.evaluate((video: HTMLVideoElement) => new Promise<number>((resolve, reject) => {
    video.muted = true;
    video.pause();
    const target = Number.isFinite(video.duration) && video.duration > 0 ? video.duration / 2 : 0.5;
    video.addEventListener('seeked', () => resolve(video.currentTime), { once: true });
    video.addEventListener('error', () => reject(new Error(`media error ${video.error?.code}`)), { once: true });
    video.currentTime = target;
  }));
  expect(seekedTo, 'the player seeks into the clip').toBeGreaterThan(0);
  await player.evaluate((video: HTMLVideoElement) => {
    video.currentTime = 0;
    return video.play();
  });
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime), { message: 'the clip plays', timeout: UPLOAD_TIMEOUT })
    .toBeGreaterThan(0.1);
  await player.evaluate((video: HTMLVideoElement) => video.pause());
  // WebKit reports a media read it cancels or answers from its cache with status 0.
  const answered = partial.filter((status) => status > 0);
  expect(answered.length, 'the clip was read from the asset route').toBeGreaterThan(0);
  expect(answered.filter((status) => ![200, 206, 304].includes(status)), 'every read of the clip succeeds or revalidates').toEqual([]);
  expect(rangedReads.filter((status) => ![0, 206, 304].includes(status)), 'every ranged read of the clip is answered 206').toEqual([]);
  // Chromium's player always reads in ranges; WebKit may read a small file whole.
  if (browserName === 'chromium') expect(partial, "the player's reads are ranged").toContain(206);
  const ranged = await ada.page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { range: 'bytes=0-99' } });
    return { status: response.status, range: response.headers.get('content-range'), length: (await response.arrayBuffer()).byteLength };
  }, (await player.getAttribute('src')) ?? '');
  expect(ranged, 'the video URL answers Range with 206').toEqual({ status: 206, range: expect.stringMatching(/^bytes 0-99\/\d+$/), length: 100 });

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

  // Ben edits only this note, so his copy lands in his own Home, and its media comes with it. A note in his Home
  // already has a different pattern.png, as most Homes already hold a pasted `image.png`: the copy still shows Ada's.
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openShell(actors, benPrincipal, `/d/${docId}`);
  await actors.requireDistinct(2);
  await ui.waitLive(ben, docId);
  const { vault: benHome } = (await (await ben.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  await noteHolding(ben, benHome.id, PNG, Buffer.concat([bytes(PNG.name), Buffer.from('his own file')]));
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
  await expect(images(ben, benCopyId), "the copy keeps the source's reference").toHaveAttribute('src', new RegExp(`/assets/${PNG.name}`));
  expect(await shownBytes(images(ben, benCopyId)), "Ben's copy shows Ada's image, not the file his Home already had")
    .toBe(bytes(PNG.name).byteLength);
  await actors.checkpoint('copied');

  // A grant on this note reaches only the media placed in it: never a file another of Ada's notes holds.
  const adaFolder = await folderOf(ada, docId);
  const secretNote = await noteHolding(ada, adaFolder, { ...PNG, name: 'secret.png' }, Buffer.concat([bytes(PNG.name), Buffer.from('another note')]));
  expect((await ada.context.request.get(`/api/docs/${secretNote}/assets/secret.png`)).status(), 'its own note shows it').toBe(200);
  expect((await ben.context.request.get(`/api/docs/${docId}/assets/secret.png`)).status(), "the note's grant does not reach it").toBe(404);
  expect((await ada.context.request.get(`/api/docs/${docId}/assets/secret.png`)).status(), 'nor does the folder owner read it through this note').toBe(404);

  // A signed-in reader with only a link sees the media through it.
  const token = await linkDoc(ada, docId, 'viewer');
  const cy = await openShell(actors, 'cy', `/d/${docId}?share=${encodeURIComponent(token)}`);
  await expect(ui.body(cy, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
  await expectImagesDecode(cy, docId, 1);
  await expectVideos(cy, docId, 1);
  const src = (await images(cy, docId).getAttribute('src')) ?? '';
  expect(src, "the image URL carries the reader's link").toContain(`share=${encodeURIComponent(token)}`);

  // An anonymous visitor opens the note through the link and sees its image and its video's poster; a forged link
  // gets the 404.
  const anon = await actors.anonymous(`/d/${docId}?share=${encodeURIComponent(token)}`, { label: 'anon' });
  await expect(ui.body(anon, docId), 'the anonymous visitor reads the note').toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BOOT_TIMEOUT });
  await expectImagesDecode(anon, docId, 1);
  await expectVideos(anon, docId, 1);
  await expectPoster(anon, docId);
  await actors.checkpoint('anonymous-link');
  const webm = await anon.context.request.get(`/api/docs/${docId}/assets/${WEBM.name}?share=${encodeURIComponent(token)}`, { headers: { range: 'bytes=0-99' } });
  expect(webm.status(), 'an anonymous video read is a 206').toBe(206);
  expect((await anon.context.request.get(`/api/docs/${docId}/assets/${PNG.name}?share=forged`)).status()).toBe(404);
  expect((await anon.context.request.get(`/api/docs/${docId}/assets/${PNG.name}`)).status()).toBe(404);

  // A signed-in holder of an editor link adds media as she types: the upload carries her link.
  const editorToken = await linkDoc(ada, docId, 'editor');
  const dee = await openShell(actors, 'dee', `/d/${docId}?share=${encodeURIComponent(editorToken)}`);
  await ui.waitLive(dee, docId);
  expect(await drop(dee, docId, [GIF]), 'the editor takes the dropped file').toBe(true);
  await expectImagesDecode(dee, docId, 2);
  await expectVideos(dee, docId, 1);
  await waitAcked(dee, docId);

  // Ada moves the note into a folder whose own note holds a different pattern.png and a private.png: the note keeps
  // its references and shows its own files, live and after a reload, to a reader holding only the link.
  const made = await ada.context.request.post('/api/folders', {
    headers: { origin: origin(ada), 'content-type': 'application/json' }, data: { parentId: adaFolder, name: 'Moved media' },
  });
  expect(made.status(), 'declared setup: the destination folder').toBe(201);
  const destination = ((await made.json()) as { folder: { id: string } }).folder.id;
  const resident = await noteHolding(ada, destination, PNG, Buffer.concat([bytes(PNG.name), Buffer.from('already here')]));
  await upload(ada, resident, { ...PNG, name: 'private.png' }, Buffer.concat([bytes(PNG.name), Buffer.from('private')]));
  const moved = await ada.context.request.patch(`/api/docs/${docId}`, {
    headers: { origin: origin(ada), 'content-type': 'application/json' }, data: { folderId: destination },
  });
  expect(moved.status(), 'the note moves').toBe(200);
  expect(await folderOf(ada, docId)).toBe(destination);
  const after = await (await ada.context.request.get(`/api/docs/${docId}/content`)).text();
  expect(after, 'the moved note keeps its reference').toContain(`(assets/${PNG.name})`);
  expect(after, 'no reference is renamed').not.toContain('pattern-2');
  const ownImage = ui.body(dee, docId).locator(`img[src*="/assets/${PNG.name}"]`);
  await expect(ownImage).toHaveCount(1);
  dee.expectReconnects(1, docId);
  await dee.page.reload();
  await ui.waitLive(dee, docId);
  await dee.declareRemount(docId);
  await expectImagesDecode(dee, docId, 2);
  await expectVideos(dee, docId, 1);
  expect(await shownBytes(ownImage), "the moved note shows its own image, not the folder's").toBe(bytes(PNG.name).byteLength);
  const benRead = await ben.context.request.get(`/api/docs/${docId}/assets/${PNG.name}`);
  expect((await benRead.body()).byteLength, "Ben's grant reads the note's own image").toBe(bytes(PNG.name).byteLength);
  const clip = await dee.page.evaluate(async (url) => (await fetch(url, { headers: { range: 'bytes=0-9' } })).status,
    `/api/docs/${docId}/assets/${WEBM.name}?share=${encodeURIComponent(editorToken)}`);
  expect(clip, 'the moved clip still answers Range').toBe(206);
  await actors.checkpoint('moved');

  // Writing a reference to a file of the folder into the note does not reach it: Dee, holding only an editor link,
  // pastes the text of a reference to the folder note's private.png, which the note never placed.
  const folderFile = `/api/docs/${docId}/assets/private.png`;
  const deeRead = () => dee.page.evaluate(async (url) => (await fetch(url, { cache: 'no-store' })).status, `${folderFile}?share=${encodeURIComponent(editorToken)}`);
  dee.expectHttp(404, folderFile);
  expect(await deeRead(), 'before the edit').toBe(404);
  await caretAfterFirstLine(dee, docId);
  await ui.body(dee, docId).evaluate((root, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, ' ![x](assets/private.png)');
  await waitAcked(dee, docId);
  await expect.poll(async () => (await ada.context.request.get(`/api/docs/${docId}/content`)).text(), { message: 'the export names the folder file' })
    .toContain('assets/private.png');
  expect(await deeRead(), 'the reference the editor wrote reaches nothing').toBe(404);
  expect((await ben.context.request.get(folderFile)).status(), "nor through Ben's grant").toBe(404);
  expect((await ada.context.request.get(folderFile)).status(), 'nor through the owner: only the note holding it shows it').toBe(404);
  expect((await ada.context.request.get(`/api/docs/${resident}/assets/private.png`)).status()).toBe(200);
});

test("j11-media: alt text edited from the image's context menu reaches the peer and the export @p:note-8", async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada, 'Alt text');
  expect(await drop(ada, docId, [PNG])).toBe(true);
  await expectImagesDecode(ada, docId, 1);
  await waitAcked(ada, docId);
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openShell(actors, benPrincipal, `/d/${docId}`);
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
  await expect.poll(async () => (await ada.context.request.get(`/api/docs/${docId}/content`)).text(), { message: 'the export carries the alt text' })
    .toContain(`![${ALT}](assets/${PNG.name})`);

  // A plain right-click elsewhere in the note keeps the browser's own menu.
  await ui.body(ada, docId).getByText('Uploads', { exact: true }).click({ button: 'right' });
  await expect(ada.page.getByRole('menuitem', { name: 'Edit Alt Text…' })).toHaveCount(0);
});

test('j11-media: a paste over a selection replaces it at once, and the held upload lands between the same characters while both peers type @p:note-8', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada, 'Held paste');
  await waitAcked(ada, docId);
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openShell(actors, benPrincipal, `/d/${docId}`);
  await actors.requireDistinct(2);
  await ui.waitLive(ben, docId);

  // Ada's upload is held until both peers have typed.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await ada.page.route((url) => url.pathname === `/api/docs/${docId}/assets`, async (route) => {
    await held;
    await route.continue();
  });

  // Ada selects "pl" in "Uploads" and pastes an image over it.
  const line = (actor: Actor) => ui.body(actor, docId).locator('p').filter({ hasText: /^(123)?U(pl)?oads!?$/ });
  await line(ada).click();
  await ada.page.keyboard.press('Home');
  await ada.page.keyboard.press('ArrowRight');
  await ada.page.keyboard.press('Shift+ArrowRight');
  await ada.page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => ada.page.evaluate(() => document.getSelection()?.toString()), { message: 'Ada selects "pl"' }).toBe('pl');
  await ada.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(await paste(ada, docId, PNG, false), 'the editor takes the pasted image').toBe(true);

  // While it uploads, Ben types at the line's start and Ada at its end.
  await line(ben).click();
  await ben.page.keyboard.press('Home');
  await ben.page.keyboard.type('123');
  await expect(line(ada), "Ben's text reaches Ada").toHaveText(/^123U/, { timeout: PEER_TIMEOUT });
  await line(ada).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.type('!');
  await expect(line(ben), "Ada's text reaches Ben").toHaveText(/!$/, { timeout: PEER_TIMEOUT });
  await expect(images(ada, docId), 'nothing lands while the upload is held').toHaveCount(0);

  release();
  await expectImagesDecode(ada, docId, 1);
  await expectImagesDecode(ben, docId, 1);
  await waitAcked(ada, docId);
  await waitAcked(ben, docId);
  const placed = `123U\n\n![${PNG.name}](assets/${PNG.name})\n\noads!`;
  await expect.poll(async () => (await ada.context.request.get(`/api/docs/${docId}/content`)).text(), {
    message: "the image replaces Ada's selection and deletes none of the text either peer typed", timeout: PEER_TIMEOUT,
  }).toContain(placed);
  for (const actor of [ada, ben]) {
    await expect(ui.body(actor, docId), `${actor.label}: both lines keep every character`).toContainText('123U');
    await expect(ui.body(actor, docId)).toContainText('oads!');
  }
});
