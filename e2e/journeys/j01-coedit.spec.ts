// j01-coedit (M1): two people edit one note. The setup (T1.1): Ada shares her note with Ben from the Share button in
// the note's top bar, picking his access in the dialog, and Ben opens the note's URL at that role and edits it with
// her. A signed-in stranger who opens the same URL gets the denial page, not the note and not another note; his doc
// socket opens and closes 4404, the page never reconnects, and the API's 404 for that note is byte-identical to the
// 404 for a note that never existed.
import { createHash, randomUUID } from 'node:crypto';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, DOC_SOCKET_PATH, DOC_STATE_ATTR, EDITOR_PANE_ATTR, ROLE_ATTR, SYNC_UNACKED_ATTR, paneSelector,
} from '../lib/contract.ts';
import { cookieHeader, openDocClient } from '../lib/doc-client.ts';
import { signIn } from '../lib/principals.ts';
import { CLOSE } from '../../packages/protocol/src/sync.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const ACK_TIMEOUT = 10_000;
const PEER_TIMEOUT = 10_000;
const ADA_TEXT = 'Shared from the dialog, café & “quotes”';
const BEN_TEXT = ' then Ben joined in';
/** The one denial surface (A§4.2): every cause reads the same. */
const DENIAL = /doesn.t exist or you don.t have access/i;

async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label));
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

/** "+ Note", then the new pane's doc id. */
async function newNote(actor: Actor): Promise<string> {
  const ids = () => actor.page.locator(`[${EDITOR_PANE_ATTR}]`).evaluateAll((panes) => panes.map((p) => p.getAttribute('data-doc-id') ?? ''));
  const before = await ids();
  await actor.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }).click();
  const fresh = async () => (await ids()).filter((id) => id !== '' && !before.includes(id));
  await expect.poll(fresh, { message: 'the new note opens in an editor pane', timeout: BIND_TIMEOUT }).toHaveLength(1);
  const [docId] = await fresh();
  if (!docId) throw new Error(`${actor.label}: no new pane`);
  return docId;
}

async function waitBodyLive(actor: Actor, docId: string): Promise<void> {
  await expect(actor.page.locator(paneSelector(docId)), `${actor.label}: the pane goes live`).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.body(actor, docId), `${actor.label}: the body binds`).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
}

async function waitAcked(actor: Actor, docId: string): Promise<void> {
  await expect(ui.pane(actor, docId), `${actor.label}: the DocDO acks every keystroke`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: ACK_TIMEOUT });
}

test('j01 setup: Ada shares her note with Ben from the Share dialog, and Ben opens its URL as an editor and edits with her @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada);
  await waitBodyLive(ada, docId);
  await expect(ui.pane(ada, docId), "Ada's own note opens at owner").toHaveAttribute(ROLE_ATTR, 'owner');
  await ui.typeBody(ada, docId, ADA_TEXT);
  await waitAcked(ada, docId);

  const dialog = await ui.shareWith(ada, docId, benPrincipal, 'Can edit');
  await expect(ui.accessRow(dialog, benPrincipal), 'the owner sees the email she shared with').toContainText(benPrincipal.email);
  if (!ada.principal) throw new Error('ada has no principal');
  await expect(ui.accessRow(dialog, ada.principal), 'Ada is listed as the owner').toContainText('Owner');
  await actors.checkpoint('shared');
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await waitBodyLive(ben, docId);
  await expect(ui.pane(ben, docId), 'Ben opens the note at the role Ada chose').toHaveAttribute(ROLE_ATTR, 'editor');
  expect(await ui.fieldText(ben, docId, 'body'), "Ben sees Ada's text").toBe(ADA_TEXT);
  await expect(ui.pane(ben, docId).getByRole('button', { name: 'Share', exact: true }), 'only the owner is offered Share').toHaveCount(0);
  await actors.requireDistinct(2);

  await ui.typeBody(ben, docId, BEN_TEXT);
  await waitAcked(ben, docId);
  await expect
    .poll(() => ui.fieldText(ada, docId, 'body'), { message: "Ben's edit reaches Ada", timeout: PEER_TIMEOUT })
    .toBe(`${ADA_TEXT}${BEN_TEXT}`);
  await actors.checkpoint('co-edited');
});

/** In a page: opens the doc socket as the page's own session would, and reports whether it opened and its close code. */
function probe(url: string): Promise<{ opened: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const result = { opened: false, code: null as number | null };
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      resolve(result);
    }, 10_000);
    socket.onopen = () => {
      result.opened = true;
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      result.code = event.code;
      resolve(result);
    };
  });
}

async function fingerprint(actor: Actor, path: string) {
  const response = await actor.context.request.get(path);
  return {
    status: response.status(),
    contentType: response.headers()['content-type'] ?? null,
    cacheControl: response.headers()['cache-control'] ?? null,
    sha256: createHash('sha256').update(await response.body()).digest('hex'),
  };
}

