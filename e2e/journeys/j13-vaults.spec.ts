// j13-vaults (T3.5, T9.31; A§11): vaults from the footer's app menu and Settings. Ada makes a vault from Switch
// vault… > New vault…, lands in it, and creates a note there that stays in that vault across a reload and a switch
// away and back. Ben, holding a root grant on it, finds it in his Switch vault… list with his role, opens it, and is
// offered no vault actions in Settings; his raw rename and trash get 403. Ada renames the vault in Settings' Vaults and
// Ben's app menu follows live; then she moves it to Trash through a confirmation, her open note goes terminal in place,
// and the vault leaves both lists. Her last vault is never offered to Trash. A note of a trashed vault restores from
// Trash: the vault row returns without its folders and the note opens at its top.
//
// The root grant is declared setup through the members API; sharing is not this journey's promise.
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, NAMES, ROLE_ATTR, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR, TERMINAL_REASON_ATTR,
  TRASH_ROW_ATTR,
} from '../lib/contract.ts';
import { grant } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';
import { TRASH_COPY } from '../../packages/protocol/src/retention.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
/** BUILDPLAN T2.1: a peer's workspace change reaches an open sidebar within 5 s. */
const PEER_SIDEBAR_MS = 5_000;
const VAULT = 'Field notes';
const RENAMED = 'Field journal';
const NOTE_TITLE = 'Kept in the new vault';
/** Every action on the vault on screen that a member must not be offered. */
const VAULT_ACTIONS = /^(Rename…|Move to Trash…|Share vault…)$/;

async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label));
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  return actor;
}

