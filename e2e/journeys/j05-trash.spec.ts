// j05-trash (T2.3; A§8, A§10.5, A§10.6, A§11): delete is a 30-day trash. Ada, the owner, trashes a note from moss's
// own sidebar while Ben, an editor, types into it: every editable surface in Ben's window goes inert in place with
// `data-terminal-reason=deleted`, the content stays, nothing reconnects, and no window sees a 4xx afterwards. Ben,
// black-holed while the trash lands, goes terminal as soon as his network returns, in at most 3 handshakes. A fresh
// load gets the one 404. Ada's Trash view shows the note read-only with the 30-day promise; Restore brings it back
// live for both. A note dragged onto the sidebar's Trash button goes to Trash.
//
// Ben's editor grant is declared setup through the members API; sharing is not this journey's promise.
import type { Locator } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR, NAMES, SIDEBAR_ROW_ATTR,
  SYNC_UNACKED_ATTR, TERMINAL_REASON_ATTR, TITLE_BINDING_ATTR, paneSelector,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';
import { TRASH_COPY } from '../../packages/protocol/src/retention.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
/** BUILDPLAN T2.1: a peer's workspace change reaches an open sidebar within 5 s; the trash closes peers as fast. */
const PEER_MS = 5_000;
/** The reconnect ladder's first retry is about a second; a terminal doc must make none in several times that. */
const NO_RECONNECT_WINDOW_MS = 4_000;
const DENIAL = /doesn.t exist or you don.t have access/i;
const TITLE = 'Trash journey plan';
const BODY = 'Ada wrote this before the trash';
const toEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label));
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  return actor;
}

