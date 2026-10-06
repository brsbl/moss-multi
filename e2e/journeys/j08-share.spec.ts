// j08-share (T2.4): sharing a vault, a folder or a note, with a person at a role or with a revocable link. Ada shares
// a folder from its context menu and her vault from the switcher, and Ben finds each through the invite link she
// hands him (an invite binds to the email, never to an account, until its holder redeems it; T2.8). A viewer link
// opened signed out reads at viewer and offers "Sign in to do more", which comes back to the same note. An editor
// link is viewer signed out, editor signed in, and the max of link and grant with a grant. Revoked, forged and
// inaccessible links all get the same 404 and the same denial page, an email shared with nobody's account answers
// exactly as one shared with an account, and nobody but the owner sees an email.
import { createHash, randomBytes } from 'node:crypto';
import type { Actor, Actors } from '../lib/actors.ts';
import { APP_STATE_ATTR, DOC_SOCKET_PATH, DOC_STATE_ATTR, EDITOR_PANE_ATTR, ROLE_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { acceptInvite, grant, grantDoc } from '../lib/grants.ts';
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

async function noteWithText(ada: Actor): Promise<string> {
  const docId = await ui.createNote(ada);
  await ui.typeBody(ada, docId, TEXT);
  await expect(ui.pane(ada, docId), 'the DocDO acks the text').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: LIVE_TIMEOUT });
  return docId;
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
  await expect(ui.inviteRow(dialog, benPrincipal.email), 'Ben waits at view, by email, until he redeems it').toContainText('Can view');
  await expect(ui.inviteRow(dialog, benPrincipal.email)).toContainText('Invited');
  const invite = await ui.inviteLink(dialog, benPrincipal.email);
  await actors.checkpoint('folder-shared');
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Ben follows the invite link Ada hands him, signed in as the email it was sent to, and lands on the folder.
  await ben.goto(ui.pathOf(invite));
  await expect(ben.page, 'the invite leads to the folder').toHaveURL(new RegExp(`/f/${folderId}$`), { timeout: 30_000 });
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await expect(benFolder, 'the folder is in Ben\'s sidebar').toBeVisible({ timeout: LIVE_TIMEOUT });
  const row = ben.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  // The landing reveals the folder; expand it if it is not open yet.
  if (!(await row.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false))) await benFolder.click();
  await expect(row, 'its note is inside').toBeVisible();
  await row.click();
  await ui.waitOpen(ben, docId, 'readonly');
  await expect(ui.pane(ben, docId), 'Ben reads it at the role Ada chose').toHaveAttribute(ROLE_ATTR, 'viewer');
  await benFolder.click({ button: 'right' });
  await expect(ben.page.getByRole('menuitem', { name: 'Share…', exact: true }), 'only the owner is offered Share…').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await actors.requireDistinct(2);

  // A folder link lands a stranger on the folder (/f/$folderId): its notes and nothing else of Ada's.
  await ui.folderRow(ada, name).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
  const url = await ui.createLink(ada.page.getByRole('dialog', { name: 'Share folder' }), 'Can view');
  expect(new URL(url).pathname).toBe(`/f/${folderId}`);
  await ada.page.keyboard.press('Escape');
  const stranger = await actors.anonymous(ui.pathOf(url), { label: 'stranger' });
  await stranger.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await expect(stranger.page.getByRole('button', { name: `Vault: ${name}`, exact: true }), 'the folder is the workspace').toBeVisible();
  const strangerRow = stranger.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(strangerRow, 'its note is listed').toBeVisible();
  await expect(stranger.page.locator('[data-sidebar-row]'), 'and nothing else').toHaveCount(1);
  await strangerRow.click();
  await ui.waitOpen(stranger, docId, 'readonly');
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
  const invite = await ui.inviteLink(dialog, benPrincipal.email);
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const { vault } = (await (await ada.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  await ben.goto(ui.pathOf(invite));
  await expect(ben.page, 'the invite leads to the vault').toHaveURL(new RegExp(`/f/${vault.id}$`), { timeout: 30_000 });
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });

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
  await ui.waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'editor');
  expect(await ui.fieldText(ben, docId, 'body')).toBe(TEXT);
  await actors.checkpoint('vault-shared');
});

