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
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR, INPUT_REFUSAL_ATTR, NAMES, SIDEBAR_ROW_ATTR,
  SYNC_UNACKED_ATTR, TERMINAL_REASON_ATTR, TITLE_BINDING_ATTR, TRASH_ROW_ATTR, paneSelector,
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
const CHART = JSON.stringify({ type: 'bar', title: 'Sales', data: [{ label: 'Q1', value: 3 }, { label: 'Q2', value: 5 }] });

async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label));
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  return actor;
}

const noteRow = (actor: Actor, docId: string): Locator => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`);
const trashRow = (actor: Actor, docId: string): Locator => actor.page.locator(`[${TRASH_ROW_ATTR}][${NAMES.docId}="${docId}"]`);
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
 * The attribute sweep: anything in the pane a person could still type into, focus, toggle or press to change the
 * note (buttons, role=button, menu items). A terminal pane has none, and its fields say why.
 */
async function editableSurfaces(actor: Actor, docId: string): Promise<string[]> {
  return actor.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    if (!pane) return ['no pane'];
    const found: string[] = [];
    for (const el of pane.querySelectorAll<HTMLElement>('*')) {
      const tag = el.tagName.toLowerCase();
      const label = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent?.trim().slice(0, 40) ?? '';
      if (el.isContentEditable) found.push(`${tag}[contenteditable] ${el.textContent?.slice(0, 40) ?? ''}`);
      else if (el.matches('input, textarea, select') && !el.matches(':disabled') && !(el as HTMLInputElement).readOnly) found.push(`${tag} ${el.getAttribute('name') ?? ''}`);
      else if (el.matches('button, [role="button"], [role^="menuitem"]') && !el.matches(':disabled, [aria-disabled="true"]')) found.push(`${tag}[${el.getAttribute('role') ?? 'button'}] ${label}`);
    }
    return found;
  }, `${paneSelector(docId)} [data-editor-canvas]`);
}

/** A code block's language picker in a read-only or terminal note: shown, disabled, and pressing it changes nothing. */
async function expectLanguageFixed(actor: Actor, scope: Locator): Promise<void> {
  const picker = scope.getByRole('button', { name: 'Select language', exact: true });
  await expect(picker, `${actor.label}: the code block shows its language`).toContainText('JavaScript');
  await expect(picker, `${actor.label}: the language cannot be changed`).toBeDisabled();
  await expect(scope.getByRole('button', { name: 'Select theme', exact: true })).toBeDisabled();
  await picker.click({ force: true });
  await expect(actor.page.getByRole('menuitem', { name: 'Python', exact: true }), `${actor.label}: no language menu opens`).toHaveCount(0);
  await actor.page.keyboard.press('Escape');
  await expect(picker, `${actor.label}: the language is unchanged`).toContainText('JavaScript');
}

/** The note's one chart block, by its decorator key, so it stays the same block whichever view it shows. */
async function chartBlock(actor: Actor, docId: string): Promise<Locator> {
  const shown = ui.pane(actor, docId).locator('[data-block-decorator-key]').filter({ has: actor.page.getByText('Sales', { exact: true }) });
  await expect(shown, `${actor.label}: the chart shows`).toHaveCount(1, { timeout: BIND_TIMEOUT });
  const key = await shown.getAttribute('data-block-decorator-key');
  return ui.pane(actor, docId).locator(`[data-block-decorator-key="${key}"]`);
}

/** A chart in a read-only or terminal note: no editor of it is left open and its title takes no keystroke. */
async function expectChartFixed(actor: Actor, chart: Locator): Promise<void> {
  await expect(chart.locator('textarea, input'), `${actor.label}: no chart editor is open`).toHaveCount(0);
  await chart.getByText('Sales', { exact: true }).click({ force: true });
  await actor.page.keyboard.type('zombie');
  await actor.page.keyboard.press('Enter');
  await expect(chart.locator('textarea, input'), `${actor.label}: the chart title opens no field`).toHaveCount(0);
  await expect(chart, `${actor.label}: the chart title is unchanged`).toContainText('Sales');
  await expect(chart).not.toContainText('zombie');
}

/** Records every input refusal the page shows from now on into `window.refused`; the notice itself clears in 4 s. */
async function recordRefusals(actor: Actor): Promise<void> {
  await actor.page.evaluate((attr) => {
    const refused: string[] = [];
    (window as unknown as { refused: string[] }).refused = refused;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        const text = el.textContent?.trim();
        if (text && refused.at(-1) !== text) refused.push(text);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, INPUT_REFUSAL_ATTR);
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
  // A second note (declared setup): the trash moves Ada's pane onto it, live, before her Trash view shows this one.
  const origin = new URL(ada.page.url()).origin;
  const other = await ada.context.request.post(`${origin}/api/docs`, { headers: { origin }, data: { title: 'Other plan', markdown: 'Still here.' } });
  expect(other.status()).toBe(201);
  const { doc: { id: otherId } } = (await other.json()) as { doc: { id: string } };
  await expect(noteRow(ada, otherId)).toBeVisible({ timeout: PEER_MS });
  await trashFromSidebar(ada, docId);
  await expectTerminalInPlace(ben, docId, BODY);
  await expect(ui.pane(ada, otherId), 'moss opens the next note').toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });

  // The API answers a trashed note exactly as it answers one that never existed, for its owner too.
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
  await recordRefusals(ada);
  await ada.page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(trashRow(ada, docId), 'the note is in Trash').toContainText(TITLE);
  await expect(trashRow(ada, docId)).toContainText(/Deleted (Just now|1 min ago)/);
  await trashRow(ada, docId).click();
  // The Trash view is a different editor from the one Ada typed into.
  ada.observations.delete(docId);
  const noteBody = ui.pane(ada, docId).locator('[data-moss-note-editor-root="true"]');
  await expect(noteBody, 'the content shows').toHaveText(BODY, { timeout: BIND_TIMEOUT });
  await expect(noteBody, 'read-only').toHaveAttribute('contenteditable', 'false');
  await expect(ui.title(ada, docId)).toHaveText(TITLE);
  expect(await editableSurfaces(ada, docId), 'nothing in the trash view is editable').toEqual([]);
  // Showing the trashed note's title is no write, so nothing was refused on the way.
  expect(await ada.page.evaluate(() => (window as unknown as { refused: string[] }).refused), 'opening the Trash view refuses nothing').toEqual([]);
  const notice = ada.page.getByText(TRASH_COPY.trashedNote, { exact: true });
  await expect(notice, 'the 30-day promise').toBeVisible();
  await expect(ada.page.getByText(/will be deleted|deleted in|forever/i), 'never a countdown or "forever"').toHaveCount(0);

  // Restore from the trash row's menu: the note is live for Ada and returns to Ben's sidebar.
  ada.expectReconnects(1, docId);
  await trashRow(ada, docId).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
  await expect(ada.page.getByRole('button', { name: 'Trash', exact: true }), 'moss returns to the notes').toBeVisible();
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

test('j05-trash: a code block, a chart and a body H1 survive the trash: no control in Ben\u2019s terminal note or Ada\u2019s Trash view changes them, an open chart edit closes, and the Trash view keeps the body\u2019s leading heading @p:note-5', async ({ actors }) => {
  const benPrincipal = await actors.principal('ben');
  const ada = await openShell(actors, 'ada');
  // The title is its own field; the body starts with its own H1 and holds a code block and a chart (declared setup).
  const origin = new URL(ada.page.url()).origin;
  const created = await ada.context.request.post(`${origin}/api/docs`, {
    headers: { origin }, data: { title: 'Plan', markdown: `# Findings\n\nDetails here.\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n\`\`\`moss-chart\n${CHART}\n\`\`\`` },
  });
  expect(created.status()).toBe(201);
  const { doc: { id: docId } } = (await created.json()) as { doc: { id: string } };
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await ui.waitLive(ben, docId);
  await actors.requireDistinct(2);
  await expect(ui.body(ben, docId).getByRole('heading', { name: 'Findings' })).toBeVisible();

  // Ben has the chart's data open in its editor when the trash lands.
  const benChart = await chartBlock(ben, docId);
  await benChart.hover();
  await benChart.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(benChart.locator('textarea'), 'Ben is editing the chart').toBeVisible();

  await expect(noteRow(ada, docId)).toBeVisible({ timeout: PEER_MS });
  await trashFromSidebar(ada, docId);
  await expectTerminalInPlace(ben, docId, /^Findings[\s\S]*Details here\./);
  await expectLanguageFixed(ben, ui.pane(ben, docId));
  await expectChartFixed(ben, benChart);

  await ada.page.getByRole('button', { name: 'Trash', exact: true }).click();
  await trashRow(ada, docId).click();
  ada.observations.delete(docId);
  const noteBody = ui.pane(ada, docId).locator('[data-moss-note-editor-root="true"]');
  await expect(noteBody.getByRole('heading', { name: 'Findings' }), 'the Trash view keeps the body\u2019s leading H1').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(noteBody).toContainText('Details here.');
  await expect(ui.title(ada, docId)).toHaveText('Plan');
  expect(await editableSurfaces(ada, docId), 'nothing in the trash view changes the note').toEqual([]);
  await expectLanguageFixed(ada, ui.pane(ada, docId));
  await expectChartFixed(ada, await chartBlock(ada, docId));
});

