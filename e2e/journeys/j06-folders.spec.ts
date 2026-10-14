// j06-folders (T2.2; A§6, A§9 folders, A§11): folders from the web UI. A naive person starts from an empty
// workspace and uses only moss's own sidebar: Folder actions → New Folder, a subfolder from the hover button, a note
// dragged into the folder, a rename by clicking the open folder's name, and Trash Folder from its context menu,
// which sends the whole subtree to Trash as one batch. A collaborator with a note open inside that subtree sees it
// go terminal in place. An editor on a shared vault creates a folder that the owner sees live but is offered no move
// (a move is a sharing decision, the owner's); a viewer is offered none. A refused folder change always reads as a sentence: never "Unknown parent folder", never a bare "Failed".
// Every control asks the folder or item it acts on, not the vault root (T3.B17): a vault viewer who owns one folder and
// edits another creates and moves there, an owner gets no "+ Note" in a folder shared to her at view, and nothing
// moves across vaults. A nested folder moves whole through a reload, and a refused move is undone and says why.
//
// Vault grants are declared setup through the members API; sharing is not this journey's promise.
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, EDITOR_PANE_ATTR, INPUT_REFUSAL_ATTR, ROLE_ATTR, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR,
  TERMINAL_REASON_ATTR, NAMES,
} from '../lib/contract.ts';
import { grant } from '../lib/grants.ts';
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