test('j08 vault: a granted co-owner of Ada\'s vault can share it, but gets no create, rename or trash @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const cyPrincipal = await actors.principal('cy');
  const cy = await actors.session(cyPrincipal);
  await cy.goto('/');
  await cy.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });

  await ada.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await ada.page.getByRole('menuitem', { name: 'Share vault…', exact: true }).click();
  const dialog = ada.page.getByRole('dialog', { name: 'Share vault' });
  await ui.shareInDialog(dialog, cyPrincipal.email, 'Owner');
  await expect(ui.inviteRow(dialog, cyPrincipal.email), 'Cy is a co-owner of the vault').toContainText('Owner');
  await ada.page.keyboard.press('Escape');
  // The share is an invite (T2.8): Cy follows it before the vault is his.
  const vaultId = ((await (await ada.context.request.get('/api/workspace')).json()) as { vault: { id: string } }).vault.id;
  await acceptInvite(ada, { folderId: vaultId }, cyPrincipal);
  // Redeemed in another session, as a followed link would be; Cy's open tab reads the listing again.
  await cy.page.reload();
  await cy.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });

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
  const url = await ui.createLink(dialog, 'Can view');
  expect(new URL(url).pathname).toBe(`/d/${docId}`);
  if (browserName === 'chromium') {
    await ada.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ui.linkRow(dialog, 'Can view').getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Copied');
    expect(await ada.page.evaluate(() => navigator.clipboard.readText()), 'Copy puts the link on the clipboard').toBe(url);
  }
  await actors.checkpoint('link-created');
  await ada.page.keyboard.press('Escape');

  const stranger = await actors.anonymous(ui.pathOf(url), { label: 'stranger' });
  await ui.waitOpen(stranger, docId, 'readonly');
  await expect(ui.pane(stranger, docId), 'the link opens at viewer').toHaveAttribute(ROLE_ATTR, 'viewer');
  expect(await ui.fieldText(stranger, docId, 'body'), 'the stranger reads the note').toBe(TEXT);
  await expect(ui.pane(stranger, docId).getByRole('button', { name: 'Share', exact: true }), 'no Share for a link visitor').toHaveCount(0);
  await expect(stranger.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }), 'no "+ Note" for a viewer link (T2.6)').toHaveCount(0);
  const signIn = stranger.page.getByRole('button', { name: 'Sign in to do more', exact: true });
  await expect(signIn, 'the stranger is offered sign-in').toBeVisible();
  await actors.checkpoint('read-signed-out');

  const benPrincipal = await actors.principal('ben');
  await signIn.click();
  await stranger.page.waitForURL((at) => at.pathname === '/login' && at.searchParams.get('next') === ui.pathOf(url));
  await ui.waitForLoginCard(stranger);
  await ui.signInThroughCard(stranger, benPrincipal);
  await stranger.page.waitForURL((at) => `${at.pathname}${at.search}` === ui.pathOf(url), { timeout: 30_000 });
  await ui.waitOpen(stranger, docId, 'readonly');
  await expect(ui.pane(stranger, docId), 'signed in, a viewer link is still a viewer link').toHaveAttribute(ROLE_ATTR, 'viewer');
  await expect(signIn, 'and no longer offers sign-in').toHaveCount(0);
  expect(await ui.fieldText(stranger, docId, 'body')).toBe(TEXT);
});

