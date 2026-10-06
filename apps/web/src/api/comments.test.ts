// POST /api/docs/:id/comments (BUILDPLAN T4.1; docs/design/comments.md §4, §12): commenter and above, authorship from
// the server principal, 60 operations per principal per minute, and the DocDO's verdict passed through.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const calls: { docId: string; input: Record<string, unknown> }[] = [];
let verdict: Record<string, unknown> = { ok: true, id: 'c1', quote: 'brown fox' };

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    createComment: async (input: Record<string, unknown>) => {
      calls.push({ docId: id.name, input });
      return verdict;
    },
    resolveComment: async (input: Record<string, unknown>) => {
      resolves.push({ docId: id.name, input });
      return verdict;
    },
  }),
};
const resolves: { docId: string; input: Record<string, unknown> }[] = [];

const tokenAsks: string[] = [];
let commentTokens = Infinity;
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    takeCommentToken: async () => {
      tokenAsks.push(id.name);
      commentTokens -= 1;
      return commentTokens >= 0;
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cara: TestUser;
let dan: TestUser;
let docId: string;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'comments-ada');
  ben = await signedUpUser(env, 'comments-ben', 'Ben');
  cara = await signedUpUser(env, 'comments-cara', 'Cara');
  dan = await signedUpUser(env, 'comments-dan', 'Dan');
  docId = await insertDoc(d1.db, ada);
  await insertGrant(d1.db, { docId }, { id: ben.id }, 'commenter');
  await insertGrant(d1.db, { docId }, { id: cara.id }, 'viewer');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  calls.length = 0;
  resolves.length = 0;
  tokenAsks.length = 0;
  commentTokens = Infinity;
  verdict = { ok: true, id: 'c1', quote: 'brown fox' };
});

const post = (cookie: string | null, body: unknown, path = `/api/docs/${docId}/comments`) =>
  handleApi(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    env,
  );

const COMMENT = { id: 'c1', text: 'Nice', anchor: { kind: 'text', start: 'AAA=', end: 'AAA=' }, author: 'forged-author' };

describe('POST /api/docs/:id/comments @p:tech-3 @p:mean-1', () => {
  it('lets a commenter create a comment authored by their own principal', async () => {
    const response = await post(ben.cookie, COMMENT);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ comment: { id: 'c1', quote: 'brown fox' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ docId, input: { author: ben.id, source: 'user', id: 'c1', text: 'Nice', anchor: { kind: 'text', start: 'AAA=', end: 'AAA=' } } });
    expect(tokenAsks).toEqual([ben.id]);
  });

  it('lets the owner reply, and passes parentId', async () => {
    const response = await post(ada.cookie, { id: 'r1', text: 'Reply', parentId: 'c1' });
    expect(response.status).toBe(201);
    expect(calls[0].input).toMatchObject({ author: ada.id, id: 'r1', parentId: 'c1' });
  });

  it('refuses a viewer 403, a stranger the shared 404 and an anonymous caller 401', async () => {
    expect((await post(cara.cookie, COMMENT)).status).toBe(403);
    expect((await post(dan.cookie, COMMENT)).status).toBe(404);
    const anonymous = await post(null, COMMENT);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ message: 'Sign in to comment' });
    const link = await insertLink(d1.db, { docId }, 'commenter');
    const holder = await post(null, COMMENT, `/api/docs/${docId}/comments?share=${link}`);
    expect(holder.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers 429 past 60 comment operations per principal per minute', async () => {
    commentTokens = 0;
    const response = await post(ben.cookie, COMMENT);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(calls).toEqual([]);
  });

  it('refuses a malformed body with 400 before the DocDO', async () => {
    for (const body of [{ text: 'no id' }, { id: 'c1' }, { id: 'c1', text: 42 }, { id: 'c1', text: 'x', anchor: 'nope' }, { id: 'bad id!', text: 'x', parentId: 'c' }]) {
      expect((await post(ben.cookie, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it.each([
    [{ ok: false, status: 409, error: 'anchor-pending' }, 409],
    [{ ok: false, status: 409, error: 'too-many-overlapping' }, 409],
    [{ ok: false, status: 413, error: 'quote-too-long' }, 413],
  ])('passes the DocDO verdict %j through', async (answer, status) => {
    verdict = answer;
    const response = await post(ben.cookie, COMMENT);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: answer.error });
  });
});

describe('POST /api/docs/:id/comments/:commentId/resolve @p:mean-1', () => {
  const resolve = (cookie: string | null, body: unknown, commentId = 'c1') => post(cookie, body, `/api/docs/${docId}/comments/${commentId}/resolve`);

  it('lets a commenter resolve and reopen a thread, as a user', async () => {
    const response = await resolve(ben.cookie, { resolved: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ comment: { id: 'c1', resolved: true } });
    expect(resolves).toEqual([{ docId, input: { id: 'c1', resolved: true, by: 'user' } }]);
    expect((await resolve(ada.cookie, { resolved: false })).status).toBe(200);
    expect(tokenAsks).toEqual([ben.id, ada.id]);
  });

  it('refuses a viewer 403, a stranger 404, an anonymous caller 401 and a bad body 400', async () => {
    expect((await resolve(cara.cookie, { resolved: true })).status).toBe(403);
    expect((await resolve(dan.cookie, { resolved: true })).status).toBe(404);
    expect((await resolve(null, { resolved: true })).status).toBe(401);
    expect((await resolve(ben.cookie, { resolved: 'yes' })).status).toBe(400);
    expect((await resolve(ben.cookie, { resolved: true }, 'bad.id')).status).toBe(400);
    expect(resolves).toEqual([]);
  });

  it('passes a missing thread through as the DocDO answers it', async () => {
    verdict = { ok: false, status: 404, error: 'comment-missing' };
    const response = await resolve(ben.cookie, { resolved: true }, 'nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'comment-missing' });
  });
});