const noteRow = (actor: Actor, docId: string): Locator => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`);
const trashRow = (actor: Actor, docId: string): Locator => actor.page.locator(`[data-trash-row][${NAMES.docId}="${docId}"]`);
const banner = (actor: Actor, docId: string): Locator => ui.pane(actor, docId).locator(`[${CONNECTION_BANNER_ATTR}]`);
const docSockets = (actor: Actor, docId: string) => actor.telemetry.sockets.filter((socket) => socket.docId === docId && socket.epoch === actor.telemetry.epoch);
/** 4xx answers this window saw since `since`. */
const clientErrors = (actor: Actor, since: number) =>
  actor.telemetry.http.filter((entry) => entry.at >= since && entry.status >= 400 && entry.status < 500).map((entry) => `${entry.status} ${entry.method} ${entry.url}`);

/** Ada's note with a title and a body, acked, and Ben an editor on it (declared setup). */
async function sharedNote(actors: Actors, ben: Principal): Promise<{ ada: Actor; docId: string }> {
  const ada = await openShell(actors, 'ada');
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, TITLE, { enter: true });
  await ui.typeBody(ada, docId, BODY);
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await grantDoc(ada, docId, ben, 'editor');
  return { ada, docId };
}

/** Ada trashes the note from its row's context menu in moss's sidebar. */
async function trashFromSidebar(ada: Actor, docId: string): Promise<void> {
  await noteRow(ada, docId).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Trash', exact: true }).click();
}

/**
 * The attribute sweep: anything in the pane a person could still type into, focus or toggle. A terminal pane has
 * none, and its fields say why.
 */
async function editableSurfaces(actor: Actor, docId: string): Promise<string[]> {
  return actor.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    if (!pane) return ['no pane'];
    const found: string[] = [];
    for (const el of pane.querySelectorAll<HTMLElement>('*')) {
      const tag = el.tagName.toLowerCase();
      if (el.isContentEditable) found.push(`${tag}[contenteditable] ${el.textContent?.slice(0, 40) ?? ''}`);
      else if (el.matches('input, textarea, select') && !el.matches(':disabled') && !(el as HTMLInputElement).readOnly) found.push(`${tag} ${el.getAttribute('name') ?? ''}`);
    }
    return found;
  }, `${paneSelector(docId)} [data-editor-canvas]`);
}

/** Keystrokes into a terminal note land nowhere: the title and the body read as before. */
async function expectNoKeystrokeLands(actor: Actor, docId: string): Promise<void> {
  const before = { title: await ui.fieldText(actor, docId, 'title'), body: await ui.fieldText(actor, docId, 'body') };
  await ui.body(actor, docId).click({ force: true });
  await actor.page.keyboard.type('zombie body');
  await ui.title(actor, docId).click({ force: true });
  await actor.page.keyboard.type('zombie title');
  expect(await ui.fieldText(actor, docId, 'body'), `${actor.label}: the body takes no keystroke`).toBe(before.body);
  expect(await ui.fieldText(actor, docId, 'title'), `${actor.label}: the title takes no keystroke`).toBe(before.title);
}

async function expectTerminalInPlace(actor: Actor, docId: string, body: string | RegExp): Promise<void> {
  await expect(ui.pane(actor, docId), `${actor.label}: the note goes terminal in place`).toHaveAttribute(TERMINAL_REASON_ATTR, 'deleted', { timeout: PEER_MS });
  await expect(ui.pane(actor, docId)).toHaveAttribute(DOC_STATE_ATTR, 'terminal');
  await expect(ui.title(actor, docId)).toHaveAttribute(TITLE_BINDING_ATTR, 'terminal');
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
  expect(await editableSurfaces(actor, docId), `${actor.label}: the sweep finds no editable surface`).toEqual([]);
  await expect(ui.body(actor, docId), `${actor.label}: the content stays visible`).toHaveText(body);
  await expect(banner(actor, docId), `${actor.label}: the notice says why`).toHaveAttribute(CONNECTION_BANNER_ATTR, 'deleted');
  await expect(banner(actor, docId)).toContainText(TRASH_COPY.peerTrashed);
}

test('j05-trash: Ada trashes a note while Ben types; everything in Ben goes inert in place, nothing reconnects and nobody sees a 4xx @p:note-5 @evidence', async ({ actors }) => {
  const benPrincipal = await actors.principal('ben');
  const { ada, docId } = await sharedNote(actors, benPrincipal);
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await ui.waitLive(ben, docId);
  await ben.observeEditor(docId);
  await actors.requireDistinct(2);

  // Ben is mid-sentence when the trash lands; what he types after it goes nowhere.
  await ui.body(ben, docId).click();
  await ben.page.keyboard.press(toEnd);
  const typing = ben.page.keyboard.type(' and Ben keeps typing through it', { delay: 40 });
  const trashedAt = Date.now();
  await trashFromSidebar(ada, docId);
  await expectTerminalInPlace(ben, docId, new RegExp(`^${BODY}`));
  await typing;
  const opened = docSockets(ben, docId).length;
  await expectNoKeystrokeLands(ben, docId);

  await expect(noteRow(ada, docId), "the note leaves Ada's notes").toHaveCount(0, { timeout: PEER_MS });
  await expect(noteRow(ben, docId), "and Ben's, without a reload").toHaveCount(0, { timeout: PEER_MS });
  await ben.page.waitForTimeout(NO_RECONNECT_WINDOW_MS);
  expect(docSockets(ben, docId).length, 'a terminal note never reconnects').toBe(opened);
  for (const actor of [ada, ben]) expect(clientErrors(actor, trashedAt), `${actor.label}: no 4xx after the trash`).toEqual([]);
  await actors.checkpoint('trashed-under-ben');
});

test('j05-trash: Ben, black-holed while the trash lands, goes terminal when his network returns, takes no keystroke and makes at most 3 handshakes @p:note-5', async ({ actors }) => {
  const benPrincipal = await actors.principal('ben');
  const { ada, docId } = await sharedNote(actors, benPrincipal);
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}`, severable: true });
  await ui.waitLive(ben, docId);
  await ben.observeEditor(docId);
  await actors.requireDistinct(2);
  const sever = ben.sever;
  if (!sever) throw new Error('Ben is not severable');

  // Nothing reaches Ben, not even the DocDO's 4410: his window still thinks it is live.
  sever.blackhole({ swallowCloses: true });
  await trashFromSidebar(ada, docId);
  await expect(noteRow(ada, docId)).toHaveCount(0, { timeout: PEER_MS });
  await ui.body(ben, docId).click();
  await ben.page.keyboard.press(toEnd);
  await ben.page.keyboard.type(' typed into the void');
  await expect(ui.pane(ben, docId), 'Ben has not heard yet').not.toHaveAttribute(TERMINAL_REASON_ATTR, 'deleted');

  const before = docSockets(ben, docId).length;
  ben.expectReconnects(3, docId);
  sever.restore();
  await expectTerminalInPlace(ben, docId, new RegExp(`^${BODY}`));
  await expectNoKeystrokeLands(ben, docId);
  await ben.page.waitForTimeout(NO_RECONNECT_WINDOW_MS);
  expect(docSockets(ben, docId).length - before, 'at most 3 handshakes after the network returns').toBeLessThanOrEqual(3);
});