test('j08 link: an editor link is viewer signed out, editor signed in without a grant, and the max with a grant @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const cyPrincipal = await actors.principal('cy');
  const dialog = await ui.openShare(ada, docId);
  const url = await ui.createLink(dialog, 'Can edit');
  await ui.shareInDialog(dialog, cyPrincipal.email, 'Owner');
  await expect(ui.inviteRow(dialog, cyPrincipal.email), 'Cy is invited as a co-owner').toContainText('Owner');
  await ada.page.keyboard.press('Escape');
  await acceptInvite(ada, { docId }, cyPrincipal);

  const stranger = await actors.anonymous(ui.pathOf(url), { label: 'stranger' });
  await ui.waitOpen(stranger, docId, 'readonly');
  await expect(ui.pane(stranger, docId), 'signed out, an editor link reads at viewer').toHaveAttribute(ROLE_ATTR, 'viewer');

  const ben = await actors.open(await actors.principal('ben'), { path: ui.pathOf(url) });
  await ui.waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId), 'signed in without a grant, the link role').toHaveAttribute(ROLE_ATTR, 'editor');
  const benText = ' and Ben edits through the link';
  await ui.typeBody(ben, docId, benText);
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { timeout: LIVE_TIMEOUT }).toBe(`${TEXT}${benText}`);

  const cy = await actors.open(cyPrincipal, { path: ui.pathOf(url) });
  await ui.waitOpen(cy, docId, 'live');
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
  await grant(ada, { folderId }, benPrincipal, 'viewer');
  const linked = await ada.context.request.post(`/api/folders/${folderId}/links`, { headers, data: { role: 'editor' } });
  expect(linked.status(), 'declared setup: an editor link').toBe(201);
  const { token } = ((await linked.json()) as { link: { token: string } }).link;

  const ben = await actors.open(benPrincipal, { path: `/d/${docId}?share=${token}` });
  await ui.waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId), 'a viewer grant below an editor link: the link').toHaveAttribute(ROLE_ATTR, 'editor');

  const dee = await actors.open(await actors.principal('dee'), { path: `/f/${folderId}?share=${token}` });
  await expect(dee.page.getByRole('button', { name: `Vault: ${name}`, exact: true }), 'the folder is the workspace').toBeVisible({ timeout: LIVE_TIMEOUT });
  const row = dee.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(row, 'its note is listed').toBeVisible();
  await row.click();
  await ui.waitOpen(dee, docId, 'live');
  await expect(ui.pane(dee, docId), 'signed in without a grant, the link role').toHaveAttribute(ROLE_ATTR, 'editor');
  const added = await ui.createNote(dee);
  await expect(ui.pane(dee, added), 'Dee adds a note to the linked folder').toHaveAttribute(ROLE_ATTR, 'editor');
  await actors.requireDistinct(3);
});

