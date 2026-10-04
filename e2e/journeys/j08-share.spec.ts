// j08-share (T2.4): sharing a vault, a folder or a note, with a person at a role or with a revocable link. Ada shares
// a folder from its context menu and her vault from the switcher, and Ben finds both without a URL. A viewer link
// opened signed out reads at viewer and offers "Sign in to do more", which comes back to the same note. An editor
// link is viewer signed out, editor signed in, and the max of link and grant with a grant. Revoked, forged and
// inaccessible links all get the same 404 and the same denial page, an email shared with nobody's account answers
// exactly as one shared with an account, and nobody but the owner sees an email.
import { createHash, randomBytes } from 'node:crypto';
import type { Locator } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import { APP_STATE_ATTR, BODY_BINDING_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR, ROLE_ATTR, SYNC_UNACKED_ATTR, paneSelector } from '../lib/contract.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const LIVE_TIMEOUT = 10_000;
const DENIAL = /doesn.t exist or you don.t have access/i;
const TEXT = 'Shared by link, café & “quotes”';

async function openShell(actors: Actors, label: string, path = '/'): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label), { path });
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

/** "+ Note", then the new pane's doc id once its body is live. */
async function newNote(actor: Actor): Promise<string> {
  const ids = () => actor.page.locator(`[${EDITOR_PANE_ATTR}]`).evaluateAll((panes) => panes.map((p) => p.getAttribute('data-doc-id') ?? ''));
  const before = await ids();
  await actor.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }).click();
  const fresh = async () => (await ids()).filter((id) => id !== '' && !before.includes(id));
  await expect.poll(fresh, { message: 'the new note opens in an editor pane', timeout: BIND_TIMEOUT }).toHaveLength(1);
  const [docId] = await fresh();
  if (!docId) throw new Error(`${actor.label}: no new pane`);
  await waitOpen(actor, docId, 'live');
  return docId;
}

async function waitOpen(actor: Actor, docId: string, binding: 'live' | 'readonly'): Promise<void> {
  await expect(actor.page.locator(paneSelector(docId)), `${actor.label}: the pane goes live`).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.body(actor, docId), `${actor.label}: the body binds ${binding}`).toHaveAttribute(BODY_BINDING_ATTR, binding, { timeout: BIND_TIMEOUT });
}

async function noteWithText(ada: Actor): Promise<string> {
  const docId = await newNote(ada);
  await ui.typeBody(ada, docId, TEXT);
  await expect(ui.pane(ada, docId), 'the DocDO acks the text').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: LIVE_TIMEOUT });
  return docId;
}

/** Creates a link at `access` in the open dialog and returns its URL, read from the dialog (WebKit cannot read the clipboard). */
async function createLink(dialog: Locator, access: ui.LinkAccess): Promise<string> {
  await dialog.getByRole('radiogroup', { name: 'Link access', exact: true }).getByRole('radio', { name: access, exact: true }).click();
  await dialog.getByRole('button', { name: 'Create link', exact: true }).click();
  const field = ui.linkField(dialog, access);
  await expect(field, `a ${access} link is listed`).toHaveCount(1);
  const url = await field.inputValue();
  expect(url, 'the link carries its token').toMatch(/\?share=[0-9a-f]{48}$/);
  return url;
}

const pathOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

async function fingerprint(actor: Actor, path: string) {
  const response = await actor.context.request.get(path);
  return {
    status: response.status(),
    contentType: response.headers()['content-type'] ?? null,
    cacheControl: response.headers()['cache-control'] ?? null,
    sha256: createHash('sha256').update(await response.body()).digest('hex'),
  };
}

