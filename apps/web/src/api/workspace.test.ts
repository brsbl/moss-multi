import { afterAll, beforeAll, expect, it } from 'vitest';
import { countingBinds, D1_MAX_PARAMS, migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, SECRET, insertDoc, insertFolder, insertGrant, insertLink, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { workspace } from './workspace.ts';

let d1: TestD1;
let env: AuthTestEnv;
let ada: TestUser;
let ben: TestUser;
beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE };
  ada = await signedUpUser(env, 'discovery-ada');
  ben = await signedUpUser(env, 'discovery-ben');
}, 60_000);
afterAll(() => d1?.dispose());

interface Listing {
  vault: { id: string };
  vaults: { id: string; role: string; owned: boolean }[];
  docs: { id: string; folderPath: string; surfaced: boolean; role: string }[];
  folders: { id: string; path: string; surfaced: boolean; role: string }[];
}
async function list(query = ''): Promise<Listing> {
  const response = await workspace(new Request(`${BASE}/api/workspace${query}`, { headers: { cookie: ben.cookie } }), env);
  expect(response.status).toBe(200);
  return response.json();
}

it('surfaces a directly shared doc at Home without disclosing its parent or unrelated docs', async () => {
  const doc = await insertDoc(d1.db, ada);
  const secret = await insertDoc(d1.db, ada);
  await insertGrant(d1.db, { docId: doc }, ben, 'editor');
  const result = await list(`?doc=${doc}`);
  expect(result.vault.id).toBe(ben.homeId);
  expect(result.docs).toContainEqual(expect.objectContaining({ id: doc, folderPath: 'Notes', surfaced: true, role: 'editor' }));
  expect(result.docs.map((row) => row.id)).not.toContain(secret);
  expect(result.vaults.map((row) => row.id)).not.toContain(ada.homeId);
});

it('surfaces shared folders with collision-free paths, includes descendants, and never invents inaccessible ancestors', async () => {
  const first = await insertFolder(d1.db, ada, ada.homeId);
  const otherParent = await insertFolder(d1.db, ada, ada.homeId);
  const second = await insertFolder(d1.db, ada, otherParent);
  const own = await insertFolder(d1.db, ben, ben.homeId);
  await d1.db.prepare('UPDATE folders SET name = ? WHERE id IN (?, ?, ?)').bind('Same', first, second, own).run();
  const child = await insertFolder(d1.db, ada, first);
  const doc = await insertDoc(d1.db, ada, { folderId: child });
  await insertGrant(d1.db, { folderId: first }, ben, 'viewer');
  await insertGrant(d1.db, { folderId: second }, ben, 'editor');
  const result = await list();
  const shared = result.folders.filter((row) => [first, second].includes(row.id));
  expect(shared).toHaveLength(2);
  expect(shared.every((row) => row.surfaced && row.path.split('/').length === 2)).toBe(true);
  expect(new Set(result.folders.map((row) => row.path)).size).toBe(result.folders.length);
  expect(result.docs).toContainEqual(expect.objectContaining({ id: doc, folderPath: result.folders.find((row) => row.id === child)?.path, role: 'viewer' }));
  expect(result.folders.map((row) => row.id)).not.toContain(ada.homeId);
});

it('orders owned vaults first, follows a visible doc vault, and honors an explicit switch', async () => {
  const vault = await insertFolder(d1.db, ada, null);
  const doc = await insertDoc(d1.db, ada, { folderId: vault });
  await insertGrant(d1.db, { folderId: vault }, ben, 'commenter');
  const result = await list(`?doc=${doc}`);
  expect(result.vault.id).toBe(vault);
  expect(result.vaults[0]).toMatchObject({ id: ben.homeId, owned: true, role: 'owner' });
  expect(result.vaults).toContainEqual(expect.objectContaining({ id: vault, owned: false, role: 'commenter' }));
  expect((await list(`?vault=${ben.homeId}`)).vault.id).toBe(ben.homeId);
  expect((await list(`?vault=${vault}`)).docs).toContainEqual(expect.objectContaining({ id: doc, surfaced: false }));
  await d1.db.prepare('DELETE FROM folder_members WHERE folder_id = ?').bind(vault).run();
  const revoked = await list(`?vault=${vault}`);
  expect(revoked.vault.id).toBe(ben.homeId);
  expect(revoked.docs.map((row) => row.id)).not.toContain(doc);
});