test('j05-trash: a fresh load of a trashed note is the one 404; Ada reads it read-only in Trash with the 30-day promise, restores it and both edit again @p:note-5 @evidence', async ({ actors }) => {
  const benPrincipal = await actors.principal('ben');
  const { ada, docId } = await sharedNote(actors, benPrincipal);
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await ui.waitLive(ben, docId);
  await actors.requireDistinct(2);
  await trashFromSidebar(ada, docId);
  await expectTerminalInPlace(ben, docId, BODY);

  // The API answers a trashed note exactly as it answers one that never existed, for its owner too.
  const origin = new URL(ada.page.url()).origin;
  const missing = crypto.randomUUID();
  for (const actor of [ada, ben]) {
    const trashed = await actor.context.request.get(`${origin}/api/docs/${docId}`);
    const absent = await actor.context.request.get(`${origin}/api/docs/${missing}`);
    expect({ status: trashed.status(), body: await trashed.text() }, `${actor.label}: byte-identical 404`).toEqual({ status: absent.status(), body: await absent.text() });
    expect(trashed.status()).toBe(404);
  }
  ben.expectHttp(404, `/api/docs/${docId}`);
  await ben.goto(`/d/${docId}`);
  await expect(ben.page.getByRole('heading', { name: DENIAL }), 'a fresh load gets the denial page').toBeVisible({ timeout: BOOT_TIMEOUT });
  await expect(ben.page.locator(`[${EDITOR_PANE_ATTR}]`)).toHaveCount(0);

  // Ada's Trash: the note, when it went there, and its content read-only under the 30-day promise.
  await ada.page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(trashRow(ada, docId), 'the note is in Trash').toContainText(TITLE);
  await expect(trashRow(ada, docId)).toContainText(/Deleted (Just now|1 min ago)/);
  await trashRow(ada, docId).click();
  const pane = ui.pane(ada, docId);
  await expect(pane.locator('[data-lexical-editor="true"]'), 'the content shows').toHaveText(BODY, { timeout: BIND_TIMEOUT });
  await expect(pane.locator('[data-lexical-editor="true"]'), 'read-only').toHaveAttribute('contenteditable', 'false');
  await expect(ui.title(ada, docId)).toHaveText(TITLE);
  expect(await editableSurfaces(ada, docId), 'nothing in the trash view is editable').toEqual([]);
  const notice = ada.page.getByText(TRASH_COPY.trashedNote, { exact: true });
  await expect(notice, 'the 30-day promise').toBeVisible();
  await expect(ada.page.getByText(/will be deleted|deleted in|forever/i), 'never a countdown or "forever"').toHaveCount(0);

  // Restore from the trash row's menu: the note is live for Ada and returns to Ben's sidebar.
  await trashRow(ada, docId).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
  await ada.page.getByRole('button', { name: 'Back to notes', exact: true }).click();
  await expect(noteRow(ada, docId), 'back in Ada’s notes').toBeVisible({ timeout: PEER_MS });
  await ui.openNote(ada, docId);
  await ui.typeBody(ada, docId, ' and Ada after the restore');
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });

  await ben.goto('/');
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  await expect(noteRow(ben, docId), 'back in Ben’s notes').toBeVisible({ timeout: PEER_MS });
  await ui.openNote(ben, docId);
  await expect.poll(() => ui.fieldText(ben, docId, 'body'), { timeout: PEER_MS }).toBe(`${BODY} and Ada after the restore`);
  await ui.typeBody(ben, docId, ' then Ben');
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { message: 'restore converges on both', timeout: PEER_MS }).toBe(`${BODY} and Ada after the restore then Ben`);
  await actors.checkpoint('restored');
});

test('j05-trash: a note dropped on the sidebar’s Trash button goes to Trash, and ⌘2 opens the Trash view @p:note-5', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  actors.solo('the drop and the shortcut are one window’s gestures');
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Dropped on Trash', { enter: true });
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await noteRow(ada, docId).locator('[draggable="true"]').dragTo(ada.page.getByRole('button', { name: 'Trash', exact: true }));
  await expect(noteRow(ada, docId), 'the dropped note leaves the notes').toHaveCount(0, { timeout: PEER_MS });
  await ada.page.keyboard.press('ControlOrMeta+2');
  await expect(trashRow(ada, docId), '⌘2 shows it in Trash').toContainText('Dropped on Trash');
  await ada.page.keyboard.press('ControlOrMeta+1');
  await expect(ada.page.getByRole('button', { name: 'Trash', exact: true })).toBeVisible();
});