const noteRow = (actor: Actor, docId: string) => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`);

/** Opens a folder (clicking it also makes it moss's active folder, where "+ Note" creates). */
async function expandFolder(actor: Actor, name: string): Promise<void> {
  const row = ui.folderRow(actor, name);
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
  await grant(owner, { folderId: vault.id }, member, role);
  return vault.id;
}

test('j06-folders: from an empty workspace, create, nest, fill, rename and trash a folder; a peer inside the subtree goes terminal in place @p:note-4@2 @p:note-5 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  await expect(ada.page.locator(`[${SIDEBAR_ROW_ATTR}]`), 'Ada starts from an empty workspace').toHaveCount(0);

  await newFolder(ada, 'Plans');
  await expect(ui.folderRow(ada, 'Plans'), 'the new folder shows in the empty workspace').toBeVisible();
  await expectNoCodedErrors(ada);

  // A note made at the root, then dragged into the folder.
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Moved into a folder', { enter: true });
  await ui.typeBody(ada, docId, NOTE_TEXT);
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await noteRow(ada, docId).locator('[draggable="true"]').dragTo(ui.folderRow(ada, 'Plans'));
  await expect(ui.folderRow(ada, 'Plans'), 'the folder counts the moved note').toHaveAccessibleName(/^Plans folder, 1 note,/);

  // Open the folder, rename it by clicking its name, and nest a subfolder from the hover button.
  await expandFolder(ada, 'Plans');
  await ui.folderRow(ada, 'Plans').getByRole('button', { name: 'Click to rename folder' }).click();
  const rename = ui.folderRow(ada, 'Plans').getByRole('textbox');
  await expect(rename, 'the folder name becomes an input').toBeFocused();
  await rename.fill('Projects');
  await rename.press('Enter');
  await expect(ui.folderRow(ada, 'Projects'), 'the folder is renamed').toBeVisible();
  await expect(ui.folderRow(ada, 'Plans')).toHaveCount(0);
  await expandFolder(ada, 'Projects');
  const inside = ada.page.getByRole('region', { name: 'Notes in Projects folder' });
  await expect(inside.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`), 'the note is inside the renamed folder').toBeVisible();
  await ui.folderRow(ada, 'Projects').hover();
  await ui.folderRow(ada, 'Projects').getByRole('button', { name: 'Create subfolder' }).click();
  const sub = ada.page.getByPlaceholder('Subfolder name...');
  await expect(sub).toBeFocused();
  await sub.fill('Drafts');
  await sub.press('Enter');
  await expect(ui.folderRow(ada, 'Drafts'), 'the subfolder nests inside Projects').toBeVisible();
  await expectNoCodedErrors(ada);

  // The rename and the move survive a reload: they are server state, not local atoms.
  ada.expectReconnects(1, docId);
  await ada.page.reload();
  await ui.waitLive(ada, docId);
  await ada.declareRemount(docId);
  await expect(ui.folderRow(ada, 'Projects')).toBeVisible();
  await expect(ui.folderRow(ada, 'Projects'), 'the moved note is still counted after a reload').toHaveAccessibleName(/^Projects folder, 1 note,/);
  await actors.checkpoint('folders-made');

  // Ben, an editor on Ada's vault, has the note open when Ada trashes the folder.
  await grantVault(ada, benPrincipal, 'editor');
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await ui.waitLive(ben, docId);
  await ben.observeEditor(docId);
  await actors.requireDistinct(2);
  await expect(ui.folderRow(ben, 'Projects'), "Ben's sidebar shows Ada's folder").toBeVisible();
  expect(await ui.fieldText(ben, docId, 'body')).toBe(NOTE_TEXT);

  await ui.folderRow(ada, 'Projects').click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Trash Folder', exact: true }).click();
  await ada.page.locator('[data-remote-web-surface-blocking-dialog]').getByRole('button', { name: 'Trash', exact: true }).click();

  for (const actor of [ada, ben]) {
    await expect(ui.pane(actor, docId), `${actor.label}: the open note goes terminal`).toHaveAttribute(TERMINAL_REASON_ATTR, 'deleted', { timeout: PEER_SIDEBAR_MS });
    await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
    await expect(ui.body(actor, docId)).toHaveAttribute('contenteditable', 'false');
    await expect(ui.body(actor, docId), `${actor.label}: the content stays visible in place`).toHaveText(NOTE_TEXT);
    await expect(actor.page.locator(`[${CONNECTION_BANNER_ATTR}="deleted"]`), `${actor.label}: the notice says why`).toBeVisible();
    await expect(ui.folderRow(actor, 'Projects'), `${actor.label}: the folder leaves the sidebar`).toHaveCount(0, { timeout: PEER_SIDEBAR_MS });
    await expect(ui.folderRow(actor, 'Drafts'), `${actor.label}: the subfolder goes with it`).toHaveCount(0, { timeout: PEER_SIDEBAR_MS });
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

test('j06-folders: an editor on a shared vault creates a folder the owner sees live; a viewer is offered none @p:note-4@2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const cyPrincipal = await actors.principal('cy');
  await grantVault(ada, benPrincipal, 'editor');
  await grantVault(ada, cyPrincipal, 'viewer');

  const ben = await actors.open(benPrincipal);
  await ben.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await ben.page.getByRole('menuitem', { name: 'Home editor', exact: true }).click();
  await newFolder(ben, 'Ben research');
  await expect(ui.folderRow(ben, 'Ben research'), "Ben's folder shows in Ada's vault").toBeVisible();
  await expect(ui.folderRow(ada, 'Ben research'), 'Ada sees it without a reload').toBeVisible({ timeout: PEER_SIDEBAR_MS });
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
  await expect(ui.folderRow(cy, 'Ben research')).toBeVisible();
  await expect(cy.page.getByRole('button', { name: 'Folder actions', exact: true }), 'a viewer gets no New Folder').toHaveCount(0);
  await expandFolder(cy, 'Ben research');
  await expect(ui.folderRow(cy, 'Ben research').getByRole('button', { name: 'Click to rename folder' }), 'a viewer cannot rename').toHaveCount(0);
  await expect(ui.folderRow(cy, 'Ben research').getByRole('button', { name: 'Create subfolder' }), 'a viewer cannot nest').toHaveCount(0);
  await ui.folderRow(cy, 'Ben research').click({ button: 'right' });
  await expect(cy.page.getByRole('menuitem', { name: 'Trash Folder', exact: true }), 'a viewer cannot trash').toHaveCount(0);
  await cy.page.keyboard.press('Escape');
  // Only the owner trashes: Ben, an editor, is not offered it either.
  await ui.folderRow(ben, 'Ben research').click({ button: 'right' });
  await expect(ben.page.getByRole('menuitem', { name: 'Trash Folder', exact: true }), 'an editor cannot trash').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  // A move changes who can open what, so only the owner is offered one: Ben's rows don't drag, Ada's do.
  await expect(ui.folderRow(ada, 'Ben research'), 'the owner can drag a folder').toHaveAttribute('draggable', 'true');
  await expect(noteRow(ada, docId).locator('[draggable="true"]'), 'the owner can drag a note').toHaveCount(1);
  await expect(ui.folderRow(ben, 'Ben research'), 'an editor cannot move a folder').toHaveAttribute('draggable', 'false');
  await expect(noteRow(ben, docId).locator('[draggable="true"]'), 'an editor cannot move a note').toHaveCount(0);
  await actors.requireDistinct(3);
  await actors.checkpoint('shared-vault-folder');
});

