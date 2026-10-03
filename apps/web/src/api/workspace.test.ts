import { afterAll, beforeAll, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
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
  folders: { id: string; path: string; surfaced: boolean }[];
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
  const second = await insertFolder(d1.db, ada, ada.homeId);
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
