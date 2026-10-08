// The version history REST API (BUILDPLAN T6.2; A§14): GET .../versions and .../versions/:vid for any reader, POST
// .../versions {name} (a named version) and .../versions/:vid/restore for an editor or above. Named versions are rate
// limited per person by its PrincipalDO; the DocDO re-authorizes the actor in the write, and its verdict passes through.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VAULT_MEDIA_QUOTA_BYTES } from '@moss-multi/protocol/limits';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertGrant, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const calls: { op: string; docId: string; input: unknown }[] = [];
let verdict: Record<string, unknown> | null = null;

const META = { id: 'v1', kind: 'named', name: 'Draft', createdAt: 1, createdBy: 'x', authorIds: [], title: 'T', bytes: 10, spilled: false };

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => {
    const record = (op: string, answer: Record<string, unknown>) => async (input: unknown) => {
      calls.push({ op, docId: id.name, input });
      return verdict ?? answer;
    };
    return {
      setName: async () => undefined,
      listVersions: record('list', { ok: true, versions: [META] }),
      getVersion: record('get', { ok: true, version: { ...META, markdown: '# T\n' } }),
      saveVersion: record('save', { ok: true, version: META }),
      restoreVersion: record('restore', { ok: true, restorePoint: 'p1', version: 'a1' }),
    };
  },
};

const tokens: string[] = [];
let versionTokens = Infinity;
let writeTokens = Infinity;
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    takeVersionToken: async () => {
      tokens.push(`version:${id.name}`);
      versionTokens -= 1;
      return versionTokens >= 0;
    },
    takeWriteToken: async () => {
      tokens.push(`write:${id.name}`);
      writeTokens -= 1;
      return writeTokens >= 0;
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let cara: TestUser;
let dan: TestUser;
let eve: TestUser;
let docId: string;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'versions-ada', 'Ada');
  cara = await signedUpUser(env, 'versions-cara', 'Cara');
  dan = await signedUpUser(env, 'versions-dan', 'Dan');
  eve = await signedUpUser(env, 'versions-eve', 'Eve');
  docId = await insertDoc(d1.db, ada);
  await insertGrant(d1.db, { docId }, { id: cara.id }, 'viewer');
  await insertGrant(d1.db, { docId }, { id: eve.id }, 'editor');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  calls.length = 0;
  tokens.length = 0;
  versionTokens = Infinity;
  writeTokens = Infinity;
  verdict = null;
});

const send = (method: string, cookie: string | null, path: string, body?: unknown) =>
  handleApi(
    new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );

const versions = () => `/api/docs/${docId}/versions`;

describe('version routes @p:mean-3', () => {
  it('lists and reads for any reader, saves and restores for an editor, as the caller', async () => {
    const listed = await send('GET', cara.cookie, versions());
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ versions: [META] });
    const read = await send('GET', cara.cookie, `${versions()}/v1`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ version: { ...META, markdown: '# T\n' } });
    const saved = await send('POST', eve.cookie, versions(), { name: '  Draft  ' });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toEqual({ version: META });
    const restored = await send('POST', ada.cookie, `${versions()}/v1/restore`);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ restorePoint: 'p1', version: 'a1' });
    expect(calls.map(({ op, input }) => [op, (input as { reviewer: unknown }).reviewer])).toEqual([
      ['list', { id: cara.id, role: 'viewer' }],
      ['get', { id: cara.id, role: 'viewer' }],
      ['save', { id: eve.id, role: 'editor' }],
      ['restore', { id: ada.id, role: 'owner' }],
    ]);
    expect(calls[2].input).toMatchObject({ name: 'Draft', actor: { kind: 'user', principalId: eve.id } });
    expect(calls[3].input).toMatchObject({ id: 'v1', actor: { kind: 'user', principalId: ada.id } });
    expect(tokens).toEqual([`version:${eve.id}`, `write:${ada.id}`]);
  });

  it('refuses a viewer saving or restoring 403, a stranger 404, an anonymous caller 401, and bad input 400, before the DocDO', async () => {
    expect((await send('POST', cara.cookie, versions(), { name: 'Mine' })).status).toBe(403);
    expect((await send('POST', cara.cookie, `${versions()}/v1/restore`)).status).toBe(403);
    expect((await send('GET', dan.cookie, versions())).status).toBe(404);
    expect((await send('POST', dan.cookie, `${versions()}/v1/restore`)).status).toBe(404);
    expect((await send('GET', null, versions())).status).toBe(401);
    expect((await send('POST', ada.cookie, versions(), { name: '   ' })).status).toBe(400);
    expect((await send('POST', ada.cookie, versions(), { name: 'x'.repeat(81) })).status).toBe(400);
    expect((await send('POST', ada.cookie, versions(), {})).status).toBe(400);
    expect((await send('GET', ada.cookie, `${versions()}/bad id!`)).status).toBe(400);
    expect((await send('DELETE', ada.cookie, versions())).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it('answers 429 with retry-after past the per-person named version rate, and charges nobody else', async () => {
    versionTokens = 0;
    const response = await send('POST', eve.cookie, versions(), { name: 'Draft' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(calls).toEqual([]);
    expect(tokens).toEqual([`version:${eve.id}`]);
  });

  it('answers 429 past the per-person write rate for a restore', async () => {
    writeTokens = 0;
    const response = await send('POST', eve.cookie, `${versions()}/v1/restore`);
    expect(response.status).toBe(429);
    expect(calls).toEqual([]);
  });

  it("refuses a named version 413 when the doc's vault is out of storage, versions counted, before the DocDO", async () => {
    const full = await insertDoc(d1.db, dan);
    await d1.db.prepare('UPDATE docs SET version_bytes = ? WHERE id = ?').bind(VAULT_MEDIA_QUOTA_BYTES, full).run();
    const response = await send('POST', dan.cookie, `/api/docs/${full}/versions`, { name: 'Draft' });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'over-quota' });
    expect(calls).toEqual([]);
  });

  it("refuses a restore 413 when the doc's vault is out of storage, before the DocDO", async () => {
    const full = await insertDoc(d1.db, dan);
    await d1.db.prepare('UPDATE docs SET version_bytes = ? WHERE id = ?').bind(VAULT_MEDIA_QUOTA_BYTES, full).run();
    const response = await send('POST', dan.cookie, `/api/docs/${full}/versions/v1/restore`);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'over-quota' });
    expect(calls).toEqual([]);
  });

  it.each([
    [{ ok: false, status: 409, reason: 'restore-unverified' }, 409],
    [{ ok: false, status: 409, reason: 'version-limit' }, 409],
    [{ ok: false, status: 403, reason: 'role' }, 403],
    [{ ok: false, status: 404, reason: 'not-found' }, 404],
  ])('passes the DocDO verdict %j through', async (answer, status) => {
    verdict = answer;
    const response = await send('POST', ada.cookie, `${versions()}/v1/restore`);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: answer.reason });
  });
});
