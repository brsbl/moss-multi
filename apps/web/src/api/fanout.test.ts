import { afterAll, beforeAll, expect, it } from 'vitest';
import { publishMeta, principalsWithAccess } from '@moss-multi/sync/fanout';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, SECRET, signedUpUser, insertDoc, type TestUser } from '../test/principals.ts';

let d1: TestD1;
let owner: TestUser;
let reader: TestUser;
beforeAll(async () => {
  d1 = await migratedD1();
  const env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE };
  owner = await signedUpUser(env, 'workspace-owner');
  reader = await signedUpUser(env, 'workspace-reader');
}, 60_000);
afterAll(() => d1?.dispose());

it('fanout never leaks a sibling id to a direct grantee and retains trash recipients', async () => {
  const shared = await insertDoc(d1.db, owner);
  const privateDoc = await insertDoc(d1.db, owner);
  await d1.db.prepare("INSERT INTO doc_members (doc_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, 'user', 'viewer', ?, 1)")
    .bind(shared, reader.id, owner.id).run();
  await d1.db.prepare('UPDATE docs SET deleted_at = 2 WHERE id = ?').bind(shared).run();
  expect(await principalsWithAccess(d1.db, shared)).toEqual(expect.arrayContaining([owner.id, reader.id]));
  const sent = new Map<string, unknown>();
  await publishMeta({ DB: d1.db, PrincipalDO: {
    idFromName: (id: string) => id,
    get: (id: string) => ({ setName: async () => undefined, publish: async (event: unknown) => { sent.set(id, event); } }),
  } as never }, [shared, privateDoc]);
  expect(sent.get(reader.id)).toEqual({ type: 'meta', docIds: [shared], folderIds: [] });
  expect(sent.get(owner.id)).toEqual({ type: 'meta', docIds: [shared, privateDoc], folderIds: [] });
});