test("j06-folders: a folder shared into an editor's own Home offers no move of its notes @p:note-4", async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const origin = new URL(ada.page.url()).origin;
  const post = (actor: Actor, path: string, data: object) =>
    actor.context.request.post(`${origin}${path}`, { headers: { origin, 'content-type': 'application/json' }, data, timeout: 15_000 });
  // Declared setup: Ada shares one folder (not her vault) with Ben as an editor, with a note inside it.
  const { vault } = (await (await ada.context.request.get(`${origin}/api/workspace`)).json()) as { vault: { id: string } };
  const made = await post(ada, '/api/folders', { parentId: vault.id, name: 'Shared plans' });
  expect(made.status(), 'declared setup: the folder').toBe(201);
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  await grant(ada, { folderId }, benPrincipal, 'editor');
  const shared = await post(ada, '/api/docs', { folderId, title: 'Plan A' });
  expect(shared.status(), "declared setup: Ada's note").toBe(201);
  const sharedId = ((await shared.json()) as { doc: { id: string } }).doc.id;

  // The folder lands in Ben's own Home, where he owns the vault, but Ada's note in it is not his to move.
  const ben = await actors.open(benPrincipal);
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  const own = await post(ben, '/api/docs', { title: 'Ben own note' });
  expect(own.status(), "declared setup: Ben's note").toBe(201);
  const ownId = ((await own.json()) as { doc: { id: string } }).doc.id;
  await ben.page.reload();
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  await expect(noteRow(ben, ownId).locator('[draggable="true"]'), 'Ben can drag his own note').toHaveCount(1, { timeout: PEER_SIDEBAR_MS });
  await expandFolder(ben, 'Shared plans');
  await expect(noteRow(ben, sharedId), "Ada's note shows in the shared folder").toBeVisible();
  await expect(noteRow(ben, sharedId).locator('[draggable="true"]'), 'an editor cannot move a shared note').toHaveCount(0);
  await expect(ui.folderRow(ben, 'Shared plans'), 'nor the shared folder').toHaveAttribute('draggable', 'false');
  await actors.requireDistinct(2);
});

test('j06-folders: a folder change refused by the server reads as a sentence, never a coded error or a bare "Failed" @p:note-4@2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  await grantVault(ada, benPrincipal, 'editor');
  await newFolder(ada, 'Archive');
  await expect(ui.folderRow(ada, 'Archive')).toBeVisible();

  const ben = await actors.open(benPrincipal);
  await ben.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await ben.page.getByRole('menuitem', { name: 'Home editor', exact: true }).click();
  await expect(ui.folderRow(ben, 'Archive')).toBeVisible();

  // Ben's sidebar falls behind: his workspace refreshes are held while Ada changes the vault.
  const held: { continue: () => Promise<void> }[] = [];
  await ben.page.route(/\/api\/workspace\?/, (route) => { held.push(route); });
  try {
    await newFolder(ada, 'Roadmap');
    await expect(ui.folderRow(ada, 'Roadmap')).toBeVisible();
    await ui.folderRow(ada, 'Archive').click({ button: 'right' });
    await ada.page.getByRole('menuitem', { name: 'Trash Folder', exact: true }).click();
    await ada.page.locator('[data-remote-web-surface-blocking-dialog]').getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(ui.folderRow(ada, 'Archive')).toHaveCount(0);
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
    await ui.folderRow(ben, 'Archive').hover();
    await ui.folderRow(ben, 'Archive').getByRole('button', { name: 'Create subfolder' }).click();
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
  await expect(ui.folderRow(ben, 'Roadmap')).toBeVisible({ timeout: PEER_SIDEBAR_MS * 2 });
  await expect(ui.folderRow(ben, 'Archive')).toHaveCount(0, { timeout: PEER_SIDEBAR_MS * 2 });
  await actors.requireDistinct(2);
});

// T3.B17: "+ Note", Cmd/Ctrl+N and drags ask the folder or the item itself, as the server does, never the vault root.
type Listing = { vault: { id: string }; folders: { id: string; path: string }[]; docs: { id: string; folderPath: string }[] };