test('j08 folder: Ada shares a folder from its context menu and it reaches Ben\'s sidebar @p:ppl-2 @evidence', async ({ actors, stack }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.session(adaPrincipal);
  await ada.goto('/');
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  // Declared setup: a folder holding a note (the folder UI is T2.2's journey, j06).
  const headers = { origin: stack.baseUrl };
  const { vault } = (await (await ada.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  const name = `Plans ${randomBytes(2).toString('hex')}`;
  const made = await ada.context.request.post('/api/folders', { headers, data: { name, parentId: vault.id } });
  expect(made.status(), 'declared setup: a folder').toBe(201);
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  const note = await ada.context.request.post('/api/docs', { headers, data: { folderId, title: 'Inside the folder' } });
  expect(note.status(), 'declared setup: a note in the folder').toBe(201);
  const docId = ((await note.json()) as { doc: { id: string } }).doc.id;
  await ada.page.reload();
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });

  const benPrincipal = await actors.principal('ben');
  const ben = await actors.open(benPrincipal);
  const benFolder = ui.folderRow(ben, name);
  await expect(benFolder, 'Ben cannot see the folder before it is shared').toHaveCount(0);

  await ui.folderRow(ada, name).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
  const dialog = ada.page.getByRole('dialog', { name: 'Share folder' });
  await expect(dialog, 'the folder share dialog opens').toBeVisible();
  await expect(dialog).toContainText(name);
  await ui.shareInDialog(dialog, benPrincipal.email, 'Can view');
  await expect(ui.inviteRow(dialog, benPrincipal.email), 'Ben waits at view, by email, until he opens it').toContainText('Can view');
  await expect(ui.inviteRow(dialog, benPrincipal.email)).toContainText('Invited');
  await actors.checkpoint('folder-shared');
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await expect(benFolder, 'the folder reaches Ben without a reload').toBeVisible({ timeout: LIVE_TIMEOUT });
  await benFolder.click();
  const row = ben.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(row, 'its note is inside').toBeVisible();
  await row.click();
  await waitOpen(ben, docId, 'readonly');
  await expect(ui.pane(ben, docId), 'Ben reads it at the role Ada chose').toHaveAttribute(ROLE_ATTR, 'viewer');
  await benFolder.click({ button: 'right' });
  await expect(ben.page.getByRole('menuitem', { name: 'Share…', exact: true }), 'only the owner is offered Share…').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await actors.requireDistinct(2);

  // A folder link lands a stranger on the folder (/f/$folderId): its notes and nothing else of Ada's.
  await ui.folderRow(ada, name).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
  const url = await createLink(ada.page.getByRole('dialog', { name: 'Share folder' }), 'Can view');
  expect(new URL(url).pathname).toBe(`/f/${folderId}`);
  await ada.page.keyboard.press('Escape');
  const stranger = await actors.anonymous(pathOf(url), { label: 'stranger' });
  await stranger.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await expect(stranger.page.getByRole('button', { name: `Vault: ${name}`, exact: true }), 'the folder is the workspace').toBeVisible();
  const strangerRow = stranger.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(strangerRow, 'its note is listed').toBeVisible();
  await expect(stranger.page.locator('[data-sidebar-row]'), 'and nothing else').toHaveCount(1);
  await strangerRow.click();
  await waitOpen(stranger, docId, 'readonly');
  await expect(ui.pane(stranger, docId)).toHaveAttribute(ROLE_ATTR, 'viewer');
  await actors.checkpoint('folder-link-landing');
});

test('j08 vault: Ada shares her vault from the switcher and Ben switches to it @p:ppl-2 @p:note-4 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  const ben = await actors.open(benPrincipal);

  await ada.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await ada.page.getByRole('menuitem', { name: 'Share vault…', exact: true }).click();
  const dialog = ada.page.getByRole('dialog', { name: 'Share vault' });
  await expect(dialog, 'the vault share dialog opens').toBeVisible();
  await ui.shareInDialog(dialog, benPrincipal.email, 'Can edit');
  await expect(ui.inviteRow(dialog, benPrincipal.email)).toContainText('Can edit');
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await ben.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  const shared = ben.page.getByRole('menuitem', { name: 'Home editor', exact: true });
  await expect(shared, "Ada's vault reaches Ben's switcher with his role").toBeVisible({ timeout: LIVE_TIMEOUT });
  await shared.click();
  const row = ben.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(row).toBeVisible();
  await ben.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  const menu = ben.page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Home editor', exact: true }), 'the switcher is open').toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Share vault…', exact: true }), 'a member gets no vault actions').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await row.click();
  await waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'editor');
  expect(await ui.fieldText(ben, docId, 'body')).toBe(TEXT);
  await actors.checkpoint('vault-shared');
});

