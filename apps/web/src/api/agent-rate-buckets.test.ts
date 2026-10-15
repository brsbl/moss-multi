// One rate per person (BUILDPLAN M7, T7.S5): every per-identity limiter is keyed on the acting user, so an agent spends
// its owner's allowance and a new key never refills it, while the agent stays the actor the DocDO sees.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { setRemoteFetchForTests } from './remote.ts';
import { handleApi } from './router.ts';

const ALLOWANCE = 3;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const PAGE = '<!doctype html><html><head><meta property="og:title" content="Site"></head><body></body></html>';

const docCalls: { op: string; input: unknown }[] = [];
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => {
    const record = (op: string, answer: unknown) => async (input: unknown) => {
      docCalls.push({ op, input });
      return answer;
    };
    return {
      setName: async () => undefined,
      renameTitle: record('rename', undefined),
      restoreVersion: record('restore', { ok: true, restorePoint: 'p1', version: 'a1' }),
      createComment: record('comment', { ok: true, id: 'c1', quote: null }),
      previewSuggestion: record('preview', { ok: true, hunks: [], hash: 'h', digest: 'd' }),
      rejectSuggestion: record('reject', { ok: true }),
      exportWorking: record('working', '# working\n'),
    };
  },
};

/** Every limiter keeps one window per PrincipalDO name, ALLOWANCE calls long, as the persisted windows do. */
const taken = new Map<string, number>();
const take = (name: string, kind: string) => async () => {
  const key = `${kind}:${name}`;
  const spent = (taken.get(key) ?? 0) + 1;
  taken.set(key, spent);
  return spent <= ALLOWANCE;
};
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    publish: async () => undefined,
    takeCreateToken: async () => true,
    takeWriteToken: take(id.name, 'write'),
    takeCommentToken: take(id.name, 'comment'),
    takeReviewToken: take(id.name, 'review'),
    takePreviewToken: take(id.name, 'preview'),
    takeFetchToken: take(id.name, 'fetch'),
    takeUploadToken: take(id.name, 'upload'),
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let eve: TestUser;
let docId: string;
let serial = 0;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  eve = await signedUpUser(env, 'buckets-eve', 'Eve');
  docId = await insertDoc(d1.db, eve);
  setRemoteFetchForTests({
    fetch: (async () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch,
    resolve: async (host) => (host === 'site.example' ? ['93.184.215.14'] : []),
  });
}, 60_000);
afterAll(() => {
  setRemoteFetchForTests(null);
  d1?.dispose();
});
beforeEach(() => {
  taken.clear();
  docCalls.length = 0;
});

type Auth = { cookie: string } | { bearer: string };
function call(method: string, path: string, auth: Auth, body?: unknown, type = 'application/json') {
  const headers: Record<string, string> = 'cookie' in auth ? { cookie: auth.cookie, origin: BASE } : { authorization: `Bearer ${auth.bearer}` };
  if (body === undefined) return handleApi(new Request(`${BASE}${path}`, { method, headers }), env);
  const bytes = body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : new TextEncoder().encode(JSON.stringify(body));
  Object.assign(headers, { 'content-type': type, 'content-length': String(bytes.byteLength) });
  return handleApi(new Request(`${BASE}${path}`, { method, headers, body: bytes }), env);
}

const doc = () => `/api/docs/${docId}`;
const ROUTES: [string, (auth: Auth) => Promise<Response>][] = [
  ['a rename', (auth) => call('PATCH', doc(), auth, { title: `Title ${(serial += 1)}` })],
  ['a restore', (auth) => call('POST', `${doc()}/versions/v1/restore`, auth, {})],
  ['a comment', (auth) => call('POST', `${doc()}/comments`, auth, { id: `c${(serial += 1)}`, text: 'Hi' })],
  ['a suggestion preview', (auth) => call('GET', `${doc()}/suggestions/s1/preview`, auth)],
  ['a suggestion review', (auth) => call('POST', `${doc()}/suggestions/s1/reject`, auth, {})],
  ['a working export', (auth) => call('GET', `${doc()}/content?view=working`, auth)],
  ['an unfurl', (auth) => call('POST', '/api/unfurl', auth, { noteId: docId, url: `https://site.example/p${(serial += 1)}` })],
  ['an upload', (auth) => call('POST', `${doc()}/assets?filename=up${(serial += 1)}.png`, auth, PNG, 'image/png')],
];

describe("an agent spends its owner's allowance (T7.S5) @p:agt-1", () => {
  it.each(ROUTES)('%s: a session and two keys exhaust it, and a third key gets 429', async (_label, route) => {
    const keys = await Promise.all([insertAgent(d1.db, eve), insertAgent(d1.db, eve), insertAgent(d1.db, eve)]);
    const callers: Auth[] = [{ cookie: eve.cookie }, { bearer: keys[0].key }, { bearer: keys[1].key }];
    for (const [i, auth] of callers.entries()) {
      const response = await route(auth);
      expect(response.status, `caller ${i}: ${await response.clone().text()}`).toBeLessThan(300);
    }
    const third = await route({ bearer: keys[2].key });
    expect(third.status, 'a new key does not refill the allowance').toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
    expect([...taken.keys()].every((key) => key.endsWith(`:${eve.id}`)), [...taken.keys()].join(', ')).toBe(true);
  }, 60_000);

  it('keeps the agent as the actor the DocDO sees', async () => {
    const agent = await insertAgent(d1.db, eve);
    expect((await call('POST', `${doc()}/comments`, { bearer: agent.key }, { id: 'actor1', text: 'Hi' })).status).toBe(201);
    expect((await call('POST', `${doc()}/suggestions/s1/reject`, { bearer: agent.key }, {})).status).toBe(200);
    expect(docCalls.map(({ op }) => op)).toEqual(['comment', 'reject']);
    expect(docCalls[0].input).toMatchObject({ author: agent.id, source: 'external' });
    expect(docCalls[1].input).toMatchObject({ reviewer: { id: agent.id }, actor: { kind: 'agent', principalId: agent.id } });
  });
});