/** Declared setup through the API, as `actor`: folders and notes, and the actor's own Home listing. */
function setup(actor: Actor) {
  const origin = new URL(actor.page.url()).origin;
  const post = (path: string, data: object) =>
    actor.context.request.post(`${origin}${path}`, { headers: { origin, 'content-type': 'application/json' }, data, timeout: 15_000 });
  const listing = async () => (await (await actor.context.request.get(`${origin}/api/workspace`)).json()) as Listing;
  return {
    origin,
    listing,
    home: async () => (await listing()).vault.id,
    folder: async (name: string, parentId: string) => {
      const made = await post('/api/folders', { parentId, name });
      expect(made.status(), `declared setup: folder ${name}`).toBe(201);
      return ((await made.json()) as { folder: { id: string } }).folder.id;
    },
    note: async (title: string, folderId: string) => {
      const made = await post('/api/docs', { folderId, title });
      expect(made.status(), `declared setup: note ${title}`).toBe(201);
      return ((await made.json()) as { doc: { id: string } }).doc.id;
    },
  };
}

/** Every `method` request the page sends to a path matching `path`, from now on. */
function sent(actor: Actor, method: string, path: RegExp): string[] {
  const seen: string[] = [];
  actor.page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === method && path.test(pathname)) seen.push(pathname);
  });
  return seen;
}

const newNoteButton = (actor: Actor) => actor.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name });
const inFolder = (actor: Actor, name: string) => actor.page.getByRole('region', { name: `Notes in ${name} folder` });
const folderIn = (actor: Actor, parent: string, name: string) =>
  inFolder(actor, parent).getByRole('button', { name: new RegExp(`^${name} folder, `) });
const MOVES = /^\/api\/(docs|folders)\/[^/]+$/;
/**
 * Cmd/Ctrl+N as moss's window listener receives it. Chromium keeps Ctrl+N for itself (a reserved accelerator), so a
 * pressed key never reaches the page; the keydown is dispatched where focus is.
 */
const pressNewNote = (actor: Actor) => actor.page.evaluate(() => (document.activeElement ?? document.body).dispatchEvent(
  new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true })));

test('j06-folders: a vault viewer who owns one folder and edits another creates and moves there; nothing else drags, and a refused drop sends nothing @p:note-4@2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const benPrincipal = await actors.principal('ben');
  const api = setup(ada);
  const vaultId = await grantVault(ada, benPrincipal, 'viewer');
  const owned = await api.folder('Owned', vaultId);
  await api.folder('Sub', owned);
  const open = await api.folder('Open', vaultId);
  await api.folder('Closed', vaultId);
  await grant(ada, { folderId: owned }, benPrincipal, 'owner');
  await grant(ada, { folderId: open }, benPrincipal, 'editor');
  const ownedNote = await api.note('Owned plan', owned);
  const openNote = await api.note('Open plan', open);

  const ben = await actors.open(benPrincipal);
  await ben.page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await ben.page.getByRole('menuitem', { name: 'Home viewer', exact: true }).click();
  await expect(ui.folderRow(ben, 'Owned')).toBeVisible();
  const creates = sent(ben, 'POST', /^\/api\/docs$/);
  const moves = sent(ben, 'PATCH', MOVES);

  // "+ Note" follows the folder the note would land in: Ben edits Open, so it is offered there and lands there.
  await expandFolder(ben, 'Open');
  await expect(newNoteButton(ben), 'a vault viewer is offered "+ Note" in a folder they edit').toBeVisible();
  const made = await ui.createNote(ben);
  await expect(inFolder(ben, 'Open').locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${made}"]`), 'and the note lands in it').toBeVisible();
  // Cmd/Ctrl+N creates there too: the positive control for the refusal below.
  const shortcut = ben.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/docs' && r.request().method() === 'POST');
  await pressNewNote(ben);
  const second = ((await (await shortcut).json()) as { doc: { id: string } }).doc.id;
  await ui.waitLive(ben, second);
  await ben.declareRemount(second);
  expect(creates, 'both creates were sent').toHaveLength(2);
  expect((await api.listing()).docs.filter((d) => d.id === made || d.id === second).map((d) => d.folderPath), 'both in Open')
    .toEqual(['Notes/Open', 'Notes/Open']);

  // Closed is view-only to him: no "+ Note", and Cmd/Ctrl+N sends nothing.
  await expandFolder(ben, 'Closed');
  await expect(newNoteButton(ben), 'no "+ Note" in a folder he only views').toHaveCount(0);
  await pressNewNote(ben);
  await ben.page.waitForTimeout(1_000);
  expect(creates, 'Cmd/Ctrl+N sends no create there').toHaveLength(2);

  // Drags follow what he manages: the note and the subfolder in the folder he owns, never the editor-only ones.
  await expandFolder(ben, 'Owned');
  await expect(noteRow(ben, ownedNote).locator('[draggable="true"]'), 'a note he manages drags').toHaveCount(1);
  await expect(ui.folderRow(ben, 'Sub'), 'a folder he manages drags').toHaveAttribute('draggable', 'true');
  await expect(noteRow(ben, openNote).locator('[draggable="true"]'), 'an editor-only note does not').toHaveCount(0);
  await expect(ui.folderRow(ben, 'Open'), 'nor an editor-only folder').toHaveAttribute('draggable', 'false');
  await expect(ui.folderRow(ben, 'Closed'), 'nor a view-only one').toHaveAttribute('draggable', 'false');

  // A drop where he cannot add (a view-only folder, or the view-only vault root around it) sends nothing.
  await noteRow(ben, ownedNote).locator('[draggable="true"]').dragTo(ui.folderRow(ben, 'Closed'));
  await ui.folderRow(ben, 'Sub').dragTo(ui.folderRow(ben, 'Closed'));
  await ben.page.waitForTimeout(1_000);
  expect(moves, 'a refused drop sends no move').toEqual([]);

  // Into a folder he edits, both move, and the server agrees.
  await noteRow(ben, ownedNote).locator('[draggable="true"]').dragTo(ui.folderRow(ben, 'Open'));
  await expect.poll(async () => (await api.listing()).docs.find((d) => d.id === ownedNote)?.folderPath, { timeout: PEER_SIDEBAR_MS })
    .toBe('Notes/Open');
  await ui.folderRow(ben, 'Sub').dragTo(ui.folderRow(ben, 'Open'));
  await expect.poll(async () => (await api.listing()).folders.map((f) => f.path).sort(), { timeout: PEER_SIDEBAR_MS })
    .toEqual(['Notes/Closed', 'Notes/Open', 'Notes/Open/Sub', 'Notes/Owned']);
  expect(moves, 'one request per move').toHaveLength(2);
  await actors.requireDistinct(2);
});

