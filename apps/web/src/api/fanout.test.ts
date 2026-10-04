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

it('workspace upgrades derive identity from auth, strip forged headers, and refuse foreign or absent credentials', async () => {
  const { workspaceSocket } = await import('../worker/workspace.ts');
  const forwarded: { id: string; request: Request }[] = [];
  const env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, PrincipalDO: {
    idFromName: (id: string) => id,
    get: (id: string) => ({ setName: async () => undefined, fetch: async (request: Request) => { forwarded.push({ id, request }); return new Response('accepted'); } }),
  } } as unknown as import('../env.ts').AppEnv;
  const upgrade = (headers: Record<string, string>) => new Request(`${BASE}/api/workspace/ws`, { headers: { upgrade: 'websocket', ...headers } });
  const refuse = (code: number) => new Response(String(code));
  const accepted = await workspaceSocket(upgrade({ origin: BASE, cookie: reader.cookie, 'x-moss-principal': owner.id, 'x-moss-session': 'forged', 'x-partykit-room': owner.id }), env, refuse);
  expect(await accepted.text()).toBe('accepted');
  expect(forwarded[0].id).toBe(reader.id);
  expect(forwarded[0].request.headers.get('x-moss-principal')).toBe(reader.id);
  expect(forwarded[0].request.headers.get('x-moss-session')).not.toBe('forged');
  expect(forwarded[0].request.headers.has('x-partykit-room')).toBe(false);
  const refusedHeaders: Record<string, string>[] = [{ origin: 'https://evil.example', cookie: reader.cookie }, { origin: BASE }, { cookie: reader.cookie }];
  for (const headers of refusedHeaders) {
    expect(await (await workspaceSocket(upgrade(headers), env, refuse)).text()).toBe('4401');
  }
  expect(forwarded).toHaveLength(1);
});

it('returns the committed share even when its notification RPC fails', async () => {
  const { handleApi } = await import('./router.ts');
  const id = await insertDoc(d1.db, owner);
  const response = await handleApi(new Request(`${BASE}/api/docs/${id}/members`, {
    method: 'POST', headers: { cookie: owner.cookie, origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ email: reader.email, role: 'editor' }),
  }), { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: {} as never, PrincipalDO: {
    idFromName: (name: string) => name,
    get: () => ({ setName: async () => undefined, publish: async () => { throw new Error('PrincipalDO unavailable'); } }),
  } as never });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ shared: { email: reader.email, role: 'editor' } });
  expect(await d1.db.prepare('SELECT role FROM doc_members WHERE doc_id = ? AND principal_id = ?')
    .bind(id, reader.id).first()).toEqual({ role: 'editor' });
});
