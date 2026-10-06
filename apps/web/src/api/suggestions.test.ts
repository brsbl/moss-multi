// The suggestion review REST API (BUILDPLAN T5.3; docs/design/suggestions.md §4, §4.7, §8): preview for any reader,
// accept and reject for an editor or above, withdraw for a suggester or above (the DocDO checks authorship), each
// rate-limited per principal and re-authorized by the DocDO, whose verdict passes through; the working export; and
// the bell's row for a new live suggestion, for the people who can review it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertGrant, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';
import { notifySuggestion } from './suggestions.ts';

const calls: { op: string; docId: string; input: unknown }[] = [];
let verdict: Record<string, unknown> = { ok: true };

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => {
    const record = (op: string) => async (input: unknown) => {
      calls.push({ op, docId: id.name, input });
      return op === 'preview' && verdict.ok ? { ok: true, hunks: [], hash: 'h', digest: 'd' } : verdict;
    };
    return {
      setName: async () => undefined,
      previewSuggestion: record('preview'),
      acceptSuggestion: record('accept'),
      rejectSuggestion: record('reject'),
      withdrawSuggestion: record('withdraw'),
      exportMarkdown: async (options?: unknown) => {
        calls.push({ op: 'export', docId: id.name, input: options ?? null });
        return '# working';
      },
    };
  },
};

const tokens: string[] = [];
let reviewTokens = Infinity;
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    takeReviewToken: async () => {
      tokens.push(`review:${id.name}`);
      reviewTokens -= 1;
      return reviewTokens >= 0;
    },
    takePreviewToken: async () => {
      tokens.push(`preview:${id.name}`);
      return true;
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cara: TestUser;
let dan: TestUser;
let eve: TestUser;
let docId: string;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'suggest-ada', 'Ada');
  ben = await signedUpUser(env, 'suggest-ben', 'Ben');
  cara = await signedUpUser(env, 'suggest-cara', 'Cara');
  dan = await signedUpUser(env, 'suggest-dan', 'Dan');
  eve = await signedUpUser(env, 'suggest-eve', 'Eve');
  docId = await insertDoc(d1.db, ada);
  await insertGrant(d1.db, { docId }, { id: ben.id }, 'suggester');
  await insertGrant(d1.db, { docId }, { id: cara.id }, 'viewer');
  await insertGrant(d1.db, { docId }, { id: eve.id }, 'editor');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  calls.length = 0;
  tokens.length = 0;
  reviewTokens = Infinity;
  verdict = { ok: true };
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

const path = (action: string, sid = 's1') => `/api/docs/${docId}/suggestions/${sid}/${action}`;

describe('suggestion review routes @p:mean-2 @p:R17', () => {
  it("previews for any reader, accepts and rejects for an editor or owner, withdraws for a suggester, as the caller", async () => {
    const preview = await send('GET', cara.cookie, path('preview'));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ preview: { hunks: [], hash: 'h', digest: 'd' } });
    expect((await send('POST', ada.cookie, path('accept'), { previewHash: 'h', digest: 'd' })).status).toBe(200);
    expect((await send('POST', eve.cookie, path('reject'))).status).toBe(200);
    expect((await send('POST', ben.cookie, path('withdraw'))).status).toBe(200);
    expect(calls.map(({ op, input }) => [op, (input as { reviewer: unknown }).reviewer])).toEqual([
      ['preview', { id: cara.id, role: 'viewer' }],
      ['accept', { id: ada.id, role: 'owner' }],
      ['reject', { id: eve.id, role: 'editor' }],
      ['withdraw', { id: ben.id, role: 'suggester' }],
    ]);
    expect(calls[1].input).toMatchObject({ id: 's1', previewHash: 'h', digest: 'd', actor: { kind: 'user', principalId: ada.id } });
    expect(tokens).toEqual([`preview:${cara.id}`, `review:${ada.id}`, `review:${eve.id}`, `review:${ben.id}`]);
  });

  it('refuses a suggester or viewer accepting or rejecting 403, a viewer withdrawing 403, a stranger 404 and an anonymous caller 401, before the DocDO', async () => {
    for (const who of [ben, cara]) {
      expect((await send('POST', who.cookie, path('accept'), { previewHash: 'h', digest: 'd' })).status).toBe(403);
      expect((await send('POST', who.cookie, path('reject'))).status).toBe(403);
    }
    expect((await send('POST', cara.cookie, path('withdraw'))).status).toBe(403);
    expect((await send('GET', dan.cookie, path('preview'))).status).toBe(404);
    expect((await send('POST', dan.cookie, path('accept'), { previewHash: 'h', digest: 'd' })).status).toBe(404);
    expect((await send('POST', null, path('accept'), { previewHash: 'h', digest: 'd' })).status).toBe(401);
    expect((await send('POST', ada.cookie, path('accept'), { previewHash: 7 })).status).toBe(400);
    expect((await send('POST', ada.cookie, path('accept', 'bad id!'), { previewHash: 'h', digest: 'd' })).status).toBe(400);
    expect((await send('GET', ada.cookie, path('accept'))).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it('answers 429 past the per-principal review rate', async () => {
    reviewTokens = 0;
    const response = await send('POST', ada.cookie, path('accept'), { previewHash: 'h', digest: 'd' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it.each([
    [{ ok: false, status: 409, reason: 'outdated' }, 409],
    [{ ok: false, status: 409, reason: 'changed' }, 409],
    [{ ok: false, status: 403, reason: 'role' }, 403],
    [{ ok: false, status: 404, reason: 'missing' }, 404],
  ])('passes the DocDO verdict %j through', async (answer, status) => {
    verdict = answer;
    const response = await send('POST', ada.cookie, path('accept'), { previewHash: 'h', digest: 'd' });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: answer.reason });
  });

  it('GET content?view=working exports the composite; the default export stays the clean body', async () => {
    const working = await send('GET', cara.cookie, `/api/docs/${docId}/content?view=working`);
    expect(working.status).toBe(200);
    expect(await working.text()).toBe('# working');
    await send('GET', cara.cookie, `/api/docs/${docId}/content`);
    expect(calls.map((call) => call.input)).toEqual([{ view: 'working' }, null]);
  });
});

describe('a live suggestion notifies the people who can review it @p:ppl-3 @p:mean-2', () => {
  const rows = async (userId: string) =>
    (await d1.db.prepare("SELECT type, payload_json AS payload FROM notifications WHERE user_id = ? AND type = 'suggestion'").bind(userId).all<{ type: string; payload: string }>()).results;

  it('writes a suggestion row for the owner and each editor, never the author or a viewer, and reaches the bell', async () => {
    await notifySuggestion(env, { docId, author: ben.id, record: 'r1' });
    const payload = JSON.stringify({ targetType: 'doc', targetId: docId, by: ben.id, suggestionId: 'r1' });
    expect(await rows(ada.id)).toEqual([{ type: 'suggestion', payload }]);
    expect(await rows(eve.id)).toEqual([{ type: 'suggestion', payload }]);
    expect(await rows(ben.id)).toEqual([]);
    expect(await rows(cara.id)).toEqual([]);
    const bell = await send('GET', ada.cookie, '/api/notifications');
    const notices = ((await bell.json()) as { notifications: { type: string; by: string; target: { id: string }; suggestionId?: string }[] }).notifications;
    expect(notices.find((n) => n.type === 'suggestion')).toMatchObject({ by: 'Ben', target: { id: docId }, suggestionId: 'r1' });
  });
});