const noteRow = (actor: Actor, docId: string) => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`);
const trashRow = (actor: Actor, docId: string) => actor.page.locator(`[${TRASH_ROW_ATTR}][${NAMES.docId}="${docId}"]`);

/** Picks the vault whose Switch vault… row reads `item` (its name, then any role), and lands in `next`. */
async function switchTo(actor: Actor, item: string, next: string): Promise<void> {
  await ui.switchVault(actor.page, item);
  await ui.expectVault(actor.page, next, { message: `${actor.label}: the vault on screen is ${next}` });
}

const newVault = (actor: Actor, name: string): Promise<void> => ui.newVault(actor.page, name);

/** Settings' Vaults, disclosed, and one of its actions on the vault on screen. */
async function vaultAction(actor: Actor, action: 'Rename…' | 'Move to Trash…'): Promise<void> {
  await (await ui.openVaultSettings(actor.page)).getByRole('button', { name: action, exact: true }).click();
}

async function listing(actor: Actor, query = ''): Promise<{ vault: { id: string; name: string }; vaults: { id: string; name: string; role?: string }[]; docs: { id: string }[] }> {
  const origin = new URL(actor.page.url()).origin;
  const response = await actor.context.request.get(`${origin}/api/workspace${query}`, { timeout: 15_000 });
  expect(response.status()).toBe(200);
  return response.json();
}

/** Declared setup: the owner grants `member` a role on the vault. */
async function grantVault(owner: Actor, vaultId: string, member: Principal, role: 'viewer' | 'editor'): Promise<void> {
  // A share by email is an invite (T2.8); declared setup redeems it as following its link would.
  await grant(owner, { folderId: vaultId }, member, role);
}

test('j13-vaults: Ada creates a vault inline, switches, and creates a note that stays in it @p:note-4@3 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  await newVault(ada, VAULT);
  await expect(ada.page.locator(`[${SIDEBAR_ROW_ATTR}]`), 'the new vault starts empty').toHaveCount(0);

  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, NOTE_TITLE, { enter: true });
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(ui.pane(ada, docId), 'Ada owns the note in her vault').toHaveAttribute(ROLE_ATTR, 'owner');
  await expect(noteRow(ada, docId), 'the note is listed in the new vault').toBeVisible();
  const made = await listing(ada, `?doc=${docId}`);
  expect(made.vault.name, 'the server listing is the new vault').toBe(VAULT);
  expect(made.docs.map((doc) => doc.id), 'the note was created in the new vault').toContain(docId);

  // Home does not hold it; switching back does.
  await switchTo(ada, 'Home', 'Home');
  await expect(noteRow(ada, docId), 'Home does not list the note').toHaveCount(0);
  await expect(ui.pane(ada, docId), 'the open note stays open across a switch').toBeVisible();
  await switchTo(ada, VAULT, VAULT);
  await expect(noteRow(ada, docId)).toBeVisible();

  // The vault and its note are server state: a reload keeps both.
  ada.expectReconnects(1, docId);
  await ada.page.reload();
  await ui.waitLive(ada, docId);
  await ada.declareRemount(docId);
  await ui.expectVault(ada.page, VAULT, { message: 'the vault is still active after a reload' });
  await expect(noteRow(ada, docId)).toBeVisible();

  // A duplicate name is refused in place with a sentence; nothing is created.
  ada.expectHttp(409, '/api/vaults');
  await (await ui.openVaultList(ada.page)).getByRole('menuitem', { name: 'New vault…', exact: true }).click();
  const input = ada.page.getByRole('textbox', { name: 'New vault name', exact: true });
  await expect(input).toBeFocused();
  await input.fill('home');
  await input.press('Enter');
  await expect(ada.page.getByRole('alert').filter({ hasText: /already have a vault/ }), 'a taken name reads as a sentence').toBeVisible();
  await input.press('Escape');
  await expect(input, 'Escape leaves the field').toHaveCount(0);
  await ada.page.keyboard.press('Escape');
  await expect(ada.page.getByRole('dialog')).toHaveCount(0);
  expect((await listing(ada)).vaults.filter((vault) => vault.name.toLowerCase() === 'home')).toHaveLength(1);

  // Nobody else discovers a vault that was never shared with them.
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const benList = await ui.openVaultList(ben.page);
  await expect(benList.getByRole('menuitemradio', { name: 'Home', exact: true })).toBeVisible();
  await expect(benList.getByRole('menuitemradio', { name: new RegExp(VAULT) }), "Ada's unshared vault is not Ben's to see").toHaveCount(0);
  await ui.closeVaultList(ben.page);
  await actors.checkpoint('vault-created');
});

test('j13-vaults: Ben, with a root grant, sees the vault with his role and no vault actions; the owner renames and trashes it @p:note-4@3 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  await newVault(ada, VAULT);
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, NOTE_TITLE, { enter: true });
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  const vaultId = (await listing(ada, `?doc=${docId}`)).vault.id;
  expect(vaultId, 'the note is in the new vault').not.toBe((await listing(ada, '?vault=none')).vault.id);
  await grantVault(ada, vaultId, benPrincipal, 'editor');

  // Ben finds it in his own Switch vault… list, with his role, and opens it.
  const ben = await actors.open(benPrincipal);
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  await actors.requireDistinct(2);
  await switchTo(ben, `${VAULT} Can edit`, VAULT);
  await expect(noteRow(ben, docId), "Ben sees Ada's note in her vault").toBeVisible();

  // A member is offered no vault actions: Settings lists the vault with his role and nothing to do to it.
  const benSettings = await ui.openVaultSettings(ben.page);
  await expect(benSettings.getByRole('list', { name: 'Vaults' }).getByText('Can edit', { exact: true })).toBeVisible();
  await expect(benSettings.getByRole('button', { name: VAULT_ACTIONS }), 'a member gets no vault actions').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await expect(benSettings).toBeHidden();

  // Raw requests from the member are refused and change nothing.
  const origin = new URL(ben.page.url()).origin;
  const headers = { origin, 'content-type': 'application/json' };
  expect((await ben.context.request.patch(`${origin}/api/vaults/${vaultId}`, { headers, data: { name: 'Taken over' } })).status()).toBe(403);
  expect((await ben.context.request.delete(`${origin}/api/vaults/${vaultId}`, { headers })).status()).toBe(403);

  // Ada renames it in Settings; Ben's app menu follows without a reload.
  await vaultAction(ada, 'Rename…');
  const rename = ada.page.getByRole('textbox', { name: 'Vault name', exact: true });
  await expect(rename, 'the vault name becomes an input').toBeFocused();
  await rename.fill(RENAMED);
  await rename.press('Enter');
  const adaSettings = ada.page.getByRole('dialog', { name: 'Settings' });
  await expect(adaSettings.getByRole('list', { name: 'Vaults' }).getByText(RENAMED, { exact: true }), 'Ada sees the new name').toBeVisible();
  await ada.page.keyboard.press('Escape');
  await expect(adaSettings).toBeHidden();
  await ui.expectVault(ada.page, RENAMED);
  await ui.expectVault(ben.page, RENAMED, { timeout: PEER_SIDEBAR_MS, message: "Ben's app menu follows the rename live" });
  await actors.checkpoint('vault-renamed');

  // Cancelling the confirmation keeps the vault.
  await vaultAction(ada, 'Move to Trash…');
  const confirm = ada.page.getByRole('alertdialog').filter({ hasText: RENAMED });
  await expect(confirm, 'trash asks first').toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(adaSettings.getByRole('list', { name: 'Vaults' }).getByText(RENAMED, { exact: true })).toBeVisible();

  // Confirming sends it to Trash: her open note goes terminal in place and the vault leaves both lists.
  await adaSettings.getByRole('button', { name: 'Move to Trash…', exact: true }).click();
  await confirm.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await ada.page.keyboard.press('Escape');
  await expect(adaSettings).toBeHidden();
  await expect(ui.pane(ada, docId), 'the open note goes terminal').toHaveAttribute(TERMINAL_REASON_ATTR, 'deleted', { timeout: PEER_SIDEBAR_MS });
  await expect(ui.body(ada, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
  await expect(ada.page.locator(`[${CONNECTION_BANNER_ATTR}="deleted"]`), 'the notice says why').toBeVisible();
  await ui.expectVault(ada.page, 'Home', { timeout: PEER_SIDEBAR_MS, message: 'Ada lands in Home' });
  await ui.expectVault(ben.page, 'Home', { timeout: PEER_SIDEBAR_MS, message: 'Ben falls back to his Home' });
  for (const actor of [ada, ben]) {
    const list = await ui.openVaultList(actor.page);
    await expect(list.getByRole('menuitemradio', { name: new RegExp(`^${RENAMED}`) }), `${actor.label}: the vault leaves the list`).toHaveCount(0);
    await list.getByRole('menuitemradio', { name: 'Home', exact: true }).click();
    await expect(actor.page.getByRole('menu')).toHaveCount(0);
    await expect(noteRow(actor, docId)).toHaveCount(0);
  }
  await actors.checkpoint('vault-trashed');

  // With Home her only vault, Trash is not offered for it, and a raw trash is refused.
  const last = await ui.openVaultSettings(ada.page);
  await expect(last.getByRole('button', { name: 'Rename…', exact: true })).toBeVisible();
  await expect(last.getByRole('button', { name: 'Move to Trash…', exact: true }), 'the last vault is never offered to Trash').toHaveCount(0);
  await ada.page.keyboard.press('Escape');
  const home = (await listing(ada)).vault.id;
  expect((await ada.context.request.delete(`${origin}/api/vaults/${home}`, { headers })).status()).toBe(409);
});

test('j13-vaults: Ada restores notes from a vault she moved to Trash: the vault returns without its folders and each note opens live @p:note-5', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  actors.solo('one owner trashes her own vault and restores its notes');
  const TRIP = 'Trip notes';
  await newVault(ada, TRIP);
  // Declared setup: a folder and two same-titled notes, one at the vault's top and one in the folder.
  const origin = new URL(ada.page.url()).origin;
  const send = (path: string, data: object) => ada.context.request.post(`${origin}${path}`, { headers: { origin }, data, timeout: 15_000 });
  const vaultId = (await listing(ada)).vaults.find((vault) => vault.name === TRIP)?.id ?? '';
  expect(vaultId, 'the new vault is listed').not.toBe('');
  const made = await send('/api/folders', { parentId: vaultId, name: 'Bookings' });
  expect(made.status(), 'declared setup: the folder').toBe(201);
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  const ids: string[] = [];
  for (const [folder, body] of [[vaultId, 'Passport, charger, boots.'], [folderId, 'Second copy, in Bookings.']]) {
    const note = await send('/api/docs', { folderId: folder, title: 'Packing list', markdown: body });
    expect(note.status(), 'declared setup: a note').toBe(201);
    ids.push(((await note.json()) as { doc: { id: string } }).doc.id);
  }
  const [atTop, inFolder] = ids;
  await expect(noteRow(ada, atTop)).toBeVisible({ timeout: PEER_SIDEBAR_MS });

  // The folder's confirmation says where its notes come back.
  await ui.folderRow(ada, 'Bookings').click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: /^Trash/ }).click();
  const folderConfirm = ada.page.getByText(TRASH_COPY.trashFolder('Bookings', TRIP), { exact: true });
  await expect(folderConfirm, 'the folder confirmation').toBeVisible();
  await ada.page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(folderConfirm).toHaveCount(0);

  // The vault's confirmation says what a restore brings back; confirming sends it to Trash.
  await vaultAction(ada, 'Move to Trash…');
  const confirm = ada.page.getByRole('alertdialog').filter({ hasText: TRIP });
  await expect(confirm, 'the vault confirmation').toContainText(TRASH_COPY.trashVault(TRIP));
  await confirm.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await ada.page.keyboard.press('Escape');
  await expect(ada.page.getByRole('dialog')).toHaveCount(0);
  await ui.expectVault(ada.page, 'Home', { timeout: PEER_SIDEBAR_MS, message: 'Ada lands in Home' });

  // Restore from the Trash row's menu: the vault is back and on screen with the note at its top, open and live.
  for (const docId of ids) ada.expectReconnects(1, docId);
  const refused = ada.page.getByText(/no longer available|vault is in Trash/);
  await ada.page.getByRole('button', { name: 'Trash', exact: true }).click();
  // Seen from Home, each row names the trashed vault it restores into.
  for (const docId of ids) await expect(trashRow(ada, docId), 'the row names its vault').toContainText(new RegExp(`Deleted .+ · ${TRIP}$`));
  await trashRow(ada, atTop).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
  await expect(noteRow(ada, atTop), 'the note is at the top of its vault').toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await ui.expectVault(ada.page, TRIP, { timeout: PEER_SIDEBAR_MS, message: 'the vault is back and on screen' });
  await expect(noteRow(ada, atTop), 'the note is at the top of its vault').toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await ui.waitLive(ada, atTop);
  await expect(refused, 'no refusal').toHaveCount(0);
  await expect(ui.folderRow(ada, 'Bookings'), 'its folder stays in Trash').toHaveCount(0);

  // The same-titled note from the folder restores beside it from More actions.
  await ada.page.getByRole('button', { name: 'Trash', exact: true }).click();
  await trashRow(ada, inFolder).click();
  await ada.page.getByRole('button', { name: 'More actions', exact: true }).click();
  await ada.page.getByRole('menuitem', { name: /^Restore/ }).click();
  await expect(noteRow(ada, inFolder), 'the second note restores beside the first').toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await expect(noteRow(ada, atTop)).toBeVisible();
  await ui.waitLive(ada, inFolder);
  await expect(refused, 'no refusal').toHaveCount(0);
  await ui.expectVault(ada.page, TRIP);
  const after = (await listing(ada, `?vault=${vaultId}`)) as unknown as { vaults: { name: string }[]; docs: { id: string; filename: string; trashedAt?: number | null }[] };
  expect(after.vaults.map((vault) => vault.name)).toEqual(expect.arrayContaining(['Home', TRIP]));
  const live = after.docs.filter((doc) => ids.includes(doc.id) && !doc.trashedAt);
  expect(live, 'both notes are live').toHaveLength(2);
  expect(new Set(live.map((doc) => doc.filename)).size, 'two rows, two filenames').toBe(2);
  await actors.checkpoint('vault-restored');
});

test('j13-vaults: a search result from Ada’s other vault opens there, by click and by Enter; one from the vault on screen opens in place @p:note-7 @p:note-4@3', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  actors.solo('one owner searches across her own vaults');
  const run = Math.random().toString(36).slice(2, 8);
  const word = `lentil${run}`;
  const local = `scratchword${run}`;
  const origin = new URL(ada.page.url()).origin;
  const send = (path: string, data: object) => ada.context.request.post(`${origin}${path}`, { headers: { origin }, data, timeout: 15_000 });
  const home = (await listing(ada)).vault.id;
  // Declared setup: a vault Scratch with notes of its own, and a note only Home holds, made from Scratch so nothing
  // has opened it yet.
  await newVault(ada, 'Scratch');
  const made = await send('/api/docs', { folderId: home, title: `Lentil soup ${run}`, markdown: `Red ${word}, cumin and lemon.` });
  expect(made.status(), 'declared setup: the Home note').toBe(201);
  const soup = ((await made.json()) as { doc: { id: string } }).doc.id;
  const scratch = (await listing(ada)).vaults.find((vault) => vault.name === 'Scratch')?.id ?? '';
  const pad = await send('/api/docs', { folderId: scratch, title: `Scratch pad ${run}`, markdown: `Only ${local} here.` });
  expect(pad.status(), 'declared setup: the Scratch note').toBe(201);
  const padId = ((await pad.json()) as { doc: { id: string } }).doc.id;
  // A newer Scratch note heads its listing, where a note the store lacks would fall back to.
  const later = await send('/api/docs', { folderId: scratch, title: `Later ${run}`, markdown: 'Nothing about soup.' });
  expect(later.status(), 'declared setup: a second Scratch note').toBe(201);
  const laterId = ((await later.json()) as { doc: { id: string } }).doc.id;
  await expect(noteRow(ada, padId)).toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await expect(noteRow(ada, laterId)).toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await expect(noteRow(ada, soup), 'Scratch does not list the Home note').toHaveCount(0);
  for (const [query, docId] of [[word, soup], [local, padId]]) {
    await expect.poll(async () => {
      const answer = await ada.context.request.get(`${origin}/api/search?q=${query}`);
      return ((await answer.json()) as { results?: { id: string }[] }).results?.map((hit) => hit.id) ?? [];
    }, { message: `the index answers ${query}`, timeout: 20_000 }).toContain(docId);
  }
  const field = ada.page.getByRole('textbox', { name: 'Search notes' });
  const search = async (query: string) => {
    if (!(await field.isVisible())) await ada.page.getByRole('button', { name: 'Search notes', exact: true }).click();
    await field.fill(query);
  };

  // A result from the vault on screen opens in place.
  await search(local);
  await noteRow(ada, padId).click();
  await ui.waitLive(ada, padId);
  await ada.declareRemount(padId);
  await ui.expectVault(ada.page, 'Scratch', { message: 'a result from the vault on screen keeps the vault' });

  // Clicking the Home result: the switcher shows Home, the panel lists Home's notes, and the note is open and live.
  await search(word);
  await expect(noteRow(ada, soup), 'the Home note is found from Scratch').toBeVisible({ timeout: BIND_TIMEOUT });
  await noteRow(ada, soup).click();
  await ui.waitLive(ada, soup);
  await ada.declareRemount(soup);
  await expect(field, 'choosing a result closes search').toBeHidden();
  await expect(noteRow(ada, soup), 'the panel lists Home’s notes').toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await expect(noteRow(ada, padId)).toHaveCount(0);
  await ui.expectVault(ada.page, 'Home', { message: 'the app menu moves to the note’s vault' });
  await actors.checkpoint('cross-vault-click');

  // Back in Scratch, Enter on the only result does the same. Each note opens once more, and only once more.
  ada.expectReconnects(1, padId);
  ada.expectReconnects(1, soup);
  await switchTo(ada, 'Scratch', 'Scratch');
  await ui.openNote(ada, padId);
  await search(word);
  await expect(noteRow(ada, soup)).toBeVisible({ timeout: BIND_TIMEOUT });
  await field.press('Enter');
  await ui.waitLive(ada, soup);
  await ada.declareRemount(soup);
  await expect(field).toBeHidden();
  await expect(noteRow(ada, soup)).toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await ui.expectVault(ada.page, 'Home', { message: 'Enter moves to the note’s vault too' });
  await actors.checkpoint('cross-vault-enter');

  // In Scratch with the Home note still open, choosing its result moves to Home all the same.
  await switchTo(ada, 'Scratch', 'Scratch');
  await expect(noteRow(ada, padId), 'the panel lists Scratch’s notes').toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await expect.poll(() => ui.paneIds(ada), { message: 'the Home note stays open across the switch' }).toContain(soup);
  await search(word);
  await expect(noteRow(ada, soup)).toBeVisible({ timeout: BIND_TIMEOUT });
  await noteRow(ada, soup).click();
  await expect(field).toBeHidden();
  await expect(noteRow(ada, padId), 'the panel lists Home’s notes').toHaveCount(0, { timeout: PEER_SIDEBAR_MS });
  await expect(noteRow(ada, soup)).toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await ui.waitLive(ada, soup);
  await ui.expectVault(ada.page, 'Home', { message: 'an open note’s result moves to its vault' });
  await actors.checkpoint('cross-vault-already-open');
});
