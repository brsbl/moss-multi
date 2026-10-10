// j09-revoke-live (T2.5): access taken away reaches open windows at once, through the one kick path. Ada lowers Ben
// from edit to view and his socket closes 4403 within a second, his note turning read-only with a message; removing
// him ends the note for him (`revoked`). Revoking a link closes everyone who opened the note through it, signed in or
// not. Signing out in one window ends the same session's other window (`session-ended`). Cold: in the idle window a
// DocDO hibernates in, a revoked doc link's and a revoked folder link's holders land no frame after the wake.
import { randomBytes } from 'node:crypto';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, DOC_STATE_ATTR, ROLE_ATTR, SYNC_UNACKED_ATTR,
  TERMINAL_REASON_ATTR, paneSelector,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { IDLE_MS, inductionProblems } from '../lib/hibernate.ts';
import { visibility } from '../lib/idle.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const LIVE_TIMEOUT = 10_000;
const TEXT = 'Before anything changed, café';
const VIEW_ONLY = 'You can view this note but can no longer edit it.';
const ACCESS_ASK = /\/api\/docs\/[^/]+\/access/;

/** Every doc-socket close the page sees, with its code and the wall clock (A§10.5). Installed before the app loads. */
async function recordCloses(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const closes: { url: string; code: number; at: number }[] = [];
    (window as unknown as { __closes: typeof closes }).__closes = closes;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('close', (event) => closes.push({ url: String(url), code: event.code, at: Date.now() }));
      }
    };
  });
}

const closes = (page: Page) => page.evaluate(() => (window as unknown as { __closes: { url: string; code: number; at: number }[] }).__closes);

async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label));
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

/** "+ Note" with text the DocDO has acked. */
async function noteWithText(ada: Actor): Promise<string> {
  const docId = await ui.createNote(ada);
  await ui.typeBody(ada, docId, TEXT);
  await expect(ui.pane(ada, docId), 'the DocDO acks the text').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: LIVE_TIMEOUT });
  return docId;
}

/** A person's (or an invite's) access in the owner's Share dialog: glyphdown's role select and Remove button. */
const accessSelect = (dialog: Locator, who: string): Locator => dialog.getByRole('combobox', { name: `Access for ${who}`, exact: true });

async function chooseAccess(dialog: Locator, who: string, choice: ui.Access | 'Remove access'): Promise<void> {
  if (choice === 'Remove access') await dialog.getByRole('button', { name: `Remove ${who}`, exact: true }).click();
  else await accessSelect(dialog, who).selectOption({ label: choice });
}

