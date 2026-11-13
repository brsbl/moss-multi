// Workspace and access discovery scale with the caller's own items, never with other tenants' (T3.B5): discovery reads
// only the folders a principal owns or is granted and their chains, an id-filtered listing reads only those notes, a
// folder link's listing reads its subtree and notes in one statement, the invite reaper looks only at what a write
// touched, and a move compares reach for all its notes in a fixed number of round trips.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { countingRows, migratedD1, type TestD1 } from '../test/d1.ts';
import {
  BASE, insertAgent, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, unmeteredPrincipals, type AuthTestEnv, type TestUser,
} from '../test/principals.ts';
import { accessibleDocs, accessibleFolders, folderChain, resolveFolderAccess } from './access.ts';
import { handleApi } from './router.ts';
import { workspace } from './workspace.ts';

interface Recheck { principalIds?: string[]; tokens?: string[]; everyone?: boolean }
const rechecks: { docId: string; input: Recheck }[] = [];

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    trash: async () => undefined,
    settle: async () => ({ deleted: true }),
    recheck: async (input: Recheck) => {
      rechecks.push({ docId: id.name, input });
      return { closed: 0 };
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;
let zed: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: unmeteredPrincipals as never };
  ada = await signedUpUser(env, 'scale-ada', 'Ada');
  ben = await signedUpUser(env, 'scale-ben', 'Ben');
  cy = await signedUpUser(env, 'scale-cy', 'Cy');
  zed = await signedUpUser(env, 'scale-zed', 'Zed');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  rechecks.length = 0;
});

const user = (u: TestUser): Principal => ({ type: 'user', id: u.id, name: u.name, email: u.email, sessionId: 's', credential: 'cookie' });
const agentOf = (owner: TestUser, id: string): Principal => ({ type: 'agent', id, name: 'Scribe', ownerUserId: owner.id });

const call = (who: TestUser, method: string, path: string, body?: unknown, DB: D1Database = d1.db) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, 'content-type': 'application/json', cookie: who.cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { ...env, DB });

/** Statements in batches of at most 200, so large fixtures stay quick. */
async function inBatches(statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += 200) await d1.db.batch(statements.slice(i, i + 200));
}