test('j08 denial: revoked, forged and inaccessible links get byte-identical 404s and the denial page @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const otherId = await ui.createNote(ada);
  const otherDialog = await ui.openShare(ada, otherId);
  const otherUrl = await ui.createLink(otherDialog, 'Can view');
  await ada.page.keyboard.press('Escape');
  await expect(otherDialog).toBeHidden();
  ada.expectReconnects(1, docId); // Returning to the first note opens its session again.
  await ui.openNote(ada, docId);
  const dialog = await ui.openShare(ada, docId);
  const url = await ui.createLink(dialog, 'Can view');
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
  // Until Ben redeems his invite, an email with an account and one without look the same to the owner.
  for (const email of [benPrincipal.email, ghost.email]) {
    await expect(ui.inviteRow(dialog, email), `${email} waits as a pending invite`).toContainText('Invited');
    await expect(ui.inviteRow(dialog, email)).toContainText('Can edit');
  }
  await expect(ui.accessRow(dialog, benPrincipal), "Ben's name is not shown before he redeems it").toHaveCount(0);
  const invite = await ui.inviteLink(dialog, benPrincipal.email);
  await ada.page.keyboard.press('Escape');
  const linkDialog = await ui.openShare(ada, docId);
  const url = await ui.createLink(linkDialog, 'Can view');
  await ada.page.keyboard.press('Escape');

  const ben = await actors.open(benPrincipal, { path: ui.pathOf(invite) });
  await expect(ben.page, 'the invite leads to the note').toHaveURL(new RegExp(`/d/${docId}$`), { timeout: 30_000 });
  await ui.waitOpen(ben, docId, 'live');
  const asMember = await ben.context.request.get(`/api/docs/${docId}/members`);
  expect(asMember.status()).toBe(200);
  const text = await asMember.text();
  expect(text, 'no email reaches a member').not.toContain('@');
  expect((await ben.context.request.get(`/api/docs/${docId}/links`)).status(), 'a member cannot list links').toBe(403);
  expect((await ben.context.request.post(`/api/docs/${docId}/links`, { headers: { origin: stack.baseUrl }, data: { role: 'viewer' } })).status()).toBe(403);
  await expect(ui.pane(ben, docId).getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  const reopened = await ui.openShare(ada, docId);
  await expect(ui.accessRow(reopened, benPrincipal), 'redeemed, Ben is listed by name').toContainText(benPrincipal.email);
  await expect(ui.inviteRow(reopened, ghost.email)).toContainText('Invited');
  await ada.page.keyboard.press('Escape');

  const token = new URL(url).searchParams.get('share') ?? '';
  const stranger = await actors.anonymous(ui.pathOf(url), { label: 'stranger' });
  await ui.waitOpen(stranger, docId, 'readonly');
  const asLink = await stranger.context.request.get(`/api/docs/${docId}/members?share=${token}`);
  expect(asLink.status(), 'a link holder gets no member list').toBe(404);
  expect(await asLink.text()).not.toContain('@');
  expect((await stranger.context.request.get(`/api/docs/${docId}/links?share=${token}`)).status()).toBe(404);
});

// T2.6: one capability helper gates every moss menu and control on the caller's role (A§8 capabilities).
const RANK_FIXTURE = 'Ranked paragraph.\n\n- [ ] ranked task\n\n```js\nconst ranked = 1;\n```\n\n<blockquote class="html-block">\n<p>ranked html</p>\n</blockquote>\n\nRanked end.';
const MUTATING = ['Rename', 'Duplicate', 'Trash', 'Pin', 'Unpin'];
const HTML_CONTROLS = 'button[aria-label="Edit HTML"], button[aria-label="Delete HTML block"], button[aria-label="Fullscreen"], button[aria-label="Delete"]';

async function rankedNote(ada: Actor, baseUrl: string): Promise<string> {
  const made = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title: 'Ranked', markdown: RANK_FIXTURE } });
  expect(made.status(), 'declared setup: a note with a checklist, code and an HTML block').toBe(201);
  return ((await made.json()) as { doc: { id: string } }).doc.id;
}

const menuItems = (actor: Actor): Promise<string[]> =>
  actor.page.getByRole('menu').getByRole('menuitem').evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ''));