/** Opens `path` as a signed-in principal with doc-socket closes recorded. */
async function openRecorded(actors: Actors, principal: Principal, path: string, label?: string): Promise<Actor> {
  const actor = await actors.session(principal, { label });
  await recordCloses(actor.context);
  await actor.goto(path);
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

async function expectRevoked(actor: Actor, docId: string): Promise<void> {
  await expect(ui.pane(actor, docId), `${actor.label}: the note ends for them in place`).toHaveAttribute(TERMINAL_REASON_ATTR, 'revoked', { timeout: LIVE_TIMEOUT });
  await expect(ui.pane(actor, docId)).toHaveAttribute(DOC_STATE_ATTR, 'terminal');
  await expect(ui.pane(actor, docId).locator(`[${CONNECTION_BANNER_ATTR}="revoked"]`), `${actor.label}: and says why`).toHaveText(/Your access to this note has ended\./);
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
}

test('j09 demotion: Ada lowers Ben from edit to view; his socket closes 4403 within 1 s and the note turns read-only with a message @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'editor');
  await actors.requireDistinct(2);
  // The read-only rebind opens one fresh socket after the 4403.
  ben.expectReconnects(1, docId);

  const dialog = await ui.openShare(ada, docId);
  await expect(accessSelect(dialog, benPrincipal.name), 'Ben is listed with his access').toHaveValue('editor');
  const patched = ada.page.waitForResponse((response) => response.url().endsWith(`/api/docs/${docId}/members`) && response.request().method() === 'PATCH');
  const sentAt = Date.now();
  await chooseAccess(dialog, benPrincipal.name, 'Can view');
  expect((await patched).status(), 'the demotion is saved').toBe(200);
  await expect(accessSelect(dialog, benPrincipal.name), "Ada's list shows the new access").toHaveValue('viewer');
  await expect(dialog.getByRole('status'), 'and says so').toContainText('Can view');

  await expect.poll(async () => (await closes(ben.page)).filter((c) => c.url.includes(`/parties/doc-d-o/${docId}`)).map((c) => c.code),
    { message: "Ben's doc socket closes 4403", timeout: LIVE_TIMEOUT }).toContain(4403);
  const kick = (await closes(ben.page)).find((c) => c.code === 4403);
  expect(kick!.at - sentAt, 'within 1 s of the demotion').toBeLessThan(1_000);

  await expect(ui.pane(ben, docId).locator('[data-input-refusal]'), 'Ben is told why he can no longer type').toHaveText(VIEW_ONLY, { timeout: LIVE_TIMEOUT });
  await ui.waitOpen(ben, docId, 'readonly');
  await expect(ui.pane(ben, docId), 'his pane reads at view').toHaveAttribute(ROLE_ATTR, 'viewer');
  expect(await ui.fieldText(ben, docId, 'body'), 'the content stays').toBe(TEXT);
  await actors.checkpoint('demoted');
  await ui.body(ben, docId).click({ force: true });
  await ben.page.keyboard.type('blocked');
  expect(await ui.fieldText(ben, docId, 'body'), 'a keystroke changes nothing').toBe(TEXT);
  expect(await ui.fieldText(ada, docId, 'body'), 'and nothing reaches Ada').toBe(TEXT);
});