test('j01 setup: a signed-in stranger opening the note URL gets the denial page; the doc socket closes 4404 and never reconnects @p:ppl-2 @evidence', async ({ actors, stack }) => {
  const adaPrincipal = await actors.principal('ada');
  const adaCookie = cookieHeader(await signIn(stack.baseUrl, adaPrincipal));
  const created = await fetch(`${stack.baseUrl}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: stack.baseUrl, cookie: adaCookie },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  expect(created.status, 'declared setup: Ada has a note').toBe(201);
  const docId = ((await created.json()) as { doc: { id: string } }).doc.id;

  const cy = await actors.session(await actors.principal('cy'));
  const missing = randomUUID();
  cy.expectHttp(404, `/api/docs/${docId}`);
  cy.expectHttp(404, `/api/docs/${missing}`);
  await cy.goto(`/d/${docId}`);
  await cy.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await expect(cy.page.getByRole('heading', { name: DENIAL }), 'the stranger sees the denial page').toBeVisible();
  await expect(cy.page.locator('[data-moss-app-shell]'), 'no moss shell opens behind it').toHaveCount(0);
  await expect(cy.page.locator(`[${EDITOR_PANE_ATTR}]`), 'no note opens in its place').toHaveCount(0);
  expect(new URL(cy.page.url()).pathname, 'the address stays on the note').toBe(`/d/${docId}`);
  await actors.checkpoint('denied');

  // His own socket to the note, with his cookie and the app's Origin: opened, then closed 4404, never a refused handshake.
  const url = `${stack.baseUrl.replace(/^http/, 'ws')}${DOC_SOCKET_PATH}${docId}`;
  expect(await cy.page.evaluate(probe, url), "the stranger's doc socket").toEqual({ opened: true, code: CLOSE.unavailable });
  // The page itself never opened the doc socket and does not retry it.
  await cy.page.waitForTimeout(3_000);
  const sockets = cy.telemetry.sockets.filter((socket) => socket.docId === docId);
  expect(sockets.map((socket) => socket.closedAt !== null), 'only the probe opened a doc socket, and it is closed').toEqual([true]);

  // The API behind the page: an inaccessible note answers exactly as one that never existed.
  const denied = await fingerprint(cy, `/api/docs/${docId}`);
  expect(denied.status).toBe(404);
  expect(denied, "Ada's note and a note that never existed, as the stranger sees them").toEqual(await fingerprint(cy, `/api/docs/${missing}`));

  // A note that never existed gets the same page.
  await cy.goto(`/d/${missing}`);
  await expect(cy.page.getByRole('heading', { name: DENIAL }), 'a missing note shows the same page').toBeVisible();
  await expect(cy.page.locator(`[${EDITOR_PANE_ATTR}]`), 'and opens no other note').toHaveCount(0);
});


test('j01 access: a viewer reads the shared note but cannot share, write through REST or forge a write frame @p:ppl-2', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada);
  await waitBodyLive(ada, docId);
  await ui.typeBody(ada, docId, ADA_TEXT);
  await waitAcked(ada, docId);
  const dialog = await ui.shareWith(ada, docId, benPrincipal, 'Can view');
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'viewer');
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly');
  await expect(ui.body(ben, docId)).toHaveAttribute('contenteditable', 'false');
  expect(await ui.fieldText(ben, docId, 'body')).toBe(ADA_TEXT);
  await expect(ui.pane(ben, docId).getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);

  const headers = { origin: stack.baseUrl };
  const reshared = await ben.context.request.post(`/api/docs/${docId}/members`, {
    headers, data: { email: benPrincipal.email, role: 'editor' },
  });
  expect(reshared.status()).toBe(403);
  const workspace = await ada.context.request.get('/api/workspace');
  const { vault } = (await workspace.json()) as { vault: { id: string } };
  const grant = await ada.context.request.post(`/api/folders/${vault.id}/members`, {
    headers, data: { email: benPrincipal.email, role: 'viewer' },
  });
  expect(grant.status()).toBe(201);
  const created = await ben.context.request.post('/api/docs', { headers, data: { folderId: vault.id } });
  expect(created.status()).toBe(403);

  const cookie = (await ben.context.cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');
  const raw = await openDocClient(stack.baseUrl, docId, cookie);
  try {
    await expect.poll(() => raw.text(), { timeout: BIND_TIMEOUT }).toBe(ADA_TEXT);
    raw.type(' FORGED-VIEWER-WRITE');
    await expect.poll(() => raw.events).toContainEqual({ t: 'write-refused', reason: 'role' });
    expect(await ui.fieldText(ada, docId, 'body')).toBe(ADA_TEXT);
  } finally {
    raw.close();
  }
  await ben.page.reload();
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly');
  expect(await ui.fieldText(ben, docId, 'body')).toBe(ADA_TEXT);
});

test('j01 discovery: Ben finds a directly shared note in Home without a URL or mutation actions @p:note-4 @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada);
  await waitBodyLive(ada, docId);
  await ui.shareWith(ada, docId, benPrincipal, 'Can edit');
  await ada.page.keyboard.press('Escape');
  const ben = await actors.open(benPrincipal);
  const row = ben.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(row).toBeVisible();
  await expect(ada.page.locator(`[data-sidebar-row][data-doc-id="${docId}"] [draggable="true"]`)).toHaveCount(1);
  await expect(row.locator('[draggable="true"]')).toHaveCount(0);
  await expect(ben.page.getByRole('button', { name: 'Vault: Home', exact: true })).toBeVisible();
  await row.click();
  await waitBodyLive(ben, docId);
  await expect(ben.page.getByRole('button', { name: 'Vault: Home', exact: true })).toBeVisible();
  await row.click({ button: 'right' });
  await expect(ben.page.getByRole('menuitem', { name: 'Copy Link', exact: true })).toBeVisible();
  await expect(ben.page.getByRole('menuitem', { name: /Move|New folder|Create folder/ })).toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await actors.checkpoint('discovered-in-home');
});

test('j01 discovery: Ben switches to a shared vault and back, with a role badge and a persisted choice @p:note-4 @evidence', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada);
  await waitBodyLive(ada, docId);
  const { vault } = await (await ada.context.request.get('/api/workspace')).json();
  const grant = await ada.context.request.post(`/api/folders/${vault.id}/members`, {
    headers: { origin: stack.baseUrl }, data: { email: benPrincipal.email, role: 'editor' },
  });
  expect(grant.status()).toBe(201);
  const ben = await actors.open(benPrincipal);
  const switcher = ben.page.getByRole('button', { name: 'Vault: Home', exact: true });
  await switcher.click();
  const shared = ben.page.getByRole('menuitem', { name: 'Home editor', exact: true });
  await expect(shared).toBeVisible();
  await expect(ben.page.getByRole('menuitem', { name: /New vault|Share vault|Rename|Delete/ })).toHaveCount(0);
  await shared.click();
  const row = ben.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(row).toBeVisible();
  await ben.page.reload();
  await expect(row).toBeVisible();
  await row.click();
  await waitBodyLive(ben, docId);
  await switcher.click();
  await ben.page.getByRole('menuitem', { name: 'Home', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(ui.pane(ben, docId)).toBeVisible();
  await actors.checkpoint('switched-back-with-doc-open');
});

test('j01 duplicate: the note menu makes a content-preserving copy visible to both vault peers @p:note-4 @p:col-6', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const docId = await newNote(ada);
  await waitBodyLive(ada, docId);
  const text = 'Duplicate keeps the original words, café and punctuation.';
  await ui.typeBody(ada, docId, text);
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: 30_000 });
  const { vault } = await (await ada.context.request.get('/api/workspace')).json();
  expect((await ada.context.request.post(`/api/folders/${vault.id}/members`, {
    headers: { origin: stack.baseUrl }, data: { email: benPrincipal.email, role: 'editor' },
  })).status()).toBe(201);
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await waitBodyLive(ben, docId);
  await ada.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  const copyPane = ada.page.locator(`[${EDITOR_PANE_ATTR}]:not([data-doc-id="${docId}"])`);
  await expect(copyPane).toHaveCount(1);
  const copyId = await copyPane.getAttribute('data-doc-id');
  if (!copyId) throw new Error('duplicate has no doc id');
  await waitBodyLive(ada, copyId);
  expect(await ui.fieldText(ada, copyId, 'body')).toBe(text);
  for (const actor of [ada, ben]) {
    await expect(actor.page.locator(`[data-sidebar-row][data-doc-id="${copyId}"]`)).toBeVisible({ timeout: 15_000 });
  }
  await ben.page.locator(`[data-sidebar-row][data-doc-id="${copyId}"]`).click();
  await waitBodyLive(ben, copyId);
  expect(await ui.fieldText(ben, copyId, 'body')).toBe(text);
  await ben.page.reload();
  await waitBodyLive(ben, copyId);
  expect(await ui.fieldText(ben, copyId, 'body')).toBe(text);
  const copyEdit = ' Only the copy gains this sentence.';
  await ui.typeBody(ben, copyId, copyEdit);
  await expect(ui.body(ada, copyId)).toContainText(copyEdit);
  await ada.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`).click();
  await waitBodyLive(ada, docId);
  expect(await ui.fieldText(ada, docId, 'body')).toBe(text);
  const sourceEdit = ' Only the source gains this sentence.';
  await ui.typeBody(ada, docId, sourceEdit);
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0');
  await ben.page.reload();
  await waitBodyLive(ben, copyId);
  expect(await ui.fieldText(ben, copyId, 'body')).toBe(text + copyEdit);
});