test('j08 vault: a granted co-owner of Ada\'s vault can share it, but gets no create, rename or trash @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const cyPrincipal = await actors.principal('cy');
  const cy = await openShell(actors, 'cy');

  await ada.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await ada.page.getByRole('menuitem', { name: 'Share vault…', exact: true }).click();
  const dialog = ada.page.getByRole('dialog', { name: 'Share vault' });
  await ui.shareInDialog(dialog, cyPrincipal.email, 'Owner');
  await expect(ui.inviteRow(dialog, cyPrincipal.email), 'Cy is a co-owner of the vault').toContainText('Owner');
  await ada.page.keyboard.press('Escape');

  await cy.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  const shared = cy.page.getByRole('menuitem', { name: 'Home owner', exact: true });
  await expect(shared, "Ada's vault reaches Cy's switcher as owner").toBeVisible({ timeout: LIVE_TIMEOUT });
  await shared.click();
  await expect(cy.page.getByRole('button', { name: 'Vault: Home', exact: true })).toBeEnabled({ timeout: LIVE_TIMEOUT });
  await cy.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  const menu = cy.page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Home owner', exact: true }), 'the switcher is open').toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Share vault…', exact: true }), 'a co-owner may share the vault').toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'New vault', exact: true }), 'New vault belongs to the owned section').toHaveCount(0);
  await cy.page.keyboard.press('Escape');
  await expect(cy.page.getByRole('button', { name: 'Vault actions', exact: true }), "only the vault's owner renames or trashes it").toHaveCount(0);
});

test('j08 link: a viewer link opened signed out reads at viewer and offers sign-in, which returns to the same note @p:ppl-2 @evidence', async ({ actors, browserName }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const dialog = await ui.openShare(ada, docId);
  const url = await createLink(dialog, 'Can view');
  expect(new URL(url).pathname).toBe(`/d/${docId}`);
  if (browserName === 'chromium') {
    await ada.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ui.linkRow(dialog, 'Can view').getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Copied');
    expect(await ada.page.evaluate(() => navigator.clipboard.readText()), 'Copy puts the link on the clipboard').toBe(url);
  }
  await actors.checkpoint('link-created');
  await ada.page.keyboard.press('Escape');

  const stranger = await actors.anonymous(pathOf(url), { label: 'stranger' });
  await waitOpen(stranger, docId, 'readonly');
  await expect(ui.pane(stranger, docId), 'the link opens at viewer').toHaveAttribute(ROLE_ATTR, 'viewer');
  expect(await ui.fieldText(stranger, docId, 'body'), 'the stranger reads the note').toBe(TEXT);
  await expect(ui.pane(stranger, docId).getByRole('button', { name: 'Share', exact: true }), 'no Share for a link visitor').toHaveCount(0);
  const signIn = stranger.page.getByRole('button', { name: 'Sign in to do more', exact: true });
  await expect(signIn, 'the stranger is offered sign-in').toBeVisible();
  await actors.checkpoint('read-signed-out');

  const benPrincipal = await actors.principal('ben');
  await signIn.click();
  await stranger.page.waitForURL((at) => at.pathname === '/login' && at.searchParams.get('next') === pathOf(url));
  await ui.waitForLoginCard(stranger);
  await ui.signInThroughCard(stranger, benPrincipal);
  await stranger.page.waitForURL((at) => `${at.pathname}${at.search}` === pathOf(url), { timeout: 30_000 });
  await waitOpen(stranger, docId, 'readonly');
  await expect(ui.pane(stranger, docId), 'signed in, a viewer link is still a viewer link').toHaveAttribute(ROLE_ATTR, 'viewer');
  await expect(signIn, 'and no longer offers sign-in').toHaveCount(0);
  expect(await ui.fieldText(stranger, docId, 'body')).toBe(TEXT);
});

test('j08 link: an editor link is viewer signed out, editor signed in without a grant, and the max with a grant @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const cyPrincipal = await actors.principal('cy');
  const dialog = await ui.openShare(ada, docId);
  const url = await createLink(dialog, 'Can edit');
  await ui.shareInDialog(dialog, cyPrincipal.email, 'Owner');
  await expect(ui.inviteRow(dialog, cyPrincipal.email), 'Cy is invited as a co-owner').toContainText('Owner');
  await ada.page.keyboard.press('Escape');

  const stranger = await actors.anonymous(pathOf(url), { label: 'stranger' });
  await waitOpen(stranger, docId, 'readonly');
  await expect(ui.pane(stranger, docId), 'signed out, an editor link reads at viewer').toHaveAttribute(ROLE_ATTR, 'viewer');

  const ben = await actors.open(await actors.principal('ben'), { path: pathOf(url) });
  await waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId), 'signed in without a grant, the link role').toHaveAttribute(ROLE_ATTR, 'editor');
  const benText = ' and Ben edits through the link';
  await ui.typeBody(ben, docId, benText);
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { timeout: LIVE_TIMEOUT }).toBe(`${TEXT}${benText}`);

  const cy = await actors.open(cyPrincipal, { path: pathOf(url) });
  await waitOpen(cy, docId, 'live');
  await expect(ui.pane(cy, docId), 'with a grant above the link, the grant').toHaveAttribute(ROLE_ATTR, 'owner');
  await expect(ui.pane(cy, docId).getByRole('button', { name: 'Share', exact: true }), 'a co-owner may share').toBeVisible();
  await actors.requireDistinct(3);
});