test('j09 removal: removing a member ends the note for them in place (revoked) @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'live');
  await actors.requireDistinct(2);
  ben.expectHttp(404, ACCESS_ASK);

  const dialog = await ui.openShare(ada, docId);
  await chooseAccess(dialog, benPrincipal.name, 'Remove access');
  await expect(accessSelect(dialog, benPrincipal.name), 'Ben leaves the list').toHaveCount(0);
  await expectRevoked(ben, docId);
  expect(await ui.fieldText(ben, docId, 'body'), 'what he had read stays on screen').toBe(TEXT);
  await actors.checkpoint('removed');
  await expect(ben.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`), 'and the note leaves his list').toHaveCount(0, { timeout: LIVE_TIMEOUT });

  // Terminal: nothing reconnects.
  const opened = ben.telemetry.sockets.filter((s) => s.docId === docId).length;
  await ben.page.waitForTimeout(3_000);
  expect(ben.telemetry.sockets.filter((s) => s.docId === docId), 'no reconnect after revoked').toHaveLength(opened);
});

test('j09 demote then remove: removing Ben within 4 s of a demotion leaves only the ended notice (T3.S20) @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'live');
  await actors.requireDistinct(2);
  ben.expectReconnects(1, docId);
  ben.expectHttp(404, ACCESS_ASK);
  const refusal = ui.pane(ben, docId).locator('[data-input-refusal]');

  const dialog = await ui.openShare(ada, docId);
  await chooseAccess(dialog, benPrincipal.name, 'Can view');
  await expect(refusal, 'the demotion alone says the note is view-only').toHaveText(VIEW_ONLY, { timeout: LIVE_TIMEOUT });
  const shownAt = Date.now();
  await ui.waitOpen(ben, docId, 'readonly');
  await ui.body(ben, docId).click({ force: true });
  await ben.page.keyboard.type('blocked');

  await chooseAccess(dialog, benPrincipal.name, 'Remove access');
  await expect(ui.pane(ben, docId), 'the note ends for him').toHaveAttribute(TERMINAL_REASON_ATTR, 'revoked', { timeout: LIVE_TIMEOUT });
  const endedAt = Date.now();
  await expect(ui.pane(ben, docId).locator(`[${CONNECTION_BANNER_ATTR}="revoked"]`)).toHaveText(/Your access to this note has ended\./);
  await expect(refusal, 'and no longer says he can view it').not.toHaveText(VIEW_ONLY, { timeout: 1_000 });
  expect(Date.now() - shownAt, 'checked while the view-only notice would still show').toBeLessThan(3_800);
  expect(endedAt - shownAt).toBeLessThan(3_000);
  await actors.checkpoint('demoted-then-removed');
});

test('j09 link: revoking a link closes everyone who opened the note through it, signed in or not @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const dialog = await ui.openShare(ada, docId);
  const path = ui.pathOf(await ui.createLink(dialog, 'Can edit'));
  await ada.page.keyboard.press('Escape');

  const cy = await openRecorded(actors, await actors.principal('cy'), path);
  await ui.waitOpen(cy, docId, 'live');
  await expect(ui.pane(cy, docId), 'signed in without a grant, Cy rides the link at edit').toHaveAttribute(ROLE_ATTR, 'editor');
  const stranger = await actors.anonymous(path, { label: 'stranger' });
  await ui.waitOpen(stranger, docId, 'readonly');
  await actors.requireDistinct(2);
  for (const holder of [cy, stranger]) holder.expectHttp(404, ACCESS_ASK);

  const again = await ui.openShare(ada, docId);
  await ui.linkRow(again, 'Can edit').getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(ui.linkField(again, 'Can edit')).toHaveCount(0);
  await expectRevoked(cy, docId);
  await expectRevoked(stranger, docId);
  expect((await closes(cy.page)).map((c) => c.code), 'the link rider was closed 4403').toContain(4403);
  await actors.checkpoint('link-revoked');
});

test('j09 sign-out: signing out in one window ends the same session in the other (session-ended) @p:ppl-2 @p:ppl-1', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);

  // Window B: a second tab of Ada's session, on the same note.
  const windowB = await ada.context.newPage();
  const workspaceClosed = new Promise<void>((resolve) => {
    windowB.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname === '/api/workspace/ws') socket.on('close', () => resolve());
    });
  });
  await windowB.goto(`/d/${docId}`);
  await expect(windowB.locator(paneSelector(docId)), 'window B opens the note').toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(windowB.locator(`${paneSelector(docId)} [${BODY_BINDING_ATTR}]`)).toHaveAttribute(BODY_BINDING_ATTR, 'live');

  await ui.signOutThroughSettings(ada);
  await ada.page.waitForURL((at) => at.pathname === '/login', { timeout: 30_000 });

  const paneB = windowB.locator(paneSelector(docId));
  await expect(paneB, 'window B ends in place').toHaveAttribute(TERMINAL_REASON_ATTR, 'session-ended', { timeout: LIVE_TIMEOUT });
  await expect(paneB.locator(`[${CONNECTION_BANNER_ATTR}="session-ended"]`)).toContainText('Your session has ended.');
  await expect(paneB.getByRole('button', { name: 'Sign in', exact: true }), 'and offers sign-in').toBeVisible();
  await expect(paneB.locator(`[${BODY_BINDING_ATTR}]`)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
  await workspaceClosed;
  await windowB.close();

  // Ben's session is untouched.
  await expect(ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`)).toBeAttached();
  expect((await ben.context.request.get('/api/me')).status()).toBe(200);
});

