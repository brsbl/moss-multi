// j06-folders (T2.2; A§6, A§9 folders, A§11): folders from the web UI. A naive person starts from an empty
// workspace and uses only moss's own sidebar: Folder actions → New Folder, a subfolder from the hover button, a note
// dragged into the folder, a rename by clicking the open folder's name, and Trash Folder from its context menu,
// which sends the whole subtree to Trash as one batch. A collaborator with a note open inside that subtree sees it
// go terminal in place. An editor on a shared vault creates a folder that the owner sees live; a viewer is offered
// none. A refused folder change always reads as a sentence: never "Unknown parent folder", never a bare "Failed".
//
// Vault grants are declared setup through the members API; sharing is not this journey's promise.
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, EDITOR_PANE_ATTR, ROLE_ATTR, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR,
  TERMINAL_REASON_ATTR, NAMES,
} from '../lib/contract.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
/** BUILDPLAN T2.1: a peer's workspace change reaches an open sidebar within 5 s. */
const PEER_SIDEBAR_MS = 5_000;
const DENIAL = /doesn.t exist or you don.t have access/i;
const NOTE_TEXT = 'Folder journey body, kept in place';

async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label));
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  return actor;
}

/** A folder's header row in the notes list (moss's FolderGroup names it "<name> folder, N notes, …"). */
const folderRow = (actor: Actor, name: string) =>
  actor.page.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} folder, `) });

const noteRow = (actor: Actor, docId: string) => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`);

/** Opens a folder (clicking it also makes it moss's active folder, where "+ Note" creates). */
async function expandFolder(actor: Actor, name: string): Promise<void> {
  const row = folderRow(actor, name);
  await expect(row).toBeVisible();
  if (/collapsed$/.test((await row.getAttribute('aria-label')) ?? '')) await row.click();
  await expect(row, `${actor.label}: ${name} opens`).toHaveAccessibleName(/expanded$/);
}

/** Folder actions → New Folder, then the name and Enter in moss's inline input. */
async function newFolder(actor: Actor, name: string): Promise<void> {
  await actor.page.getByRole('button', { name: 'Folder actions', exact: true }).click();
  await actor.page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();
  const input = actor.page.getByPlaceholder('Folder name...');
  await expect(input, `${actor.label}: the inline folder name field opens`).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
}

/** Neither the coded error a synthetic group used to raise nor a bare "Failed" ever reaches the page. */
async function expectNoCodedErrors(actor: Actor): Promise<void> {
  await expect(actor.page.getByText(/Unknown parent folder/i), `${actor.label}: no coded folder error`).toHaveCount(0);
  await expect(actor.page.getByText('Failed', { exact: true }), `${actor.label}: no bare "Failed"`).toHaveCount(0);
}

/** Declared setup: the owner grants `member` a role on her Home vault. */
async function grantVault(owner: Actor, member: Principal, role: 'viewer' | 'editor'): Promise<string> {
  const origin = new URL(owner.page.url()).origin;
  const { vault } = (await (await owner.context.request.get(`${origin}/api/workspace`)).json()) as { vault: { id: string } };
  const response = await owner.context.request.post(`${origin}/api/folders/${vault.id}/members`, {
    headers: { origin, 'content-type': 'application/json' }, data: { email: member.email, role }, timeout: 15_000,
  });
  expect(response.status(), `declared setup: ${member.label} is a vault ${role}`).toBe(201);
  return vault.id;
}