test('j06-folders: in her own Home, a folder shared to Ada at view offers no "+ Note" and Cmd/Ctrl+N sends nothing; a folder she co-owns from another vault neither drags nor takes a drop @p:note-4@2', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  const ben = await openShell(actors, 'ben');
  const benApi = setup(ben);
  const benHome = await benApi.home();
  const shelf = await benApi.folder('Ben shelf', benHome);
  await benApi.note('Shelf note', shelf);
  const coowned = await benApi.folder('Ben coowned', benHome);
  const benNote = await benApi.note('Coowned note', coowned);
  await grant(ben, { folderId: shelf }, adaPrincipal, 'viewer');
  await grant(ben, { folderId: coowned }, adaPrincipal, 'owner');
  const adaApi = setup(ada);
  const own = await adaApi.note('Ada own note', await adaApi.home());

  await ada.page.reload();
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  await expect(ui.folderRow(ada, 'Ben shelf'), "Ben's folder shows in Ada's Home").toBeVisible({ timeout: PEER_SIDEBAR_MS });
  const creates = sent(ada, 'POST', /^\/api\/docs$/);
  const moves = sent(ada, 'PATCH', MOVES);

  // She owns her Home, but the shelf is view-only to her: no "+ Note" there, and Cmd/Ctrl+N sends nothing.
  await expect(newNoteButton(ada), 'the owner is offered "+ Note" at her Home').toBeVisible();
  await expandFolder(ada, 'Ben shelf');
  await expect(newNoteButton(ada), 'none in a folder she only views').toHaveCount(0);
  await pressNewNote(ada);
  await ada.page.waitForTimeout(1_000);
  expect(creates, 'Cmd/Ctrl+N sends no create there').toEqual([]);

  // Moves stay inside a vault: Ben's folder and its note neither drag nor take her note, though she co-owns them.
  await expandFolder(ada, 'Ben coowned');
  await expect(noteRow(ada, benNote), "Ben's note shows").toBeVisible();
  await expect(noteRow(ada, own).locator('[draggable="true"]'), 'her own note drags (the positive control)').toHaveCount(1);
  await expect(noteRow(ada, benNote).locator('[draggable="true"]'), 'a note from another vault does not').toHaveCount(0);
  await expect(ui.folderRow(ada, 'Ben coowned'), 'nor a folder from another vault').toHaveAttribute('draggable', 'false');
  await noteRow(ada, own).locator('[draggable="true"]').dragTo(ui.folderRow(ada, 'Ben coowned'));
  await ada.page.waitForTimeout(1_000);
  expect(moves, 'a drop across vaults sends no move').toEqual([]);
  await actors.requireDistinct(2);
});