/** One folder under each of `parentIds`, owned by `owner`. */
async function folderBatch(owner: TestUser, parentIds: string[]): Promise<string[]> {
  const ids = parentIds.map(() => crypto.randomUUID());
  await inBatches(ids.map((id, i) => d1.db
    .prepare('INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner.id, owner.id, `f-${id.slice(0, 8)}`, 'folder', parentIds[i], Date.now())));
  return ids;
}

/** One note in each of `folderIds`, owned by `owner`; trashed with `deleted`. */
async function docBatch(owner: TestUser, folderIds: string[], deleted = false): Promise<string[]> {
  const ids = folderIds.map(() => crypto.randomUUID());
  const now = Date.now();
  await inBatches(ids.map((id, i) => d1.db
    .prepare('INSERT INTO docs (id, owner_user_id, created_by, folder_id, title, filename, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner.id, owner.id, folderIds[i], '', `${id}.md`, now, now, deleted ? now : null)));
  return ids;
}

/** `count` folders in a tree under `rootId`: ten at the top, the rest spread beneath them. */
async function tenantTree(owner: TestUser, rootId: string, count: number): Promise<string[]> {
  const top = await folderBatch(owner, Array(10).fill(rootId));
  const below = await folderBatch(owner, Array.from({ length: count - 10 }, (_, i) => top[i % 10]));
  return [...top, ...below];
}

describe('discovery reads only the caller’s folders (B013, B158)', () => {
  it('materializes the same rows however many folders other tenants have', async () => {
    const shared = await insertFolder(d1.db, ada, ada.homeId);
    const child = await insertFolder(d1.db, ada, shared);
    await insertDoc(d1.db, ada, { folderId: child });
    await insertGrant(d1.db, { folderId: shared }, ben, 'editor');
    const own = await insertFolder(d1.db, ben, ben.homeId);
    const bens = await insertAgent(d1.db, ben);
    const measure = async (principal: Principal) => {
      const counted = countingRows(d1.db);
      const db = createDb(counted.db);
      const folders = await accessibleFolders(db, principal);
      const docs = await accessibleDocs(db, principal, folders);
      return { rows: counted.rows(), folders: folders.map((row) => `${row.id}:${row.role}`).sort(), docs: docs.map((row) => row.id).sort() };
    };
    const before = [await measure(user(ben)), await measure(agentOf(ben, bens.id))];
    expect(before[0].folders).toEqual(expect.arrayContaining([`${shared}:editor`, `${child}:editor`, `${own}:owner`, `${ben.homeId}:owner`]));

    // 2,000 folders Ben cannot see: another tenant's tree, and more of Ada's vault around the shared folder.
    await tenantTree(zed, zed.homeId, 1_500);
    await tenantTree(ada, ada.homeId, 500);
    const after = [await measure(user(ben)), await measure(agentOf(ben, bens.id))];
    expect(after.map((m) => m.folders)).toEqual(before.map((m) => m.folders));
    expect(after.map((m) => m.docs)).toEqual(before.map((m) => m.docs));
    expect(after.map((m) => m.rows), 'rows discovery reads do not grow with other tenants’ folders').toEqual(before.map((m) => m.rows));
  }, 120_000);

  it('gives each folder the resolver’s role while its chain is live and ends at a vault, for every source and shape', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    // Direct, inherited and nested: Ben edits a and below; Cy views b and below.
    const a = await insertFolder(d1.db, ada, vault);
    const b = await insertFolder(d1.db, ada, a);
    const c = await insertFolder(d1.db, ada, b);
    await insertGrant(d1.db, { folderId: a }, ben, 'editor');
    await insertGrant(d1.db, { folderId: b }, cy, 'viewer');
    const bens = await insertAgent(d1.db, ben);
    await insertGrant(d1.db, { folderId: c }, { id: bens.id, type: 'agent' }, 'editor');
    // A deleted ancestor hides a granted folder.
    const x = await insertFolder(d1.db, ada, vault);
    const y = await insertFolder(d1.db, ada, x);
    await insertGrant(d1.db, { folderId: y }, ben, 'viewer');
    await d1.db.prepare('UPDATE folders SET deleted_at = ? WHERE id = ?').bind(Date.now(), x).run();
    // A cycle never reaches a vault.
    const p = await insertFolder(d1.db, ada, vault);
    const q = await insertFolder(d1.db, ada, p);
    await d1.db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').bind(q, p).run();
    await insertGrant(d1.db, { folderId: p }, ben, 'editor');
    // Twelve levels: a grant reaches ten below it, and a chain longer than the bound never reaches its vault.
    const levels = [await insertFolder(d1.db, ada, vault)];
    for (let i = 1; i < 12; i += 1) levels.push(await insertFolder(d1.db, ada, levels[i - 1]));
    await insertGrant(d1.db, { folderId: levels[0] }, ben, 'commenter');
    await insertGrant(d1.db, { folderId: levels[10] }, cy, 'viewer');
    const ids = [vault, a, b, c, x, y, p, q, ...levels];

    const db = createDb(d1.db);
    const principals: Principal[] = [user(ada), user(ben), user(cy), agentOf(ben, bens.id),
      { type: 'anonymous', id: 'anonymous', name: 'Anonymous', shareToken: 'forged' }];
    for (const principal of principals) {
      const found = new Map((await accessibleFolders(db, principal)).map((row) => [row.id, row]));
      for (const id of ids) {
        const chain = await folderChain(db, id);
        const rows = await Promise.all(chain.map((link) => d1.db.prepare('SELECT kind, deleted_at FROM folders WHERE id = ?').bind(link)
          .first<{ kind: string; deleted_at: number | null }>()));
        const live = rows.every((row) => row?.deleted_at === null) && rows.at(-1)?.kind === 'vault';
        const expected = live ? (await resolveFolderAccess(db, principal, id))?.role ?? null : null;
        const label = `${principal.type} ${principal.id} on folder ${ids.indexOf(id)}`;
        expect(found.get(id)?.role ?? null, label).toBe(expected);
        if (expected) expect(found.get(id)?.vaultId, label).toBe(chain.at(-1));
      }
    }
    // The sources reach as the resolver says: inherited, nested, the agent's own grant, and the depth bound.
    const benFound = new Map((await accessibleFolders(db, user(ben))).map((row) => [row.id, row.role]));
    expect([a, b, c, levels[9]].map((id) => benFound.get(id))).toEqual(['editor', 'editor', 'editor', 'commenter']);
    expect([y, p, q, levels[10], levels[11]].map((id) => benFound.get(id) ?? null)).toEqual([null, null, null, null, null]);
    const agentFound = new Map((await accessibleFolders(db, agentOf(ben, bens.id))).map((row) => [row.id, row.role]));
    expect([a, c].map((id) => agentFound.get(id))).toEqual(['editor', 'editor']);
  }, 60_000);
});

interface Listing {
  vault: { id: string };
  vaults: { id: string; role: string; owned: boolean }[];
  docs: { id: string; folderPath: string; role: string; trashedAt?: number }[];
  folders: { id: string; path: string; role: string; noteCount: number }[];
}

describe('an id-filtered listing reads only those notes (B152)', () => {
  it('reads the same rows for ids= however large the workspace, with the full listing’s counts, vaults and trash', async () => {
    const cal = await signedUpUser(env, 'scale-cal', 'Cal');
    const folders = await folderBatch(cal, Array(3).fill(cal.homeId));
    const [target] = await docBatch(cal, folders);
    const [trashed] = await docBatch(cal, [folders[1]], true);
    const sharedVault = await insertFolder(d1.db, ada, null);
    await insertDoc(d1.db, ada, { folderId: sharedVault });
    await insertGrant(d1.db, { folderId: sharedVault }, cal, 'viewer');
    const missing = crypto.randomUUID();
    const listAs = async (query: string, DB: D1Database = d1.db) => {
      const response = await workspace(new Request(`${BASE}/api/workspace${query}`, { headers: { cookie: cal.cookie } }), { ...env, DB });
      expect(response.status).toBe(200);
      return (await response.json()) as Listing;
    };
    const ids = `?ids=${target}&ids=${trashed}&ids=${missing}`;
    const measure = async () => {
      const counted = countingRows(d1.db);
      const listing = await listAs(ids, counted.db);
      return { rows: counted.rows(), listing };
    };
    const small = await measure();

    // 400 more notes and 100 more trashed ones in the same folders.
    await docBatch(cal, Array.from({ length: 400 }, (_, i) => folders[i % 3]));
    await docBatch(cal, Array.from({ length: 100 }, (_, i) => folders[i % 3]), true);
    const large = await measure();
    const full = await listAs('');
    expect(large.listing.docs.map((row) => row.id).sort()).toEqual([target, trashed].sort());
    expect(large.listing.docs.find((row) => row.id === trashed)?.trashedAt).toEqual(expect.any(Number));
    expect(large.listing.docs, 'the rows match the full listing’s').toEqual(full.docs.filter((row) => [target, trashed].includes(row.id)));
    expect(large.listing.folders, 'note counts and folders match the full listing').toEqual(full.folders);
    expect(folders.map((id) => large.listing.folders.find((row) => row.id === id)?.noteCount)).toEqual([135, 134, 134]);
    expect(large.listing.vaults).toEqual(full.vaults);
    expect(large.listing.vault).toEqual(full.vault);
    expect(large.rows, 'rows read do not grow with the notes not asked for').toBe(small.rows);
  }, 120_000);
});

describe('a folder link’s listing is one read of its subtree and notes (B154)', () => {
  it('never lists a note made in a folder moved out of the linked root mid-listing, for anonymous and signed-in readers', async () => {
    const dee = await signedUpUser(env, 'scale-dee', 'Dee');
    const root = await insertFolder(d1.db, ada, ada.homeId);
    const token = await insertLink(d1.db, { folderId: root }, 'viewer');
    // The control: a large subtree that stays put is listed whole.
    const steady = await tenantTree(ada, root, 60);
    const steadyNotes = await docBatch(ada, [...steady, ...steady]);
    for (const reader of [null, dee]) {
      const moving = await insertFolder(d1.db, ada, root);
      const before = await insertDoc(d1.db, ada, { folderId: moving });
      let late: string | null = null;
      const hooked = countingRows(d1.db, async (rows) => {
        if (late !== null || !JSON.stringify(rows).includes(moving)) return;
        late = '';
        await d1.db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').bind(ada.homeId, moving).run();
        late = await insertDoc(d1.db, ada, { folderId: moving });
      });
      const headers: Record<string, string> = reader ? { cookie: reader.cookie } : {};
      const response = await workspace(new Request(`${BASE}/api/workspace?vault=${root}&share=${token}`, { headers }), { ...env, DB: hooked.db });
      expect(response.status).toBe(200);
      const listing = (await response.json()) as Listing;
      const label = reader ? 'signed-in' : 'anonymous';
      expect(late, `${label}: the move landed mid-listing`).toEqual(expect.any(String));
      expect(listing.docs.map((row) => row.id), `${label}: the note made after the move is not listed`).not.toContain(late);
      expect(listing.vault.id).toBe(root);
      const listed = new Set(listing.docs.map((row) => row.id));
      expect(steadyNotes.filter((id) => !listed.has(id)), `${label}: the steady subtree is listed whole`).toEqual([]);
      const folderIds = new Set(listing.folders.map((row) => row.id));
      expect(steady.filter((id) => !folderIds.has(id))).toEqual([]);
      expect(listing.folders.filter((row) => steady.includes(row.id)).every((row) => row.noteCount === 2)).toBe(true);
      expect(listed.has(before) === folderIds.has(moving), `${label}: a listed folder brings its notes`).toBe(true);
    }
  }, 120_000);
});

const inviteRow = (token: string) => d1.db.prepare('SELECT revoked_at FROM invites WHERE token = ?').bind(token).first<{ revoked_at: number | null }>();

/** An open invite to an unknown email on `target`, sent by `inviter`. */
async function invite(target: { type: 'doc' | 'folder'; id: string }, inviter: string): Promise<string> {
  const token = crypto.randomUUID().replaceAll('-', '');
  await d1.db.prepare(`INSERT INTO invites (token, email, target_type, target_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, 'viewer', ?, ?)`)
    .bind(token, `mm-scale-${token.slice(0, 8)}@example.invalid`, target.type, target.id, inviter, Date.now()).run();
  return token;
}

describe('the invite reaper looks only at what a write touched (B153)', () => {
  it('kills the touched scope’s dead invites in the write’s batch, leaves other tenants’ alone, and a regrant revives none', async () => {
    // Other tenants' open invites that are already dead (Ben manages nothing there): no write here touches them or
    // Ben, so none of these writes may evaluate or revoke them.
    const unrelatedFolders = await tenantTree(zed, zed.homeId, 40);
    const unrelatedDocs = await docBatch(zed, unrelatedFolders);
    const unrelated = [
      ...await Promise.all(unrelatedFolders.map((id) => invite({ type: 'folder', id }, ben.id))),
      ...await Promise.all(unrelatedDocs.map((id) => invite({ type: 'doc', id }, ben.id))),
    ];
    const untouched = async (label: string) => {
      const open = await d1.db.prepare(`SELECT count(*) AS n FROM invites WHERE revoked_at IS NULL AND token IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(unrelated)).first<{ n: number }>();
      expect(open?.n, `${label}: other tenants’ invites are untouched`).toBe(unrelated.length);
    };

    // A folder move: Cy co-owns `from`, so her invites inside the moved subtree die with her manage, descendants too.
    const vault = await insertFolder(d1.db, ada, null);
    const from = await insertFolder(d1.db, ada, vault);
    const into = await insertFolder(d1.db, ada, vault);
    await insertGrant(d1.db, { folderId: from }, cy, 'owner');
    const moved = await insertFolder(d1.db, ada, from);
    const inner = await insertFolder(d1.db, ada, moved);
    const innerDoc = await insertDoc(d1.db, ada, { folderId: inner });
    const stays = await insertDoc(d1.db, ada, { folderId: from });
    const inMove = [await invite({ type: 'folder', id: moved }, cy.id), await invite({ type: 'folder', id: inner }, cy.id),
      await invite({ type: 'doc', id: innerDoc }, cy.id)];
    const kept = await invite({ type: 'doc', id: stays }, cy.id);
    expect((await call(ada, 'PATCH', `/api/folders/${moved}`, { parentId: into })).status).toBe(200);
    for (const token of inMove) expect((await inviteRow(token))?.revoked_at, 'a moved invite died').toEqual(expect.any(Number));
    expect((await inviteRow(kept))?.revoked_at, 'Cy still manages what stayed').toBeNull();
    await untouched('folder move');

    // A note move.
    const note = await insertDoc(d1.db, ada, { folderId: from });
    const noteInvite = await invite({ type: 'doc', id: note }, cy.id);
    expect((await call(ada, 'PATCH', `/api/docs/${note}`, { folderId: into })).status).toBe(200);
    expect((await inviteRow(noteInvite))?.revoked_at).toEqual(expect.any(Number));
    await untouched('note move');

    // A folder trash and a note trash: the subtree's invites die with it.
    const trashed = await insertFolder(d1.db, ada, vault);
    const trashedDoc = await insertDoc(d1.db, ada, { folderId: trashed });
    const inTrash = [await invite({ type: 'folder', id: trashed }, ada.id), await invite({ type: 'doc', id: trashedDoc }, ada.id)];
    expect((await call(ada, 'DELETE', `/api/folders/${trashed}`)).status).toBe(200);
    for (const token of inTrash) expect((await inviteRow(token))?.revoked_at).toEqual(expect.any(Number));
    const lone = await insertDoc(d1.db, ada, { folderId: into });
    const loneInvite = await invite({ type: 'doc', id: lone }, ada.id);
    expect((await call(ada, 'DELETE', `/api/docs/${lone}`)).status).toBe(200);
    expect((await inviteRow(loneInvite))?.revoked_at).toEqual(expect.any(Number));
    await untouched('trash');

    // A grant revocation: Cy's invites under `from` die, and a regrant brings none back.
    const after = await insertDoc(d1.db, ada, { folderId: from });
    const revoked = await invite({ type: 'doc', id: after }, cy.id);
    expect((await call(ada, 'DELETE', `/api/folders/${from}/members`, { principalId: cy.id })).status).toBe(200);
    expect((await inviteRow(revoked))?.revoked_at).toEqual(expect.any(Number));
    expect((await inviteRow(kept))?.revoked_at).toEqual(expect.any(Number));
    await untouched('grant revocation');
    await insertGrant(d1.db, { folderId: from }, cy, 'owner');
    expect((await call(ada, 'PATCH', `/api/folders/${moved}`, { parentId: from })).status).toBe(200);
    for (const token of [...inMove, kept, revoked, noteInvite]) expect((await inviteRow(token))?.revoked_at, 'a regrant revives nothing').not.toBeNull();
  }, 120_000);
});

describe('a move compares reach in a fixed number of round trips (B151)', () => {
  /** Ada's vault > from (Ben edits, link L1) > top > mid > leaf, with `notes` notes spread over the three. */
  async function subtree(notes: number) {
    const vault = await insertFolder(d1.db, ada, null);
    const from = await insertFolder(d1.db, ada, vault);
    const into = await insertFolder(d1.db, ada, vault);
    const top = await insertFolder(d1.db, ada, from);
    const mid = await insertFolder(d1.db, ada, top);
    const leaf = await insertFolder(d1.db, ada, mid);
    const docs = await docBatch(ada, Array.from({ length: notes }, (_, i) => [top, mid, leaf][i % 3]));
    return { vault, from, into, top, docs };
  }

  it('reads reach for 1,000 notes in as many round trips as for 10, and kicks exactly who and what lost access', async () => {
    const bens = await insertAgent(d1.db, ben);
    const dee = await signedUpUser(env, 'scale-dee-reach', 'Dee');
    const moveCounted = async (notes: number) => {
      const tree = await subtree(notes);
      await insertGrant(d1.db, { folderId: tree.from }, ben, 'editor');
      await insertGrant(d1.db, { folderId: tree.into }, ben, 'viewer');
      await insertGrant(d1.db, { folderId: tree.into }, cy, 'viewer');
      await insertGrant(d1.db, { folderId: tree.top }, dee, 'commenter');
      const lost = await insertLink(d1.db, { folderId: tree.from }, 'viewer');
      const kept = await insertLink(d1.db, { folderId: tree.top }, 'viewer');
      const gained = await insertLink(d1.db, { folderId: tree.into }, 'viewer');
      rechecks.length = 0;
      const counted = countingRows(d1.db);
      const response = await call(ada, 'PATCH', `/api/folders/${tree.top}`, { parentId: tree.into }, counted.db);
      expect(response.status, await response.clone().text()).toBe(200);
      return { tree, trips: counted.trips(), lost, kept, gained };
    };
    const small = await moveCounted(10);
    const large = await moveCounted(1_000);
    expect(large.trips, 'D1 round trips do not grow with the notes moved').toBe(small.trips);

    const bensAgents = (await d1.db.prepare('SELECT id FROM agents WHERE owner_user_id = ? AND revoked_at IS NULL').bind(ben.id)
      .all<{ id: string }>()).results.map((row) => row.id);
    expect(bensAgents).toContain(bens.id);
    const byDoc = new Map(rechecks.map((entry) => [entry.docId, entry.input]));
    expect(large.tree.docs.filter((id) => !byDoc.has(id)), 'every moved note is rechecked').toEqual([]);
    for (const id of large.tree.docs) {
      const input = byDoc.get(id)!;
      expect(new Set(input.principalIds), 'Ben fell from editor to viewer, with his agent').toEqual(new Set([ben.id, ...bensAgents]));
      expect(input.tokens, 'only the link on the old parent stopped reaching it').toEqual([large.lost]);
    }
  }, 180_000);

  it('reads every note’s grants and links at once, as each note’s own chain gives them', async () => {
    const { reachOf } = await import('@moss-multi/sync/fanout');
    const tree = await subtree(6);
    await insertGrant(d1.db, { folderId: tree.from }, ben, 'editor');
    await insertGrant(d1.db, { folderId: tree.top }, ben, 'viewer');
    await insertGrant(d1.db, { folderId: tree.vault }, cy, 'commenter');
    await insertGrant(d1.db, { docId: tree.docs[0] }, cy, 'owner');
    const onVault = await insertLink(d1.db, { folderId: tree.vault }, 'viewer');
    const onDoc = await insertLink(d1.db, { docId: tree.docs[1] }, 'editor');
    await insertLink(d1.db, { folderId: tree.from }, 'viewer', { revoked: true });
    const elsewhere = await insertDoc(d1.db, zed);
    const counted = countingRows(d1.db);
    const reach = await reachOf(counted.db, [...tree.docs, elsewhere, crypto.randomUUID()]);
    expect(counted.trips(), 'one round trip for every note').toBe(1);
    for (const [i, id] of tree.docs.entries()) {
      const got = reach.get(id)!;
      expect(Object.fromEntries(got.roles)).toEqual({ [ada.id]: 'owner', [ben.id]: 'editor', [cy.id]: i === 0 ? 'owner' : 'commenter' });
      expect([...got.tokens].sort()).toEqual((i === 1 ? [onVault, onDoc] : [onVault]).sort());
    }
    expect(Object.fromEntries(reach.get(elsewhere)!.roles)).toEqual({ [zed.id]: 'owner' });
    expect(reach.get(elsewhere)!.tokens.size).toBe(0);
  }, 60_000);
});