test('j05-trash: a note trashed while open and then restored comes back live in place, without a reload @p:note-5', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  actors.solo('one owner trashes and restores her own open note from another window');
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, TITLE, { enter: true });
  await ui.typeBody(ada, docId, BODY);
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });

  // Her other window trashes the note under this open pane, then restores it (declared setup: that window's API calls).
  const origin = new URL(ada.page.url()).origin;
  expect((await ada.context.request.delete(`${origin}/api/docs/${docId}`, { headers: { origin } })).status()).toBe(200);
  await expect(ui.pane(ada, docId), 'the open note goes terminal in place').toHaveAttribute(TERMINAL_REASON_ATTR, 'deleted', { timeout: PEER_MS });
  ada.expectReconnects(1, docId);
  expect((await ada.context.request.post(`${origin}/api/docs/${docId}/restore`, { headers: { origin } })).status()).toBe(200);
  await expect(noteRow(ada, docId), 'back in her notes').toBeVisible({ timeout: PEER_MS });

  await expect(ui.pane(ada, docId), 'the open note is live again').toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.pane(ada, docId)).not.toHaveAttribute(TERMINAL_REASON_ATTR, /.*/);
  await expect(ui.pane(ada, docId).locator(`[${CONNECTION_BANNER_ATTR}="deleted"]`), 'no stale Trash notice').toHaveCount(0);
  await expect(ui.body(ada, docId)).toHaveText(BODY);
  await ui.typeBody(ada, docId, ' and after the restore');
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  expect(await ui.fieldText(ada, docId, 'body')).toBe(`${BODY} and after the restore`);
  await actors.checkpoint('restored-in-place');
});