/** Every action the caller is offered on the note: its sidebar row's menu, the top bar's More actions and Share. */
async function offered(actor: Actor, docId: string): Promise<string[]> {
  await actor.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`).click({ button: 'right' });
  await expect(actor.page.getByRole('menuitem', { name: 'Copy Link', exact: true }), `${actor.label}: the row menu opens`).toBeVisible();
  const row = (await menuItems(actor)).map((item) => `row:${item}`);
  await actor.page.keyboard.press('Escape');
  await expect(actor.page.getByRole('menu')).toHaveCount(0);
  await ui.pane(actor, docId).getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(actor.page.getByRole('menuitem', { name: 'Copy markdown', exact: true }), `${actor.label}: More actions opens`).toBeVisible();
  const more = (await menuItems(actor)).map((item) => `more:${item}`);
  await actor.page.keyboard.press('Escape');
  await expect(actor.page.getByRole('menu')).toHaveCount(0);
  const share = (await ui.pane(actor, docId).getByRole('button', { name: 'Share', exact: true }).count()) > 0 ? ['share'] : [];
  return [...row, ...more, ...share].sort();
}

test('j08 ranks: menus grow with rank from viewer to owner, and only the owner trashes or shares @p:ppl-2', async ({ actors, stack }) => {
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await rankedNote(ada, stack.baseUrl);
  const ranks = [['ben', 'viewer'], ['cy', 'commenter'], ['dee', 'editor']] as const;
  const members: Actor[] = [];
  for (const [label, role] of ranks) {
    const principal = await actors.principal(label);
    await grantDoc(ada, docId, principal, role);
    members.push(await actors.open(principal, { path: `/d/${docId}` }));
  }
  await ada.goto(`/d/${docId}`);
  const roles = [...ranks.map(([, role]) => role), 'owner'];
  const sets: string[][] = [];
  for (const [index, actor] of [...members, ada].entries()) {
    await expect(ui.pane(actor, docId), `${actor.label}: the pane goes live`).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
    await expect(ui.pane(actor, docId)).toHaveAttribute(ROLE_ATTR, roles[index]);
    sets.push(await offered(actor, docId));
  }
  const [viewer, commenter, editor, owner] = sets;
  for (let i = 1; i < sets.length; i += 1) {
    expect(sets[i], `${roles[i]} is offered everything ${roles[i - 1]} is`).toEqual(expect.arrayContaining(sets[i - 1]));
  }
  for (const below of [viewer, commenter]) {
    expect(below.filter((item) => ['row:Rename', 'row:Duplicate', 'row:Trash', 'more:Trash', 'share'].includes(item)), 'below editor: no edit or manage action').toEqual([]);
  }
  expect(editor, 'an editor renames and duplicates').toEqual(expect.arrayContaining(['row:Rename', 'row:Duplicate']));
  expect(editor.filter((item) => item.endsWith(':Trash') || item === 'share'), 'an editor neither trashes nor shares').toEqual([]);
  expect(owner, 'the owner trashes and shares').toEqual(expect.arrayContaining(['row:Trash', 'more:Trash', 'share']));
  await actors.requireDistinct(4);
});

/** Doc-sync frames that carry state (y-protocols sync step 2 or update) the page sends on its doc sockets. */
function writeFrames(actor: Actor): { count: () => number } {
  let writes = 0;
  actor.page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.startsWith(DOC_SOCKET_PATH)) return;
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string' && payload[0] === 0 && (payload[1] === 1 || payload[1] === 2)) writes += 1;
    });
  });
  return { count: () => writes };
}

test('j08 read-only: a viewer\'s and a commenter\'s checkbox, slash and block controls are inert and send no frame @p:ppl-2', async ({ actors, stack }) => {
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await rankedNote(ada, stack.baseUrl);
  const box = (actor: Actor) => ui.body(actor, docId).locator('li[role="checkbox"]').filter({ hasText: 'ranked task' });
  const html = (actor: Actor) => ui.body(actor, docId).locator('[data-block-decorator-key]').filter({ hasText: 'ranked html' });
  const slashOptions = (actor: Actor) => actor.page.locator('button[data-index]');
  const clickBox = async (actor: Actor) => {
    const at = await box(actor).boundingBox();
    if (!at) throw new Error(`${actor.label}: no checkbox`);
    await actor.page.mouse.click(at.x + 4, at.y + at.height / 2);
  };

  // Positive controls: the owner's hover finds the HTML block's controls; an editor's checkbox toggles and sends a
  // write, and its "/" opens the slash menu.
  await ada.goto(`/d/${docId}`);
  await expect(ui.pane(ada, docId)).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await html(ada).hover();
  await expect(ui.pane(ada, docId).locator(HTML_CONTROLS).first(), 'the owner is offered the HTML block controls').toBeAttached();
  const deePrincipal = await actors.principal('dee');
  await grantDoc(ada, docId, deePrincipal, 'editor');
  const dee = await actors.session(deePrincipal);
  const deeFrames = writeFrames(dee);
  await dee.goto(`/d/${docId}`);
  await ui.waitOpen(dee, docId, 'live');
  const deeBefore = deeFrames.count();
  await clickBox(dee);
  await expect(box(dee), 'an editor toggles the checkbox').toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => deeFrames.count(), { message: 'and the toggle is a write' }).toBeGreaterThan(deeBefore);
  await expect(box(ada), 'which reaches the owner').toHaveAttribute('aria-checked', 'true', { timeout: LIVE_TIMEOUT });
  await ui.body(dee, docId).locator('p').filter({ hasText: 'Ranked end.' }).click();
  await dee.page.keyboard.press('End');
  await dee.page.keyboard.press('Enter');
  await dee.page.keyboard.type('/');
  await expect(slashOptions(dee).first(), 'an editor\'s "/" opens the slash menu').toBeVisible();
  await dee.page.keyboard.press('Escape');
  await dee.page.keyboard.press('Backspace');
  await dee.page.keyboard.press('Backspace');
  await expect(ui.pane(dee, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: LIVE_TIMEOUT });
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { timeout: LIVE_TIMEOUT }).toBe(await ui.fieldText(dee, docId, 'body'));
  const settled = await ui.fieldText(ada, docId, 'body');

  for (const [label, role] of [['ben', 'viewer'], ['cy', 'commenter']] as const) {
    const principal = await actors.principal(label);
    await grantDoc(ada, docId, principal, role);
    const reader = await actors.session(principal);
    const frames = writeFrames(reader);
    await reader.goto(`/d/${docId}`);
    await ui.waitOpen(reader, docId, 'readonly');
    await expect(ui.pane(reader, docId)).toHaveAttribute(ROLE_ATTR, role);
    await expect.poll(() => ui.fieldText(reader, docId, 'body'), { timeout: LIVE_TIMEOUT }).toBe(settled);
    const before = frames.count();

    await clickBox(reader);
    await ui.body(reader, docId).locator('p').filter({ hasText: 'Ranked paragraph.' }).click();
    await reader.page.keyboard.press('End');
    await reader.page.keyboard.press('Enter');
    await reader.page.keyboard.type('/');
    await html(reader).hover();
    await reader.page.waitForTimeout(500); // a slash menu or block header would render well inside this
    await expect(box(reader), `${role}: the checkbox does not toggle`).toHaveAttribute('aria-checked', 'true');
    await expect(slashOptions(reader), `${role}: "/" opens no slash menu`).toHaveCount(0);
    await expect(ui.pane(reader, docId).locator(HTML_CONTROLS), `${role}: the HTML block offers no Edit, Fullscreen or Delete`).toHaveCount(0);
    await reader.page.keyboard.press('Escape');
    await reader.page.waitForTimeout(1_000);
    expect(frames.count() - before, `${role}: no write frame leaves the page`).toBe(0);
    expect(await ui.fieldText(ada, docId, 'body'), `${role}: the owner's note is unchanged`).toBe(settled);
  }
  await actors.requireDistinct(4);
});

test('j08 unknown role: a role the client does not know gets no actions @p:ppl-2', async ({ actors, stack }) => {
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await rankedNote(ada, stack.baseUrl);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await actors.session(benPrincipal);
  // Every role the workspace listing names becomes one this client has never heard of.
  await ben.page.route('**/api/workspace**', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/"role":"[a-z]+"/g, '"role":"superuser"') });
  });
  await ben.goto('/');
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  const row = ben.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  await expect(row, 'the note is listed').toBeVisible({ timeout: LIVE_TIMEOUT });
  await row.click({ button: 'right' });
  await expect(ben.page.getByRole('menuitem', { name: 'Copy Link', exact: true }), 'the row menu opens').toBeVisible();
  expect((await menuItems(ben)).filter((item) => MUTATING.includes(item)), 'no action on an unknown role').toEqual([]);
  await ben.page.keyboard.press('Escape');
  await expect(ben.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }), 'no "+ Note" in a vault at an unknown role').toHaveCount(0);
  await actors.requireDistinct(2);
});