it('lists 150 shared notes and 150 folders, owned and granted, with a fixed number of bound parameters', async () => {
  const cal = await signedUpUser(env, 'discovery-cal');
  const listAs = async (db: D1Database) => {
    const response = await workspace(new Request(`${BASE}/api/workspace`, { headers: { cookie: cal.cookie } }), { ...env, DB: db });
    expect(response.status).toBe(200);
    return (await response.json()) as Listing;
  };
  await listAs(d1.db);
  const small = countingBinds(d1.db);
  await listAs(small.db);

  const roles = ['viewer', 'commenter', 'editor'] as const;
  const sharedDocs: Record<string, string> = {};
  for (let i = 0; i < 150; i++) {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, cal, roles[i % 3]);
    sharedDocs[doc] = roles[i % 3];
  }
  const owned: string[] = [];
  for (let i = 0; i < 75; i++) owned.push(await insertFolder(d1.db, cal, cal.homeId));
  const granted: Record<string, string> = {};
  for (let i = 0; i < 75; i++) {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    await insertGrant(d1.db, { folderId: folder }, cal, roles[i % 3]);
    granted[folder] = roles[i % 3];
  }
  const [lastGranted, lastRole] = Object.entries(granted).at(-1)!;
  const inGranted = await insertDoc(d1.db, ada, { folderId: lastGranted });
  const inOwned = await insertDoc(d1.db, cal, { folderId: owned.at(-1) });

  const large = countingBinds(d1.db);
  const result = await listAs(large.db);
  const docRoles = Object.fromEntries(result.docs.map((row) => [row.id, row.role]));
  expect(Object.keys(sharedDocs).filter((id) => docRoles[id] !== sharedDocs[id]), 'every shared note at its role').toEqual([]);
  expect(docRoles[inGranted]).toBe(lastRole);
  expect(docRoles[inOwned]).toBe('owner');
  const folderRoles = Object.fromEntries(result.folders.map((row) => [row.id, row.role]));
  expect(owned.filter((id) => folderRoles[id] !== 'owner'), 'every owned folder').toEqual([]);
  expect(Object.keys(granted).filter((id) => folderRoles[id] !== granted[id]), 'every granted folder at its role').toEqual([]);

  expect(large.binds, 'bound parameters per statement do not grow with the listing').toEqual(small.binds);
  expect(Math.max(...large.binds)).toBeLessThanOrEqual(D1_MAX_PARAMS);
}, 120_000);