test('j05-trash: a restore the server refuses shows the server’s sentence, and the note stays in Trash @p:note-5', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const origin = new URL(ada.page.url()).origin;
  const send = (method: 'post' | 'delete', path: string, data?: object) =>
    ada.context.request[method](`${origin}${path}`, { headers: { origin, 'content-type': 'application/json' }, data, timeout: 15_000 });
  // Declared setup: Ben co-owns one folder of Ada's Home (not the Home itself), with a note in it; Ada trashes the folder.
  const { vault } = (await (await ada.context.request.get(`${origin}/api/workspace`)).json()) as { vault: { id: string } };
  const made = await send('post', '/api/folders', { parentId: vault.id, name: 'Ben co-owns' });
  expect(made.status(), 'declared setup: the folder').toBe(201);
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  expect((await send('post', `/api/folders/${folderId}/members`, { email: benPrincipal.email, role: 'owner' })).status()).toBe(201);
  const note = await send('post', '/api/docs', { folderId, title: 'Folder plan' });
  expect(note.status(), 'declared setup: the note').toBe(201);
  const docId = ((await note.json()) as { doc: { id: string } }).doc.id;
  expect((await send('delete', `/api/folders/${folderId}`)).status(), 'declared setup: the folder goes to Trash').toBe(200);

  // Restoring would put the note at the top of Ada's Home, where Ben can't add notes: moss shows why, not "Try again".
  const ben = await actors.open(benPrincipal);
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  ben.expectHttp(403, `/api/docs/${docId}/restore`);
  await ben.page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(trashRow(ben, docId), 'Ben finds the note he co-owns in Trash').toContainText('Folder plan', { timeout: PEER_MS });
  await trashRow(ben, docId).click({ button: 'right' });
  await ben.page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
  await expect(ben.page.getByText(/folder is in Trash, so it would return to the top of its vault, where you can.t add notes/), 'the server’s sentence').toBeVisible();
  await expect(ben.page.getByText(/Try again/), 'never "Try again" for a refusal a retry can’t change').toHaveCount(0);
  await expect(trashRow(ben, docId), 'the note stays in Trash').toBeVisible();
  await expect(ben.page.getByText(/folder is in Trash, so it would return/), 'moss’s notice dismisses itself').toBeHidden({ timeout: 10_000 });
});
