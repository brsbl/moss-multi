// The origin gate on /api/* (A§18): a principal that came from a cookie changes state only from the app's own
// origin, because the browser attaches the cookie whichever page asked. Bearer tokens, agent keys and share tokens
// are never attached by the browser, so they pass; reads are never gated.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { agentKey, BASE, SECRET, signedUpUser, type AuthTestEnv, type TestUser, unmeteredPrincipals } from '../test/principals.ts';
import { handleApi } from './router.ts';

const created: string[] = [];

/** A DocDO namespace for POST /api/docs: getServerByName's setName, then create. */
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    create: async () => {
      created.push(id.name);
    },
  }),
};

/** Same-site pages the cookie still rides to: another port on the app's host, and a sibling subdomain. */
const FOREIGN = ['http://127.0.0.1:8851', 'https://evil.example', 'null'];

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: unmeteredPrincipals as never };
  ada = await signedUpUser(env, 'gate-ada');
  ben = await signedUpUser(env, 'gate-ben', 'Ben');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  created.length = 0;
});

/** A JSON request; a header set to undefined is left out. */
const request = (method: string, path: string, headers: Record<string, string | undefined>, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method,
    headers: Object.entries({ 'content-type': 'application/json', ...headers }).filter((h): h is [string, string] => h[1] !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createNote = (headers: Record<string, string | undefined>, path = '/api/docs') => handleApi(request('POST', path, headers, {}), env);

async function createdBy(response: Response): Promise<string | null> {
  if (response.status !== 201) return null;
  const { doc } = (await response.json()) as { doc: { id: string } };
  const row = await d1.db.prepare('SELECT created_by FROM docs WHERE id = ?').bind(doc.id).first<{ created_by: string }>();
  return row?.created_by ?? null;
}

describe('the origin gate on /api mutations', () => {
  it('refuses a cookie from another origin or with no Origin with a plain 403, and writes nothing', async () => {
    for (const origin of [...FOREIGN, undefined]) {
      const response = await createNote({ cookie: ada.cookie, origin });
      expect(response.status, `POST /api/docs, Origin ${origin}`).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden', message: 'Cross-origin request refused' });
      const feedback = await handleApi(request('POST', '/api/feedback', { cookie: ada.cookie, origin }, { body: 'hi' }), env);
      expect(feedback.status, `POST /api/feedback, Origin ${origin}`).toBe(403);
    }
    expect(created).toEqual([]);
    const count = await d1.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE created_by = ?').bind(ada.id).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("admits a cookie from the app's origin", async () => {
    expect(await createdBy(await createNote({ cookie: ada.cookie, origin: BASE }))).toBe(ada.id);
  });

  it('admits a session bearer and an agent key from anywhere: neither rides along on its own', async () => {
    const key = await agentKey(d1.db, ada);
    for (const origin of [undefined, ...FOREIGN]) {
      expect(await createdBy(await createNote({ authorization: `Bearer ${ada.token}`, origin })), `session bearer, Origin ${origin}`).toBe(ada.id);
      expect(await createdBy(await createNote({ authorization: `Bearer ${key}`, origin })), `agent key, Origin ${origin}`).not.toBeNull();
    }
    const feedback = await handleApi(request('POST', '/api/feedback', { authorization: `Bearer ${ada.token}` }, { body: 'from the CLI' }), env);
    expect(feedback.status).toBe(201);
  });

  it('judges a cookie and a bearer by the bearer, and never falls back to the cookie', async () => {
    expect(await createdBy(await createNote({ cookie: ada.cookie, authorization: `Bearer ${ben.token}`, origin: FOREIGN[0] }))).toBe(ben.id);
    for (const forged of ['forged.signature', 'forged']) {
      const response = await createNote({ cookie: ada.cookie, authorization: `Bearer ${forged}` });
      expect(response.status, `a failed bearer "${forged}" beside Ada's cookie`).toBe(401);
    }
    expect(created).toHaveLength(1);
  });

  it('lets a share token alone through to the handler, which decides', async () => {
    for (const origin of [...FOREIGN, undefined]) {
      expect((await createNote({ origin }, '/api/docs?share=link-token')).status, `Origin ${origin}`).toBe(401);
    }
  });

  it('never gates a read: a same-origin GET carries no Origin', async () => {
    for (const origin of [undefined, ...FOREIGN]) {
      const me = await handleApi(request('GET', '/api/me', { cookie: ada.cookie, origin }), env);
      expect(me.status, `GET /api/me, Origin ${origin}`).toBe(200);
    }
  });
});
