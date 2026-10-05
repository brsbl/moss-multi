import { afterAll, beforeAll, expect, it } from 'vitest';
import { countingBinds, D1_MAX_PARAMS, migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, SECRET, insertDoc, insertFolder, insertGrant, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
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