test('j06-folders: from an empty workspace, create, nest, fill, rename and trash a folder; a peer inside the subtree goes terminal in place @p:note-4 @p:note-5 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  await expect(ada.page.locator(`[${SIDEBAR_ROW_ATTR}]`), 'Ada starts from an empty workspace').toHaveCount(0);

  await newFolder(ada, 'Plans');
  await expect(folderRow(ada, 'Plans'), 'the new folder shows in the empty workspace').toBeVisible();
  await expectNoCodedErrors(ada);

  // A note made at the root, then dragged into the folder.
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Moved into a folder', { enter: true });
  await ui.typeBody(ada, docId, NOTE_TEXT);
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await noteRow(ada, docId).locator('[draggable="true"]').dragTo(folderRow(ada, 'Plans'));
  await expect(folderRow(ada, 'Plans'), 'the folder counts the moved note').toHaveAccessibleName(/^Plans folder, 1 note,/);

  // Open the folder, rename it by clicking its name, and nest a subfolder from the hover button.
  await expandFolder(ada, 'Plans');
  await folderRow(ada, 'Plans').getByRole('button', { name: 'Click to rename folder' }).click();
  const rename = folderRow(ada, 'Plans').getByRole('textbox');
  await expect(rename, 'the folder name becomes an input').toBeFocused();
  await rename.fill('Projects');
  await rename.press('Enter');
  await expect(folderRow(ada, 'Projects'), 'the folder is renamed').toBeVisible();
  await expect(folderRow(ada, 'Plans')).toHaveCount(0);
  await expandFolder(ada, 'Projects');
  const inside = ada.page.getByRole('region', { name: 'Notes in Projects folder' });
  await expect(inside.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`), 'the note is inside the renamed folder').toBeVisible();
  await folderRow(ada, 'Projects').hover();
  await folderRow(ada, 'Projects').getByRole('button', { name: 'Create subfolder' }).click();
  const sub = ada.page.getByPlaceholder('Subfolder name...');
  await expect(sub).toBeFocused();
  await sub.fill('Drafts');
  await sub.press('Enter');
  await expect(folderRow(ada, 'Drafts'), 'the subfolder nests inside Projects').toBeVisible();
  await expectNoCodedErrors(ada);

  // The rename and the move survive a reload: they are server state, not local atoms.
  ada.expectReconnects(1, docId);
  await ada.page.reload();
  await ui.waitLive(ada, docId);
  await ada.declareRemount(docId);
  await expect(folderRow(ada, 'Projects')).toBeVisible();
  await expect(folderRow(ada, 'Projects'), 'the moved note is still counted after a reload').toHaveAccessibleName(/^Projects folder, 1 note,/);
  await actors.checkpoint('folders-made');

  // Ben, an editor on Ada's vault, has the note open when Ada trashes the folder.
  await grantVault(ada, benPrincipal, 'editor');
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await ui.waitLive(ben, docId);
  await ben.observeEditor(docId);
  await actors.requireDistinct(2);
  await expect(folderRow(ben, 'Projects'), "Ben's sidebar shows Ada's folder").toBeVisible();
  expect(await ui.fieldText(ben, docId, 'body')).toBe(NOTE_TEXT);

  await folderRow(ada, 'Projects').click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Trash Folder', exact: true }).click();
  await ada.page.getByRole('button', { name: 'Trash', exact: true }).click();

  for (const actor of [ada, ben]) {
    await expect(ui.pane(actor, docId), `${actor.label}: the open note goes terminal`).toHaveAttribute(TERMINAL_REASON_ATTR, 'deleted', { timeout: PEER_SIDEBAR_MS });
    await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
    await expect(ui.body(actor, docId)).toHaveAttribute('contenteditable', 'false');
    await expect(ui.body(actor, docId), `${actor.label}: the content stays visible in place`).toHaveText(NOTE_TEXT);
    await expect(actor.page.locator(`[${CONNECTION_BANNER_ATTR}="deleted"]`), `${actor.label}: the notice says why`).toBeVisible();
    await expect(folderRow(actor, 'Projects'), `${actor.label}: the folder leaves the sidebar`).toHaveCount(0, { timeout: PEER_SIDEBAR_MS });
    await expect(folderRow(actor, 'Drafts'), `${actor.label}: the subfolder goes with it`).toHaveCount(0, { timeout: PEER_SIDEBAR_MS });
    await expect(noteRow(actor, docId), `${actor.label}: the note leaves the sidebar`).toHaveCount(0, { timeout: PEER_SIDEBAR_MS });
    await expectNoCodedErrors(actor);
  }
  // Typing into the terminal note does nothing.
  await ui.body(ben, docId).click({ force: true });
  await ben.page.keyboard.type('zombie');
  await expect(ui.body(ben, docId)).toHaveText(NOTE_TEXT);
  await actors.checkpoint('subtree-trashed');

  // A fresh load of a note in the trashed subtree is the one denial page.
  ben.expectHttp(404, `/api/docs/${docId}`);
  ada.expectHttp(404, `/api/docs/${docId}`);
  await ben.goto(`/d/${docId}`);
  await expect(ben.page.getByRole('heading', { name: DENIAL }), 'a fresh load gets the denial page').toBeVisible({ timeout: BOOT_TIMEOUT });
  await expect(ben.page.locator(`[${EDITOR_PANE_ATTR}]`)).toHaveCount(0);
});

test('j06-folders: an editor on a shared vault creates a folder the owner sees live; a viewer is offered none @p:note-4 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const cyPrincipal = await actors.principal('cy');
  await grantVault(ada, benPrincipal, 'editor');
  await grantVault(ada, cyPrincipal, 'viewer');

  const ben = await actors.open(benPrincipal);
  await ben.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await ben.page.getByRole('menuitem', { name: 'Home editor', exact: true }).click();
  await newFolder(ben, 'Ben research');
  await expect(folderRow(ben, 'Ben research'), "Ben's folder shows in Ada's vault").toBeVisible();
  await expect(folderRow(ada, 'Ben research'), 'Ada sees it without a reload').toBeVisible({ timeout: PEER_SIDEBAR_MS });
  await expectNoCodedErrors(ben);

  // A note Ben makes inside it is Ada's vault's note, at Ben's editor role.
  await expandFolder(ben, 'Ben research');
  const docId = await ui.createNote(ben);
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'editor');
  await expect(ben.page.getByRole('region', { name: 'Notes in Ben research folder' }).locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`),
    'the note lands in the active folder').toBeVisible();
  await expandFolder(ada, 'Ben research');
  await expect(ada.page.getByRole('region', { name: 'Notes in Ben research folder' }).locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`),
    "Ada sees Ben's note in her folder").toBeVisible({ timeout: PEER_SIDEBAR_MS });

  // Cy can read the vault but is offered no folder creation, rename or trash.
  const cy = await actors.open(cyPrincipal);
  await cy.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await cy.page.getByRole('menuitem', { name: 'Home viewer', exact: true }).click();
  await expect(folderRow(cy, 'Ben research')).toBeVisible();
  await expect(cy.page.getByRole('button', { name: 'Folder actions', exact: true }), 'a viewer gets no New Folder').toHaveCount(0);
  await expandFolder(cy, 'Ben research');
  await expect(folderRow(cy, 'Ben research').getByRole('button', { name: 'Click to rename folder' }), 'a viewer cannot rename').toHaveCount(0);
  await expect(folderRow(cy, 'Ben research').getByRole('button', { name: 'Create subfolder' }), 'a viewer cannot nest').toHaveCount(0);
  await folderRow(cy, 'Ben research').click({ button: 'right' });
  await expect(cy.page.getByRole('menuitem', { name: 'Trash Folder', exact: true }), 'a viewer cannot trash').toHaveCount(0);
  await cy.page.keyboard.press('Escape');
  // Only the owner trashes: Ben, an editor, is not offered it either.
  await folderRow(ben, 'Ben research').click({ button: 'right' });
  await expect(ben.page.getByRole('menuitem', { name: 'Trash Folder', exact: true }), 'an editor cannot trash').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await actors.requireDistinct(3);
  await actors.checkpoint('shared-vault-folder');
});

test('j06-folders: a folder change refused by the server reads as a sentence, never a coded error or a bare "Failed" @p:note-4', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  await grantVault(ada, benPrincipal, 'editor');
  await newFolder(ada, 'Archive');
  await expect(folderRow(ada, 'Archive')).toBeVisible();

  const ben = await actors.open(benPrincipal);
  await ben.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await ben.page.getByRole('menuitem', { name: 'Home editor', exact: true }).click();
  await expect(folderRow(ben, 'Archive')).toBeVisible();

  // Ben's sidebar falls behind: his workspace refreshes are held while Ada changes the vault.
  const held: { continue: () => Promise<void> }[] = [];
  await ben.page.route(/\/api\/workspace\?/, (route) => { held.push(route); });
  try {
    await newFolder(ada, 'Roadmap');
    await expect(folderRow(ada, 'Roadmap')).toBeVisible();
    await folderRow(ada, 'Archive').click({ button: 'right' });
    await ada.page.getByRole('menuitem', { name: 'Trash Folder', exact: true }).click();
    await ada.page.getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(folderRow(ada, 'Archive')).toHaveCount(0);
    await expect.poll(() => held.length, { message: "Ben's channel asked for the change", timeout: PEER_SIDEBAR_MS }).toBeGreaterThan(0);

    // The same name Ada just took, unseen by Ben: the server refuses it in words.
    ben.expectHttp(409, '/api/folders');
    await newFolder(ben, 'roadmap');
    const refusal = ben.page.getByText(/already (has|exists)/i);
    await expect(refusal, 'the duplicate is refused with a sentence').toBeVisible();
    await expect(refusal).toHaveText(/\S+ \S+ \S+/);
    await expectNoCodedErrors(ben);
    await ben.page.getByPlaceholder('Folder name...').press('Escape');

    // A subfolder inside the folder Ada just trashed: the parent is gone, and Ben is told so in words.
    ben.expectHttp(404, '/api/folders');
    await folderRow(ben, 'Archive').hover();
    await folderRow(ben, 'Archive').getByRole('button', { name: 'Create subfolder' }).click();
    const sub = ben.page.getByPlaceholder('Subfolder name...');
    await sub.fill('Q3');
    await sub.press('Enter');
    const gone = ben.page.getByText(/no longer/i);
    await expect(gone, 'a vanished parent is explained').toBeVisible();
    await expect(gone).toHaveText(/\S+ \S+ \S+/);
    await expectNoCodedErrors(ben);
    await sub.press('Escape');
  } finally {
    await ben.page.unroute(/\/api\/workspace\?/);
    for (const route of held.splice(0)) await route.continue().catch(() => undefined);
  }
  // Once Ben catches up, his sidebar matches Ada's.
  await expect(folderRow(ben, 'Roadmap')).toBeVisible({ timeout: PEER_SIDEBAR_MS * 2 });
  await expect(folderRow(ben, 'Archive')).toHaveCount(0, { timeout: PEER_SIDEBAR_MS * 2 });
  await actors.requireDistinct(2);
});
