// j13-vaults (T3.5; A§11): vaults from the switcher in the notes-panel header. Ada makes a vault from the switcher's
// inline "New vault" row, lands in it, and creates a note there that stays in that vault across a reload and a
// switch away and back. Ben, holding a root grant on it, finds it in his switcher with his role as a badge, opens it,
// and is offered no vault actions; his raw rename and trash get 403. Ada renames the vault from its always-visible
// actions button and Ben's switcher follows live; then she moves it to Trash through a confirmation, her open note
// goes terminal in place, and the vault leaves both switchers. Her last vault is never offered to Trash.
//
// The root grant is declared setup through the members API; sharing is not this journey's promise.
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, NAMES, ROLE_ATTR, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR, TERMINAL_REASON_ATTR,
} from '../lib/contract.ts';
import { grant } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
/** BUILDPLAN T2.1: a peer's workspace change reaches an open sidebar within 5 s. */
const PEER_SIDEBAR_MS = 5_000;
const VAULT = 'Field notes';
const RENAMED = 'Field journal';
const NOTE_TITLE = 'Kept in the new vault';
/** Every vault action a member must not be offered, in the switcher or beside it. */
const VAULT_ACTIONS = /New vault|Rename|Trash|Delete|Share vault/;

async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label));
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  return actor;
}