test('j09 cold: after an idle wake, a revoked doc link and a revoked folder link land no frame @hibernate @slow @p:ppl-2 @p:tech-6', async ({ actors, stack }, info) => {
  test.setTimeout(300_000);
  // Ada works over the API only: an open shell shows the most recently edited note, so the holders' typing would
  // switch her window between their notes and keep their DOs awake.
  const ada = await actors.session(await actors.principal('ada'));
  const headers = { origin: stack.baseUrl };
  // Declared setup over the API: a note with an editor link, and a folder holding a subfolder note with an editor
  // folder link. The links' revocation is what this leg proves, so it is the decisive action.
  const { vault } = (await (await ada.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  const made = await ada.context.request.post('/api/folders', { headers, data: { name: `Cold ${randomBytes(2).toString('hex')}`, parentId: vault.id } });
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  const sub = await ada.context.request.post('/api/folders', { headers, data: { name: 'Inner', parentId: folderId } });
  const subId = ((await sub.json()) as { folder: { id: string } }).folder.id;
  const docNote = await ada.context.request.post('/api/docs', { headers, data: { title: 'Doc-linked' } });
  const folderNote = await ada.context.request.post('/api/docs', { headers, data: { folderId: subId, title: 'Folder-linked' } });
  const docId = ((await docNote.json()) as { doc: { id: string } }).doc.id;
  const deepId = ((await folderNote.json()) as { doc: { id: string } }).doc.id;
  const link = async (path: string) => ((await (await ada.context.request.post(path, { headers, data: { role: 'editor' } })).json()) as { link: { token: string } }).link.token;
  const docToken = await link(`/api/docs/${docId}/links`);
  const folderToken = await link(`/api/folders/${folderId}/links`);

  const cy = await actors.principal('cy');
  const holders = [
    { docId, actor: await openRecorded(actors, cy, `/d/${docId}?share=${docToken}`, 'cy-doc'), text: ' doc-holder before' },
    { docId: deepId, actor: await openRecorded(actors, cy, `/d/${deepId}?share=${folderToken}`, 'cy-folder'), text: ' folder-holder before' },
  ];
  for (const holder of holders) {
    await ui.waitOpen(holder.actor, holder.docId, 'live');
    await ui.typeBody(holder.actor, holder.docId, holder.text);
    await expect(ui.pane(holder.actor, holder.docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: LIVE_TIMEOUT });
    holder.actor.expectHttp(404, ACCESS_ASK);
  }
  await actors.requireDistinct(2);

  const baseline = await Promise.all(holders.map((h) => stack.docInstance(h.docId)));
  // Every window goes quiet: a visible tab's resync keeps its DO awake.
  for (const holder of holders) await visibility(holder.actor, true);
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));

  const decisiveAt = Date.now();
  expect((await ada.context.request.delete(`/api/docs/${docId}/links/${docToken}`, { headers })).status()).toBe(200);
  expect((await ada.context.request.delete(`/api/folders/${folderId}/links/${folderToken}`, { headers })).status()).toBe(200);
  for (const [index, holder] of holders.entries()) {
    const after = await stack.docInstance(holder.docId);
    await info.attach(`cold-${index}-instance.json`, { body: JSON.stringify({ base: baseline[index], after, decisiveAt }), contentType: 'application/json' });
    expect(inductionProblems(baseline[index], after, decisiveAt), 'the revocation met a woken DO').toEqual([]);
  }

  for (const holder of holders) {
    await visibility(holder.actor, false);
    await holder.actor.page.keyboard.type(' after the wake');
    await expectRevoked(holder.actor, holder.docId);
  }
  // The owner reads both notes fresh: nothing typed after the revocation landed.
  for (const holder of holders) {
    const reader = await actors.session(ada.principal as Principal, { label: `reader-${holder.docId.slice(0, 4)}` });
    await reader.goto(`/d/${holder.docId}`);
    await ui.waitOpen(reader, holder.docId, 'live');
    const text = await ui.fieldText(reader, holder.docId, 'body');
    expect(text, 'what the holder typed before the revocation is there').toContain(holder.text.trim());
    expect(text, 'nothing typed after it landed').not.toContain('after the wake');
  }
});