test('j08 link: an editor folder link lifts a viewer grant to editor, and lands a signed-in visitor without a grant on the folder @p:ppl-2', async ({ actors, stack }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.session(adaPrincipal);
  const headers = { origin: stack.baseUrl };
  // Declared setup over the API: a folder holding a note, Ben at view on it, and an editor link to it.
  const { vault } = (await (await ada.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  const name = `Linked ${randomBytes(2).toString('hex')}`;
  const made = await ada.context.request.post('/api/folders', { headers, data: { name, parentId: vault.id } });
  expect(made.status(), 'declared setup: a folder').toBe(201);
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  const note = await ada.context.request.post('/api/docs', { headers, data: { folderId, title: 'Under the link' } });
  expect(note.status(), 'declared setup: a note in the folder').toBe(201);
  const docId = ((await note.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  const shared = await ada.context.request.post(`/api/folders/${folderId}/members`, { headers, data: { email: benPrincipal.email, role: 'viewer' } });
  expect(shared.status(), 'declared setup: Ben at view').toBe(201);
  const linked = await ada.context.request.post(`/api/folders/${folderId}/links`, { headers, data: { role: 'editor' } });
  expect(linked.status(), 'declared setup: an editor link').toBe(201);
  const { token } = ((await linked.json()) as { link: { token: string } }).link;

  const ben = await actors.open(benPrincipal, { path: `/d/${docId}?share=${token}` });
  await waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId), 'a viewer grant below an editor link: the link').toHaveAttribute(ROLE_ATTR, 'editor');

  const dee = await actors.open(await actors.principal('dee'), { path: `/f/${folderId}?share=${token}` });
  await expect(dee.page.getByRole('button', { name: `Vault: ${name}`, exact: true }), 'the folder is the workspace').toBeVisible({ timeout: LIVE_TIMEOUT });
  const row = dee.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(row, 'its note is listed').toBeVisible();
  await row.click();
  await waitOpen(dee, docId, 'live');
  await expect(ui.pane(dee, docId), 'signed in without a grant, the link role').toHaveAttribute(ROLE_ATTR, 'editor');
  const added = await newNote(dee);
  await expect(ui.pane(dee, added), 'Dee adds a note to the linked folder').toHaveAttribute(ROLE_ATTR, 'editor');
  await actors.requireDistinct(3);
});

test('j08 denial: revoked, forged and inaccessible links get byte-identical 404s and the denial page @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const otherId = await newNote(ada);
  const otherDialog = await ui.openShare(ada, otherId);
  const otherUrl = await createLink(otherDialog, 'Can view');
  await ada.page.keyboard.press('Escape');
  await expect(otherDialog).toBeHidden();
  ada.expectReconnects(1, docId); // Returning to the first note opens its session again.
  await ui.openNote(ada, docId);
  const dialog = await ui.openShare(ada, docId);
  const url = await createLink(dialog, 'Can view');
  await ui.linkRow(dialog, 'Can view').getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(ui.linkField(dialog, 'Can view'), 'a revoked link leaves the list').toHaveCount(0);
  await ada.page.keyboard.press('Escape');

  const revoked = new URL(url).searchParams.get('share') ?? '';
  const forged = randomBytes(24).toString('hex');
  const elsewhere = new URL(otherUrl).searchParams.get('share') ?? '';
  const stranger = await actors.anonymous(`/d/${docId}?share=${forged}`, { label: 'stranger' });
  stranger.expectHttp(404, `/api/docs/${docId}`);
  await stranger.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await expect(stranger.page.getByRole('heading', { name: DENIAL }), 'a forged link shows the denial page').toBeVisible();
  await expect(stranger.page.getByRole('button', { name: 'Sign in', exact: true }), 'signed out, it offers sign-in').toBeVisible();
  await expect(stranger.page.locator(`[${EDITOR_PANE_ATTR}]`), 'and opens no note').toHaveCount(0);
  await actors.checkpoint('forged-denied');
  for (const token of [revoked, elsewhere]) {
    await stranger.goto(`/d/${docId}?share=${token}`);
    await expect(stranger.page.getByRole('heading', { name: DENIAL })).toBeVisible();
    await expect(stranger.page.locator(`[${EDITOR_PANE_ATTR}]`)).toHaveCount(0);
  }

  const answers = await Promise.all([revoked, forged, elsewhere].map((token) => fingerprint(stranger, `/api/docs/${docId}?share=${token}`)));
  expect(answers[0].status).toBe(404);
  expect(answers[1], 'forged vs revoked').toEqual(answers[0]);
  expect(answers[2], 'a live link to another note vs revoked').toEqual(answers[0]);
  // A signed-in stranger presenting them gets the same bytes.
  const ben = await actors.session(await actors.principal('ben'));
  for (const token of [revoked, forged, elsewhere]) {
    expect(await fingerprint(ben, `/api/docs/${docId}?share=${token}`), 'signed in, the same 404').toEqual(answers[0]);
  }
  // The positive control: the other note's live link opens the other note.
  expect((await stranger.context.request.get(`/api/docs/${otherId}?share=${elsewhere}`)).status()).toBe(200);
  await actors.requireDistinct(2);
});

test('j08 privacy: an email with no account answers like one with an account, and non-owners see no emails @p:ppl-2', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  const ghost: Principal = actors.credentials('ghost');
  const dialog = await ui.openShare(ada, docId);

  // A slow reload of the lists must not hold the email field read-only once the share is confirmed.
  const members = `**/api/docs/${docId}/members`;
  await ada.page.route(members, async (route) => {
    if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.fallback();
  });
  const answers: { status: number; body: unknown }[] = [];
  for (const email of [benPrincipal.email, ghost.email]) {
    const posted = ada.page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/docs/${docId}/members`));
    await ui.shareInDialog(dialog, email, 'Can edit');
    const response = await posted;
    answers.push({ status: response.status(), body: await response.json() });
    await expect(dialog.getByRole('status'), 'the same confirmation either way').toHaveText(`Shared with ${email}.`);
    await expect(dialog.getByLabel('Email', { exact: true }), 'the next email can be typed at once').toBeEditable({ timeout: 1_000 });
  }
  await ada.page.unroute(members);
  expect(answers[0].status).toBe(201);
  expect(answers[1].status, 'an unknown email gets the same status').toBe(answers[0].status);
  expect(answers[1].body, 'and the same body, but for the email').toEqual(JSON.parse(JSON.stringify(answers[0].body).replaceAll(benPrincipal.email, ghost.email)));
  // Until Ben opens the note, an email with an account and one without look the same to the owner.
  for (const email of [benPrincipal.email, ghost.email]) {
    await expect(ui.inviteRow(dialog, email), `${email} waits as a pending invite`).toContainText('Invited');
    await expect(ui.inviteRow(dialog, email)).toContainText('Can edit');
  }
  await expect(ui.accessRow(dialog, benPrincipal), "Ben's name is not shown before he opens it").toHaveCount(0);
  await ada.page.keyboard.press('Escape');
  const linkDialog = await ui.openShare(ada, docId);
  const url = await createLink(linkDialog, 'Can view');
  await ada.page.keyboard.press('Escape');

  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await waitOpen(ben, docId, 'live');
  const asMember = await ben.context.request.get(`/api/docs/${docId}/members`);
  expect(asMember.status()).toBe(200);
  const text = await asMember.text();
  expect(text, 'no email reaches a member').not.toContain('@');
  expect((await ben.context.request.get(`/api/docs/${docId}/links`)).status(), 'a member cannot list links').toBe(403);
  expect((await ben.context.request.post(`/api/docs/${docId}/links`, { headers: { origin: stack.baseUrl }, data: { role: 'viewer' } })).status()).toBe(403);
  await expect(ui.pane(ben, docId).getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  const reopened = await ui.openShare(ada, docId);
  await expect(ui.accessRow(reopened, benPrincipal), 'opened, Ben is listed by name').toContainText(benPrincipal.email);
  await expect(ui.inviteRow(reopened, ghost.email)).toContainText('Invited');
  await ada.page.keyboard.press('Escape');

  const token = new URL(url).searchParams.get('share') ?? '';
  const stranger = await actors.anonymous(pathOf(url), { label: 'stranger' });
  await waitOpen(stranger, docId, 'readonly');
  const asLink = await stranger.context.request.get(`/api/docs/${docId}/members?share=${token}`);
  expect(asLink.status(), 'a link holder gets no member list').toBe(404);
  expect(await asLink.text()).not.toContain('@');
  expect((await stranger.context.request.get(`/api/docs/${docId}/links?share=${token}`)).status()).toBe(404);
});
