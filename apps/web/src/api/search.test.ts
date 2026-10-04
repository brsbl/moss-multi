// /api/search, /api/docs/:id/backlinks and /headings (T3.4; A§15): the Worker hands the index only the caller's
// discovery closure (A§8), so a doc the caller cannot open never comes back, whatever the index holds.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const asked: { method: string; input: Record<string, unknown> }[] = [];
const reindexed: string[] = [];
/** What the fake index holds: every doc it would match, before the Worker's permission filter. */
let hits: string[] = [];
let unindexed: string[] = [];
let linking: string[] = [];

const SearchDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({
    setName: async () => undefined,
    search: async (input: { allowedDocIds: string[] }) => {
      asked.push({ method: 'search', input });
      return { results: hits.map((docId) => ({ docId, title: 'stale', snippet: `…${docId} text…`, score: 1 })), unindexed };
    },
    backlinks: async (input: { keys: string[]; allowedDocIds: string[] }) => {
      asked.push({ method: 'backlinks', input });
      return linking.filter((id) => input.allowedDocIds.includes(id));
    },
  }),
};

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    exportMarkdown: async () => '# Plan\n\n```\n# code\n```\n\n## Risks [[Other]]\n',
    reindex: async () => { reindexed.push(id.name); },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, SearchDO: SearchDO as never };
  ada = await signedUpUser(env, 'search-ada');
  ben = await signedUpUser(env, 'search-ben', 'Ben');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  asked.length = 0;
  reindexed.length = 0;
  hits = [];
  unindexed = [];
  linking = [];
});

const get = (path: string, cookie: string | null) =>
  handleApi(new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} }), env);

async function named(owner: TestUser, title: string, filename: string, options: { deleted?: boolean } = {}): Promise<string> {
  const id = await insertDoc(d1.db, owner, options);
  await d1.db.prepare('UPDATE docs SET title = ?, filename = ? WHERE id = ?').bind(title, filename, id).run();
  return id;
}

describe('GET /api/search', () => {
  it("asks the index only about the caller's discoverable docs and names each hit from D1", async () => {
    const shared = await named(ada, 'Field notes', 'field-notes.md');
    const secret = await named(ada, 'Diary', 'diary.md');
    const trashed = await named(ben, 'Old', 'old.md', { deleted: true });
    const own = await named(ben, 'Ben list', 'ben-list.md');
    await insertGrant(d1.db, { docId: shared }, ben, 'viewer');
    hits = [secret, shared, trashed, own];
    const response = await get('/api/search?q=quokka', ben.cookie);
    expect(response.status).toBe(200);
    const { results } = await response.json() as { results: { id: string; title: string; snippet: string }[] };
    expect(results.map((hit) => hit.id)).toEqual([shared, own]);
    expect(results[0]).toMatchObject({ title: 'Field notes', snippet: `…${shared} text…` });
    const allowed = asked[0].input.allowedDocIds as string[];
    expect(allowed).toContain(shared);
    expect(allowed).not.toContain(secret);
    expect(allowed).not.toContain(trashed);
  });

  it('feeds allowed docs the index lacks, answers an empty query without the index, and 401s with no session', async () => {
    const doc = await named(ada, 'Unfed', 'unfed.md');
    unindexed = [doc];
    expect((await get('/api/search?q=x', ada.cookie)).status).toBe(200);
    await vi.waitFor(() => expect(reindexed).toEqual([doc]));
    asked.length = 0;
    expect(await (await get('/api/search?q=%20', ada.cookie)).json()).toEqual({ results: [] });
    expect(asked).toEqual([]);
    expect((await get('/api/search?q=x', null)).status).toBe(401);
  });

  it('gives a share-link holder no discovery and refuses writes', async () => {
    const doc = await named(ada, 'Linked', 'linked.md');
    const token = await insertLink(d1.db, { docId: doc }, 'viewer');
    hits = [doc];
    expect(await (await get(`/api/search?q=x&share=${token}`, null)).json()).toEqual({ results: [] });
    const post = await handleApi(new Request(`${BASE}/api/search?q=x`, { method: 'POST', headers: { cookie: ada.cookie, origin: BASE } }), env);
    expect(post.status).toBe(405);
  });
});

describe('GET /api/docs/:id/backlinks', () => {
  it("asks by the target's title key and filename stem, and returns only sources the caller can open", async () => {
    const target = await named(ada, 'Launch Plan', 'launch-plan-2.md');
    const visible = await named(ada, 'Kickoff', 'kickoff.md');
    const hidden = await named(ada, 'Private', 'private.md');
    await insertGrant(d1.db, { docId: target }, ben, 'viewer');
    await insertGrant(d1.db, { docId: visible }, ben, 'viewer');
    linking = [visible, hidden];
    const forAda = await (await get(`/api/docs/${target}/backlinks`, ada.cookie)).json() as { backlinks: { id: string; title: string }[] };
    expect(forAda.backlinks.map((link) => link.id).sort()).toEqual([visible, hidden].sort());
    expect(asked.at(-1)?.input.keys).toEqual(['launch-plan', 'launch-plan-2']);
    const forBen = await (await get(`/api/docs/${target}/backlinks`, ben.cookie)).json() as { backlinks: { id: string; title: string }[] };
    expect(forBen.backlinks).toEqual([expect.objectContaining({ id: visible, title: 'Kickoff' })]);
  });

  it('is the one 404 for a doc the caller cannot open', async () => {
    const target = await named(ada, 'Mine', 'mine.md');
    const response = await get(`/api/docs/${target}/backlinks`, ben.cookie);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not-found' });
  });
});

describe('GET /api/docs/:id/headings', () => {
  it("reads h1–h4 from the DocDO's export for a reader, a link holder included", async () => {
    const doc = await named(ada, 'Plan', 'plan.md');
    const expected = { headings: [{ level: 1, text: 'Plan' }, { level: 2, text: 'Risks Other' }] };
    expect(await (await get(`/api/docs/${doc}/headings`, ada.cookie)).json()).toEqual(expected);
    const token = await insertLink(d1.db, { docId: doc }, 'viewer');
    expect(await (await get(`/api/docs/${doc}/headings?share=${token}`, null)).json()).toEqual(expected);
    expect((await get(`/api/docs/${doc}/headings`, ben.cookie)).status).toBe(404);
  });
});