const switcher = (actor: Actor, name: string) => actor.page.getByRole('button', { name: `Vault: ${name}`, exact: true });
const actionsButton = (actor: Actor) => actor.page.getByRole('button', { name: 'Vault actions', exact: true });
const noteRow = (actor: Actor, docId: string) => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`);

/** Opens the switcher on `current` and picks the vault whose menu item reads `item` (its name, then any badge). */
async function switchTo(actor: Actor, current: string, item: string, next: string): Promise<void> {
  await switcher(actor, current).click();
  await actor.page.getByRole('menuitem', { name: item, exact: true }).click();
  await expect(switcher(actor, next), `${actor.label}: the switcher shows ${next}`).toBeVisible();
}

/** The switcher's inline "New vault" row: the name, then Enter. */
async function newVault(actor: Actor, current: string, name: string): Promise<void> {
  await switcher(actor, current).click();
  await actor.page.getByRole('menuitem', { name: 'New vault', exact: true }).click();
  const input = actor.page.getByRole('textbox', { name: 'New vault name', exact: true });
  await expect(input, `${actor.label}: the inline row takes focus`).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  await expect(switcher(actor, name), `${actor.label}: the new vault is active`).toBeVisible({ timeout: BIND_TIMEOUT });
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

test('j13-vaults: Ada creates a vault inline, switches, and creates a note that stays in it @p:note-4 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  await newVault(ada, 'Home', VAULT);
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
  await switchTo(ada, VAULT, 'Home', 'Home');
  await expect(noteRow(ada, docId), 'Home does not list the note').toHaveCount(0);
  await expect(ui.pane(ada, docId), 'the open note stays open across a switch').toBeVisible();
  await switchTo(ada, 'Home', VAULT, VAULT);
  await expect(noteRow(ada, docId)).toBeVisible();

  // The vault and its note are server state: a reload keeps both.
  ada.expectReconnects(1, docId);
  await ada.page.reload();
  await ui.waitLive(ada, docId);
  await ada.declareRemount(docId);
  await expect(switcher(ada, VAULT), 'the vault is still active after a reload').toBeVisible();
  await expect(noteRow(ada, docId)).toBeVisible();

  // A duplicate name is refused in place with a sentence; nothing is created.
  ada.expectHttp(409, '/api/vaults');
  await switcher(ada, VAULT).click();
  await ada.page.getByRole('menuitem', { name: 'New vault', exact: true }).click();
  const input = ada.page.getByRole('textbox', { name: 'New vault name', exact: true });
  await input.fill('home');
  await input.press('Enter');
  await expect(ada.page.getByRole('alert').filter({ hasText: /already have a vault/ }), 'a taken name reads as a sentence').toBeVisible();
  await input.press('Escape');
  expect((await listing(ada)).vaults.filter((vault) => vault.name.toLowerCase() === 'home')).toHaveLength(1);

  // Nobody else discovers a vault that was never shared with them.
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  await switcher(ben, 'Home').click();
  await expect(ben.page.getByRole('menuitem', { name: 'Home', exact: true })).toBeVisible();
  await expect(ben.page.getByRole('menuitem', { name: new RegExp(VAULT) }), "Ada's unshared vault is not Ben's to see").toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await actors.checkpoint('vault-created');
});

test('j13-vaults: Ben, with a root grant, sees the vault with a role badge and no vault actions; the owner renames and trashes it @p:note-4 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  await newVault(ada, 'Home', VAULT);
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, NOTE_TITLE, { enter: true });
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  const vaultId = (await listing(ada, `?doc=${docId}`)).vault.id;
  expect(vaultId, 'the note is in the new vault').not.toBe((await listing(ada, '?vault=none')).vault.id);
  await grantVault(ada, vaultId, benPrincipal, 'editor');

  // Ben finds it in his own switcher, badged with his role, and opens it.
  const ben = await actors.open(benPrincipal);
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  await actors.requireDistinct(2);
  await switchTo(ben, 'Home', `${VAULT} editor`, VAULT);
  await expect(noteRow(ben, docId), "Ben sees Ada's note in her vault").toBeVisible();

  // A member is offered no vault actions: no actions button and nothing in the switcher.
  await expect(actionsButton(ben), 'a member gets no vault actions button').toHaveCount(0);
  await switcher(ben, VAULT).click();
  await expect(ben.page.getByRole('menuitem', { name: `${VAULT} editor`, exact: true })).toBeVisible();
  await expect(ben.page.getByRole('menuitem', { name: VAULT_ACTIONS }), 'a member gets no vault actions in the switcher').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await expect(actionsButton(ada), 'the owner always sees the vault actions button').toBeVisible();

  // Raw requests from the member are refused and change nothing.
  const origin = new URL(ben.page.url()).origin;
  const headers = { origin, 'content-type': 'application/json' };
  expect((await ben.context.request.patch(`${origin}/api/vaults/${vaultId}`, { headers, data: { name: 'Taken over' } })).status()).toBe(403);
  expect((await ben.context.request.delete(`${origin}/api/vaults/${vaultId}`, { headers })).status()).toBe(403);

  // Ada renames it from the actions button; Ben's switcher follows without a reload.
  await actionsButton(ada).click();
  await ada.page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const rename = ada.page.getByRole('textbox', { name: 'Vault name', exact: true });
  await expect(rename, 'the vault name becomes an input').toBeFocused();
  await rename.fill(RENAMED);
  await rename.press('Enter');
  await expect(switcher(ada, RENAMED), 'Ada sees the new name').toBeVisible();
  await expect(switcher(ben, RENAMED), "Ben's switcher follows the rename live").toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await actors.checkpoint('vault-renamed');

  // Cancelling the confirmation keeps the vault.
  await actionsButton(ada).click();
  await ada.page.getByRole('menuitem', { name: 'Move to Trash…', exact: true }).click();
  let confirm = ada.page.getByRole('alertdialog').filter({ hasText: RENAMED });
  await expect(confirm, 'trash asks first').toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(switcher(ada, RENAMED)).toBeVisible();

  // Confirming sends it to Trash: her open note goes terminal in place and the vault leaves both switchers.
  await actionsButton(ada).click();
  await ada.page.getByRole('menuitem', { name: 'Move to Trash…', exact: true }).click();
  confirm = ada.page.getByRole('alertdialog').filter({ hasText: RENAMED });
  await confirm.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(ui.pane(ada, docId), 'the open note goes terminal').toHaveAttribute(TERMINAL_REASON_ATTR, 'deleted', { timeout: PEER_SIDEBAR_MS });
  await expect(ui.body(ada, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
  await expect(ada.page.locator(`[${CONNECTION_BANNER_ATTR}="deleted"]`), 'the notice says why').toBeVisible();
  await expect(switcher(ada, 'Home'), 'Ada lands in Home').toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await expect(switcher(ben, 'Home'), 'Ben falls back to his Home').toBeVisible({ timeout: PEER_SIDEBAR_MS });
  for (const actor of [ada, ben]) {
    await switcher(actor, 'Home').click();
    await expect(actor.page.getByRole('menuitem', { name: new RegExp(`^${RENAMED}`) }), `${actor.label}: the vault leaves the switcher`).toHaveCount(0);
    await actor.page.getByRole('menuitem', { name: 'Home', exact: true }).click();
    await expect(actor.page.getByRole('menu')).toHaveCount(0);
    await expect(noteRow(actor, docId)).toHaveCount(0);
  }
  await actors.checkpoint('vault-trashed');

  // With Home her only vault, Trash is not offered for it, and a raw trash is refused.
  await actionsButton(ada).click();
  await expect(ada.page.getByRole('menuitem', { name: 'Rename…', exact: true })).toBeVisible();
  await expect(ada.page.getByRole('menuitem', { name: 'Move to Trash…', exact: true }), 'the last vault is never offered to Trash').toHaveCount(0);
  await ada.page.keyboard.press('Escape');
  const home = (await listing(ada)).vault.id;
  expect((await ada.context.request.delete(`${origin}/api/vaults/${home}`, { headers })).status()).toBe(409);
});