test('j06-folders: a nested folder holding a note moves into another folder and stays through a reload; a refused move says why and puts everything back @p:note-4@2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  actors.solo('one owner reorganizes her own folders; her other window is declared setup');
  const api = setup(ada);
  const home = await api.home();
  const plans = await api.folder('Plans', home);
  const deep = await api.note('Deep note', await api.folder('Drafts', plans));
  await api.folder('Archive', home);
  const attic = await api.folder('Attic', home);
  await ada.page.reload();
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  const paths = async () => {
    const listing = await api.listing();
    return { folders: listing.folders.map((f) => f.path).sort(), note: listing.docs.find((d) => d.id === deep)?.folderPath };
  };
  const nested = { folders: ['Notes/Archive', 'Notes/Archive/Plans', 'Notes/Archive/Plans/Drafts', 'Notes/Attic'], note: 'Notes/Archive/Plans/Drafts' };
  const deepRow = () => inFolder(ada, 'Drafts').locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${deep}"]`);
  /** The sidebar shows Plans inside Archive, Drafts inside Plans and the note inside Drafts. */
  const expectNestedInSidebar = async (when: string) => {
    await expandFolder(ada, 'Archive');
    await expect(folderIn(ada, 'Archive', 'Plans'), `${when}: Plans is inside Archive`).toBeVisible();
    await expandFolder(ada, 'Plans');
    await expect(folderIn(ada, 'Plans', 'Drafts'), `${when}: Drafts is inside Plans`).toBeVisible();
    await expandFolder(ada, 'Drafts');
    await expect(deepRow(), `${when}: the note is inside Drafts`).toBeVisible();
  };

  await ui.folderRow(ada, 'Plans').dragTo(ui.folderRow(ada, 'Archive'));
  await expect.poll(paths, { message: 'the subtree moves whole', timeout: PEER_SIDEBAR_MS }).toEqual(nested);
  await expectNestedInSidebar('after the move');
  await ada.page.reload();
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  expect(await paths(), 'the server still has it after a reload').toEqual(nested);
  await expectNestedInSidebar('after a reload');

  // Her other window trashes Attic while this sidebar is behind, so the server refuses moving Plans there.
  const held: { continue: () => Promise<void> }[] = [];
  await ada.page.route(/\/api\/workspace\?/, (route) => { held.push(route); });
  try {
    expect((await ada.context.request.delete(`${api.origin}/api/folders/${attic}`, { headers: { origin: api.origin } })).status(),
      'declared setup: Attic goes to Trash').toBe(200);
    await expect.poll(() => held.length, { message: 'her sidebar asked for the change', timeout: PEER_SIDEBAR_MS }).toBeGreaterThan(0);
    await expect(ui.folderRow(ada, 'Attic'), 'her sidebar still shows Attic').toBeVisible();
    ada.expectHttp(404, `/api/folders/${plans}`);
    await folderIn(ada, 'Archive', 'Plans').dragTo(ui.folderRow(ada, 'Attic'));
    const refusal = ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`).filter({ hasText: /no longer available/ });
    await expect(refusal, 'the refusal says why, in the server’s words').toBeVisible();
    await expect(refusal).toHaveText(/\S+ \S+ \S+/);
    await expectNoCodedErrors(ada);
    await expect(folderIn(ada, 'Archive', 'Plans'), 'Plans is back inside Archive').toBeVisible();
    await expect(deepRow(), 'and its note inside Drafts').toBeVisible();
  } finally {
    await ada.page.unroute(/\/api\/workspace\?/);
    for (const route of held.splice(0)) await route.continue().catch(() => undefined);
  }
  await expect(ui.folderRow(ada, 'Attic'), 'once caught up, Attic is gone').toHaveCount(0, { timeout: PEER_SIDEBAR_MS * 2 });
  expect(await paths(), 'and nothing moved').toEqual({ ...nested, folders: nested.folders.filter((p) => p !== 'Notes/Attic') });
  await expectNestedInSidebar('after the refusal');
});