/** `count` folders under `parentId`, owned by `owner`, written in one batch. */
async function folderBatch(owner: TestUser, parentIds: string[]): Promise<string[]> {
  const ids = parentIds.map(() => crypto.randomUUID());
  await d1.db.batch(ids.map((id, i) => d1.db
    .prepare('INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner.id, owner.id, `f-${id.slice(0, 8)}`, 'folder', parentIds[i], Date.now())));
  return ids;
}

/** One note in each of `folderIds`, owned by `owner`, written in one batch. */
async function docBatch(owner: TestUser, folderIds: string[]): Promise<string[]> {
  const ids = folderIds.map(() => crypto.randomUUID());
  const now = Date.now();
  await d1.db.batch(ids.map((id, i) => d1.db
    .prepare('INSERT INTO docs (id, owner_user_id, created_by, folder_id, title, filename, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner.id, owner.id, folderIds[i], '', `${id}.md`, now, now)));
  return ids;
}

it('lists a folder link over 150 subfolders and 600 notes completely, at fixed queries and parameters', async () => {
  const dee = await signedUpUser(env, 'link-scale-dee');
  const root = await insertFolder(d1.db, ada, ada.homeId);
  const token = await insertLink(d1.db, { folderId: root }, 'commenter');
  const listAs = async (db: D1Database, cookie: string | null, vault: string) => {
    const headers: Record<string, string> = cookie ? { cookie } : {};
    const response = await workspace(new Request(`${BASE}/api/workspace?vault=${vault}&share=${token}`, { headers }), { ...env, DB: db });
    expect(response.status).toBe(200);
    return (await response.json()) as Listing;
  };
  const measure = async (cookie: string | null) => {
    const counted = countingBinds(d1.db);
    const result = await listAs(counted.db, cookie, root);
    return { result, binds: [...counted.binds].sort((a, b) => a - b), prepared: counted.prepared() };
  };

  const firstFolder = (await folderBatch(ada, [root]))[0];
  await docBatch(ada, [firstFolder]);
  await listAs(d1.db, dee.cookie, root);
  const smallSignedIn = await measure(dee.cookie);
  const smallAnonymous = await measure(null);
  expect(smallSignedIn.result.vault.id).toBe(root);

  // 29 more top-level subfolders, each with four children: 150 in all, and four notes in each.
  const top = [firstFolder, ...(await folderBatch(ada, Array(29).fill(root)))];
  const children = await folderBatch(ada, top.flatMap((id) => [id, id, id, id]));
  const all = [...top, ...children];
  const notes = [...(await docBatch(ada, all.slice(1).flatMap((id) => [id, id, id, id]))), ...(await docBatch(ada, [firstFolder, firstFolder, firstFolder]))];
  const trashed = await insertDoc(d1.db, ada, { folderId: children[0], deleted: true });
  const elsewhere = await insertDoc(d1.db, ada);
  // Dee's own grants lift what they cover above the link's commenter; a viewer grant leaves the link's role.
  const edited = children[5];
  const editedParent = top[1];
  await insertGrant(d1.db, { folderId: edited }, dee, 'editor');
  await insertGrant(d1.db, { folderId: children[6] }, dee, 'viewer');
  const owned = notes[0];
  await insertGrant(d1.db, { docId: owned }, dee, 'owner');

  const signedIn = await measure(dee.cookie);
  const anonymous = await measure(null);
  const folderIds = all.length;
  const allNotes = notes.length + 1;
  expect(folderIds).toBe(150);
  expect(allNotes).toBe(600);

  const signedInDocs = Object.fromEntries(signedIn.result.docs.map((row) => [row.id, row.role]));
  const notesIn = await d1.db.prepare('SELECT id, folder_id AS folderId FROM docs WHERE folder_id = ?').bind(edited).all<{ id: string; folderId: string }>();
  const expectedDoc = (id: string) => (id === owned ? 'owner' : notesIn.results.some((row) => row.id === id) ? 'editor' : 'commenter');
  expect(signedIn.result.docs).toHaveLength(600);
  expect(Object.keys(signedInDocs).filter((id) => signedInDocs[id] !== expectedDoc(id)), 'every note at the signed-in role').toEqual([]);
  expect(signedInDocs[trashed]).toBeUndefined();
  expect(signedInDocs[elsewhere]).toBeUndefined();
  const signedInFolders = Object.fromEntries(signedIn.result.folders.map((row) => [row.id, row.role]));
  expect(signedIn.result.folders).toHaveLength(150);
  expect(all.filter((id) => signedInFolders[id] !== (id === edited ? 'editor' : 'commenter')), 'every subfolder at the signed-in role').toEqual([]);
  expect(signedInFolders[editedParent]).toBe('commenter');

  expect(anonymous.result.docs).toHaveLength(600);
  expect(anonymous.result.docs.every((row) => row.role === 'viewer'), 'an anonymous holder reads at viewer').toBe(true);
  expect(anonymous.result.folders).toHaveLength(150);
  expect(anonymous.result.folders.every((row) => row.role === 'viewer')).toBe(true);
  const paths = new Set(anonymous.result.folders.map((row) => row.path));
  expect(anonymous.result.docs.every((row) => paths.has(row.folderPath)), 'every note sits in a listed folder').toBe(true);
  expect(anonymous.result.folders.reduce((sum, row) => sum + (row as { noteCount?: number }).noteCount!, 0)).toBe(600);

  expect(signedIn.prepared, 'statements do not grow with the link listing').toBe(smallSignedIn.prepared);
  expect(signedIn.binds, 'bound parameters do not grow with the link listing').toEqual(smallSignedIn.binds);
  expect(anonymous.prepared).toBe(smallAnonymous.prepared);
  expect(anonymous.binds).toEqual(smallAnonymous.binds);
  expect(Math.max(...signedIn.binds, ...anonymous.binds)).toBeLessThanOrEqual(D1_MAX_PARAMS);
}, 120_000);
