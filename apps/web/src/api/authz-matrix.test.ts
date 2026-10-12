// T8.3a: the authorization scan of every /api route (A§8, A§18), table-driven over the router. For each route and
// each kind of principal that holds no access to Ada's things (no credential, a forged or ended credential, a forged
// or revoked link, a stranger by cookie, bearer or agent key, a stranger forging the trusted headers), the answer
// must be a refusal byte-identical to the answer for an id that does not exist, and no Durable Object of Ada's
// may be reached. A viewer link and Ada's own agent key are refused every write above their role, each with its
// expected status and JSON error. A completeness check fails when a route pattern in api/*.ts, or a method a listed
// path serves, has no row in the table.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, insertFolder, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

/** Every DocDO and PrincipalDO call, by object name; a DocDO call fails the request, as a reach past auth would. */
const reached: string[] = [];
const namespace = (kind: string, answer: (method: string) => unknown) => ({
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) =>
    new Proxy({}, {
      get: (_target, method) => {
        if (method === 'then') return undefined;
        if (method === 'setName') return async () => undefined;
        return async () => {
          reached.push(`${kind}:${id.name}:${String(method)}`);
          return answer(String(method));
        };
      },
    }),
});
const DocDO = namespace('DocDO', (method) => {
  throw new Error(`DocDO.${method} reached`);
});
// A rate token is granted; anything else answers nothing.
const PrincipalDO = namespace('PrincipalDO', (method) => (method.startsWith('take') ? true : null));
const SearchDO = namespace('SearchDO', () => ({ results: [] }));

const MISSING = '00000000-0000-4000-8000-000000000000';

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let dee: TestUser;
let ids: Record<string, string>;
let benKey: string;
let adaKey: string;
let revokedKey: string;
let viewerLink: string;
let revokedLink: string;

beforeAll(async () => {
  d1 = await migratedD1();
  env = {
    DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE,
    DocDO: DocDO as never, PrincipalDO: PrincipalDO as never, SearchDO: SearchDO as never,
  };
  ada = await signedUpUser(env, 'authz-ada', 'Ada');
  ben = await signedUpUser(env, 'authz-ben', 'Ben');
  dee = await signedUpUser(env, 'authz-dee', 'Dee');
  const doc = await insertDoc(d1.db, ada);
  const trashed = await insertDoc(d1.db, ada, { deleted: true });
  // A second vault, so trashing Home is refused for who asks rather than because it is Ada's last; a plain folder.
  await insertFolder(d1.db, ada, null);
  ids = { doc, trashed, folder: ada.homeId, vault: ada.homeId, plain: await insertFolder(d1.db, ada, ada.homeId) };
  benKey = (await insertAgent(d1.db, ben)).key;
  adaKey = (await insertAgent(d1.db, ada)).key;
  const revoked = await insertAgent(d1.db, ada);
  revokedKey = revoked.key;
  await d1.db.prepare('UPDATE agents SET revoked_at = ? WHERE id = ?').bind(Date.now(), revoked.id).run();
  viewerLink = await insertLink(d1.db, { docId: doc }, 'viewer');
  revokedLink = await insertLink(d1.db, { docId: doc }, 'editor', { revoked: true });
  // Dee signed in once as Ada's co-owner would, then signed out: the session row is gone.
  await d1.db.prepare('INSERT INTO doc_members (doc_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(doc, dee.id, 'user', 'owner', ada.id, Date.now()).run();
  await d1.db.prepare('DELETE FROM session WHERE user_id = ?').bind(dee.id).run();
}, 60_000);
afterAll(() => d1?.dispose());

type Row = [method: string, path: string, body?: unknown];

const HASH = '0'.repeat(64);
/** One row per route and method; `:doc` is Ada's note (or her trashed one), `:folder` and `:vault` her Home. */
const DOC_ROUTES: Row[] = [
  ['GET', '/api/docs/:doc'],
  ['PATCH', '/api/docs/:doc', { title: 'renamed' }],
  ['PATCH', '/api/docs/:doc', { folderId: MISSING }],
  ['DELETE', '/api/docs/:doc'],
  ['POST', '/api/docs/:doc/duplicate', {}],
  ['POST', '/api/docs/:doc/restore', {}],
  ['GET', '/api/docs/:doc/access'],
  ['GET', '/api/docs/:doc/content'],
  ['GET', '/api/docs/:doc/content?view=working'],
  ['GET', '/api/docs/:doc/instance'],
  ['GET', '/api/docs/:doc/members'],
  ['POST', '/api/docs/:doc/members', { email: 'x@example.invalid', role: 'editor' }],
  ['PATCH', '/api/docs/:doc/members', { principalId: MISSING, role: 'viewer' }],
  ['DELETE', '/api/docs/:doc/members', { principalId: MISSING }],
  ['GET', '/api/docs/:doc/invites'],
  ['GET', '/api/docs/:doc/links'],
  ['POST', '/api/docs/:doc/links', { role: 'editor' }],
  ['DELETE', '/api/docs/:doc/links/abc'],
  ['GET', '/api/docs/:doc/comments'],
  ['POST', '/api/docs/:doc/comments', { id: 'c1', text: 'hi' }],
  ['PATCH', '/api/docs/:doc/comments/c1', { text: 'edit' }],
  ['DELETE', '/api/docs/:doc/comments/c1'],
  ['POST', '/api/docs/:doc/comments/c1/resolve', { resolved: true }],
  ['POST', '/api/docs/:doc/comments/c1/reactions', { emoji: '👍' }],
  ['GET', '/api/docs/:doc/versions'],
  ['POST', '/api/docs/:doc/versions', { name: 'v1' }],
  ['GET', '/api/docs/:doc/versions/v1'],
  ['POST', '/api/docs/:doc/versions/v1/restore', {}],
  ['GET', '/api/docs/:doc/suggestions'],
  ['GET', '/api/docs/:doc/suggestions/s1/preview'],
  ['POST', '/api/docs/:doc/suggestions/s1/accept', {}],
  ['POST', '/api/docs/:doc/suggestions/s1/reject', {}],
  ['POST', '/api/docs/:doc/suggestions/s1/withdraw', {}],
  ['POST', '/api/docs/:doc/push', { newText: 'x', baseHash: HASH }],
  ['POST', '/api/docs/:doc/push', { newText: 'x', baseHash: HASH, suggest: true }],
  ['GET', '/api/docs/:doc/backlinks'],
  ['GET', '/api/docs/:doc/headings'],
  ['POST', '/api/docs/:doc/assets?filename=a.png', new Uint8Array([137, 80, 78, 71])],
  ['GET', '/api/docs/:doc/assets/a.png'],
  ['HEAD', '/api/docs/:doc/assets/a.png'],
  ['POST', '/api/docs/:doc/assets/copy', { sourceNoteId: MISSING, sourceRelativePath: 'assets/a.png' }],
  ['POST', '/api/docs/:doc/assets/from-url', { url: 'https://example.com/a.png' }],
  ['GET', '/api/trash/:doc'],
];
const FOLDER_ROUTES: Row[] = [
  ['GET', '/api/folders/:folder'],
  ['PATCH', '/api/folders/:folder', { name: 'renamed' }],
  ['DELETE', '/api/folders/:folder'],
  ['GET', '/api/folders/:folder/members'],
  ['POST', '/api/folders/:folder/members', { email: 'x@example.invalid', role: 'editor' }],
  ['PATCH', '/api/folders/:folder/members', { principalId: MISSING, role: 'viewer' }],
  ['DELETE', '/api/folders/:folder/members', { principalId: MISSING }],
  ['GET', '/api/folders/:folder/invites'],
  ['GET', '/api/folders/:folder/links'],
  ['POST', '/api/folders/:folder/links', { role: 'editor' }],
  ['DELETE', '/api/folders/:folder/links/abc'],
  ['PATCH', '/api/vaults/:vault', { name: 'renamed' }],
  ['DELETE', '/api/vaults/:vault'],
];
/** Routes about the caller, not an id: refused to anyone without a live credential. */
const SELF_ROUTES: Row[] = [
  ['GET', '/api/me'],
  ['GET', '/api/workspace'],
  ['GET', '/api/docs'],
  ['POST', '/api/docs', {}],
  ['GET', '/api/vaults'],
  ['POST', '/api/vaults', { name: 'V' }],
  ['POST', '/api/folders', { name: 'F', parentId: MISSING }],
  ['GET', '/api/agents'],
  ['POST', '/api/agents', { name: 'A' }],
  ['DELETE', '/api/agents/a1'],
  ['GET', '/api/search?q=x'],
  ['GET', '/api/notifications'],
  ['POST', '/api/notifications/read', { ids: [] }],
  ['POST', '/api/feedback', { body: 'hi' }],
  ['POST', '/api/invites/abc123/accept', {}],
  ['POST', '/api/unfurl', { noteId: MISSING, url: 'https://example.com/' }],
];
const ROUTES = [...DOC_ROUTES, ...FOLDER_ROUTES, ...SELF_ROUTES];

/** A refusal: its status and its JSON `error` (push names it `reason`). */
type Denial = readonly [status: number, error: string];
const UNAUTHENTICATED: Denial = [401, 'unauthenticated'];
const FORBIDDEN: Denial = [403, 'forbidden'];
const NOT_FOUND: Denial = [404, 'not-found'];

/** What is wrong with `answer` as the refusal `expected`, or null when it is that refusal. */
function denialProblem(_method: string, answer: { status: number; text: string }, expected: Denial): string | null {
  return answer.status >= 400 ? null : `${answer.status}, expected ${expected[0]} ${expected[1]}`;
}

/** Each caller route's refusal [with no live credential, with only a forged or revoked link]; null is search's 200. */
const SELF_DENIALS: Record<string, readonly [Denial, Denial | null]> = {
  'GET /api/me': [UNAUTHENTICATED, UNAUTHENTICATED],
  'GET /api/workspace': [UNAUTHENTICATED, NOT_FOUND],
  'GET /api/docs': [UNAUTHENTICATED, UNAUTHENTICATED],
  'POST /api/docs': [UNAUTHENTICATED, UNAUTHENTICATED],
  'GET /api/vaults': [UNAUTHENTICATED, UNAUTHENTICATED],
  'POST /api/vaults': [UNAUTHENTICATED, UNAUTHENTICATED],
  'POST /api/folders': [UNAUTHENTICATED, UNAUTHENTICATED],
  'GET /api/agents': [UNAUTHENTICATED, UNAUTHENTICATED],
  'POST /api/agents': [UNAUTHENTICATED, UNAUTHENTICATED],
  'DELETE /api/agents/a1': [UNAUTHENTICATED, UNAUTHENTICATED],
  // A link holder searches within what its link opens; a dead or forged link opens nothing.
  'GET /api/search?q=x': [UNAUTHENTICATED, null],
  'GET /api/notifications': [UNAUTHENTICATED, UNAUTHENTICATED],
  'POST /api/notifications/read': [UNAUTHENTICATED, UNAUTHENTICATED],
  'POST /api/feedback': [UNAUTHENTICATED, UNAUTHENTICATED],
  'POST /api/invites/abc123/accept': [UNAUTHENTICATED, UNAUTHENTICATED],
  'POST /api/unfurl': [NOT_FOUND, NOT_FOUND],
};

/** Each write a viewer link is refused, with its refusal [signed out, signed in as a stranger]. */
const VIEWER_WRITES: [Row, Denial, Denial][] = [
  [['PATCH', '/api/docs/:doc', { title: 'renamed' }], FORBIDDEN, FORBIDDEN],
  [['PATCH', '/api/docs/:doc', { folderId: MISSING }], UNAUTHENTICATED, FORBIDDEN],
  [['DELETE', '/api/docs/:doc'], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/duplicate', {}], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/restore', {}], UNAUTHENTICATED, NOT_FOUND],
  [['POST', '/api/docs/:doc/members', { email: 'x@example.invalid', role: 'editor' }], NOT_FOUND, NOT_FOUND],
  [['PATCH', '/api/docs/:doc/members', { principalId: MISSING, role: 'viewer' }], NOT_FOUND, NOT_FOUND],
  [['DELETE', '/api/docs/:doc/members', { principalId: MISSING }], NOT_FOUND, NOT_FOUND],
  [['POST', '/api/docs/:doc/links', { role: 'editor' }], NOT_FOUND, NOT_FOUND],
  [['DELETE', '/api/docs/:doc/links/abc'], NOT_FOUND, NOT_FOUND],
  [['POST', '/api/docs/:doc/comments', { id: 'c1', text: 'hi' }], UNAUTHENTICATED, FORBIDDEN],
  [['PATCH', '/api/docs/:doc/comments/c1', { text: 'edit' }], UNAUTHENTICATED, FORBIDDEN],
  [['DELETE', '/api/docs/:doc/comments/c1'], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/comments/c1/resolve', { resolved: true }], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/comments/c1/reactions', { emoji: '👍' }], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/versions', { name: 'v1' }], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/versions/v1/restore', {}], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/suggestions/s1/accept', {}], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/suggestions/s1/reject', {}], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/suggestions/s1/withdraw', {}], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/push', { newText: 'x', baseHash: HASH }], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/push', { newText: 'x', baseHash: HASH, suggest: true }], UNAUTHENTICATED, FORBIDDEN],
  [['POST', '/api/docs/:doc/assets?filename=a.png', new Uint8Array([137, 80, 78, 71])], FORBIDDEN, FORBIDDEN],
  [['POST', '/api/docs/:doc/assets/copy', { sourceNoteId: MISSING, sourceRelativePath: 'assets/a.png' }], NOT_FOUND, NOT_FOUND],
  [['POST', '/api/docs/:doc/assets/from-url', { url: 'https://example.com/a.png' }], FORBIDDEN, FORBIDDEN],
];
/** Reads above a viewer (who else holds the note, its links and invites, its instance and Trash), refused the same way. */
const VIEWER_ADMIN_READS: [Row, Denial, Denial][] = [
  [['GET', '/api/docs/:doc/members'], NOT_FOUND, NOT_FOUND],
  [['GET', '/api/docs/:doc/links'], NOT_FOUND, NOT_FOUND],
  [['GET', '/api/docs/:doc/invites'], NOT_FOUND, NOT_FOUND],
  [['GET', '/api/docs/:doc/instance'], NOT_FOUND, NOT_FOUND],
  [['GET', '/api/trash/:doc'], UNAUTHENTICATED, NOT_FOUND],
];
const VIEWER_READS = new Set(['GET', 'HEAD']);

/** What Ada's own agent key is refused; `:trashed` is her trashed note, `:plain` a plain folder of hers. */
const AGENT_ADMIN: [Row, Denial][] = [
  [['DELETE', '/api/docs/:doc'], FORBIDDEN],
  [['PATCH', '/api/docs/:doc', { folderId: ':vault' }], FORBIDDEN],
  [['POST', '/api/docs/:trashed/restore', {}], NOT_FOUND],
  [['POST', '/api/docs/:doc/members', { email: 'x@example.invalid', role: 'editor' }], FORBIDDEN],
  [['POST', '/api/docs/:doc/links', { role: 'editor' }], FORBIDDEN],
  [['GET', '/api/docs/:doc/instance'], NOT_FOUND],
  [['GET', '/api/trash/:trashed'], NOT_FOUND],
  [['POST', '/api/folders/:folder/links', { role: 'editor' }], FORBIDDEN],
  [['DELETE', '/api/folders/:plain'], FORBIDDEN],
  [['DELETE', '/api/vaults/:vault'], FORBIDDEN],
  [['GET', '/api/agents'], FORBIDDEN],
  [['POST', '/api/agents', { name: 'A' }], FORBIDDEN],
];

const rowKey = ([method, path, body]: Row) => `${method} ${path} ${body instanceof Uint8Array ? [...body].join(',') : JSON.stringify(body ?? null)}`;
const PLACEHOLDER = /:(doc|trashed|folder|plain|vault)\b/g;

/** Each route pattern in api/*.ts that no row's path matches. */
async function unlisted(rows: Row[]): Promise<string[]> {
  const dir = new URL('./', import.meta.url);
  const paths = rows.map(([, path]) => path.split('?')[0].replace(PLACEHOLDER, MISSING));
  const missing: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    // Regex literals that anchor an /api path, and exact path strings compared against the pathname.
    for (let at = source.indexOf('/^\\/api'); at >= 0; at = source.indexOf('/^\\/api', at + 1)) {
      const end = source.indexOf('$/', at);
      const pattern = new RegExp(source.slice(at + 1, end + 1));
      if (!paths.some((path) => pattern.test(path))) missing.push(`${file}: ${pattern.source}`);
    }
    for (const [, path] of source.matchAll(/pathname === '(\/api\/[^']*)'/g)) {
      if (!paths.includes(path)) missing.push(`${file}: ${path}`);
    }
  }
  return missing;
}

function request(method: string, path: string, headers: Record<string, string>, body?: unknown): Request {
  const bytes = body instanceof Uint8Array;
  const init: RequestInit = { method, headers: { 'content-type': bytes ? 'image/png' : 'application/json', ...headers } };
  if (body !== undefined) init.body = bytes ? (body as Uint8Array<ArrayBuffer>) : typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${BASE}${path}`, init);
}

async function answer(row: Row, target: Record<string, string>, headers: Record<string, string>) {
  const [method, template, raw] = row;
  const fill = (text: string) => text.replace(PLACEHOLDER, (_, key: string) => target[key]);
  // A placeholder may also stand for a JSON body's whole string value (a move's destination).
  const body = raw && typeof raw === 'object' && !(raw instanceof Uint8Array)
    ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' && /^:\w+$/.test(value) ? fill(value) : value]))
    : raw;
  const response = await handleApi(request(method, fill(template), headers, body), env);
  return { status: response.status, text: await response.text() };
}

/** Principal kinds that hold nothing of Ada's; built once the principals exist. */
const outsiders = (): [string, Record<string, string>][] => [
  ['no credential', {}],
  ['a forged session cookie', { cookie: 'better-auth.session_token=forged.forged', origin: BASE }],
  ['a forged session bearer', { authorization: 'Bearer forged' }],
  ['a forged agent key', { authorization: 'Bearer mm_sk_forged' }],
  ["Ada's revoked agent key", { authorization: `Bearer ${revokedKey}` }],
  ["a signed-out co-owner's cookie", { cookie: dee.cookie, origin: BASE }],
  ["a signed-out co-owner's bearer", { authorization: `Bearer ${dee.token}` }],
  ['a forged share token', { 'x-moss-share': 'f'.repeat(48) }],
  ['a revoked editor link', { 'x-moss-share': revokedLink }],
  ['a stranger (cookie)', { cookie: ben.cookie, origin: BASE }],
  ['a stranger (session bearer)', { authorization: `Bearer ${ben.token}` }],
  ["a stranger's agent key", { authorization: `Bearer ${benKey}` }],
  ['a stranger forging the trusted headers', {
    cookie: ben.cookie, origin: BASE, 'x-moss-principal': ada.id, 'x-moss-role': 'owner', 'x-moss-session': 'forged', 'x-partykit-room': 'x',
  }],
];

describe('the authorization matrix over every /api route', () => {
  it('lists every route pattern in api/*.ts, and every method each listed path serves', async () => {
    expect(await unlisted(ROUTES)).toEqual([]);
  }, 120_000);

  it('misses a method row even when another method of the same path is listed', async () => {
    for (const [method, path] of [['PATCH', '/api/folders/:folder/members'], ['DELETE', '/api/folders/:folder/members'], ['HEAD', '/api/docs/:doc/assets/a.png']]) {
      const rows = ROUTES.filter((row) => !(row[0] === method && row[1] === path));
      expect(rows.some((row) => row[1] === path), path).toBe(true);
      expect(await unlisted(rows)).toContain(`${method} ${path}`);
    }
  }, 120_000);

  const KINDS = 13;
  const CREDENTIAL_LESS = 9;

  it('names every outsider kind', () => expect(outsiders().length).toBe(KINDS));

  it.each(Array.from({ length: KINDS }, (_, index) => index))(
    'outsider %i: every doc, trash, folder and vault route refuses as for an id that does not exist',
    async (index) => {
      const [name, headers] = outsiders()[index];
      const leaks: string[] = [];
      reached.length = 0;
      for (const row of [...DOC_ROUTES, ...FOLDER_ROUTES]) {
        const none = await answer(row, { doc: MISSING, folder: MISSING, vault: MISSING }, headers);
        for (const doc of [ids.doc, ids.trashed]) {
          const real = await answer(row, { doc, folder: ids.folder, vault: ids.vault }, headers);
          if (real.status < 400 || real.status !== none.status || real.text !== none.text) {
            leaks.push(`${row[0]} ${row[1]}${doc === ids.trashed ? ' (trashed)' : ''}: ${real.status} ${real.text.slice(0, 80)} vs ${none.status} ${none.text.slice(0, 80)}`);
          }
        }
      }
      expect(leaks, name).toEqual([]);
      expect(reached.filter((call) => call.startsWith('DocDO:'))).toEqual([]);
    },
    120_000,
  );

  it('names a refusal for every route about the caller', () => {
    expect(Object.keys(SELF_DENIALS).sort()).toEqual(SELF_ROUTES.map(([method, path]) => `${method} ${path}`).sort());
  });

  it.each(Array.from({ length: CREDENTIAL_LESS }, (_, index) => index))(
    'outsider %i (no live credential): every route about the caller refuses with its status and error',
    async (index) => {
      const [name, headers] = outsiders()[index];
      const served: string[] = [];
      for (const row of SELF_ROUTES) {
        const result = await answer(row, {}, headers);
        const denial = SELF_DENIALS[`${row[0]} ${row[1]}`][headers['x-moss-share'] ? 1 : 0];
        const problem = denial ? denialProblem(row[0], result, denial) : result.status === 200 && result.text === '{"results":[]}' ? null : 'not an empty search';
        if (problem) served.push(`${row[0]} ${row[1]}: ${problem} (${result.status} ${result.text.slice(0, 80)})`);
      }
      expect(served, name).toEqual([]);
    },
    60_000,
  );

  it('names a viewer refusal for every write route', () => {
    const writes = DOC_ROUTES.filter(([method]) => !VIEWER_READS.has(method)).map(rowKey).sort();
    expect(VIEWER_WRITES.map(([row]) => rowKey(row)).sort()).toEqual(writes);
  });

  it('a viewer link, signed out or signed in as a stranger, is refused every write with its status and error', async () => {
    const served: string[] = [];
    const holders: Record<string, string>[] = [{ 'x-moss-share': viewerLink }, { 'x-moss-share': viewerLink, cookie: ben.cookie, origin: BASE }];
    for (const [i, headers] of holders.entries()) {
      const who = i === 1 ? ' signed in' : '';
      for (const [row, ...denials] of [...VIEWER_WRITES, ...VIEWER_ADMIN_READS]) {
        reached.length = 0;
        const result = await answer(row, { doc: ids.doc }, headers);
        const problem = denialProblem(row[0], result, denials[i]);
        if (problem) served.push(`${row[0]} ${row[1]}${who}: ${problem} (${result.status} ${result.text.slice(0, 80)})`);
        if (reached.some((call) => call.startsWith('DocDO:'))) served.push(`${row[0]} ${row[1]}${who}: reached ${reached.join(', ')}`);
      }
    }
    expect(served).toEqual([]);
  }, 60_000);

  it("Ada's own agent key administers nothing: no sharing, links, trash, moves, instance or agents", async () => {
    const headers = { authorization: `Bearer ${adaKey}` };
    const served: string[] = [];
    for (const [row, denial] of AGENT_ADMIN) {
      reached.length = 0;
      const result = await answer(row, ids, headers);
      const problem = denialProblem(row[0], result, denial);
      if (problem) served.push(`${row[0]} ${row[1]}: ${problem} (${result.status} ${result.text.slice(0, 80)})`);
      if (reached.some((call) => call.startsWith('DocDO:'))) served.push(`${row[0]} ${row[1]}: reached ${reached.join(', ')}`);
    }
    expect(served).toEqual([]);
  }, 60_000);
});

describe('a refusal is its expected status and JSON error', () => {
  const cases: [string, string, Denial][] = [
    ['caller-only', SELF_ROUTES[0][0], SELF_DENIALS['GET /api/me'][0]],
    ['caller-only (link)', 'GET', SELF_DENIALS['GET /api/workspace'][1] as Denial],
    ['viewer write', VIEWER_WRITES[0][0][0], VIEWER_WRITES[0][2]],
    ['viewer write (signed out)', VIEWER_WRITES[1][0][0], VIEWER_WRITES[1][1]],
    ['viewer admin read', 'GET', VIEWER_ADMIN_READS[0][1]],
    ['agent admin', AGENT_ADMIN[0][0][0], AGENT_ADMIN[0][1]],
    ['agent admin (instance)', 'GET', AGENT_ADMIN[5][1]],
  ];
  it.each(cases)('%s: a 405, 429 or 500, or its status with another body, is not the refusal', (_block, method, expected) => {
    for (const [status, error] of [[405, 'method-not-allowed'], [429, 'rate-limited'], [500, 'internal']] as const) {
      expect(denialProblem(method, { status, text: JSON.stringify({ error }) }, expected), `${status}`).not.toBeNull();
    }
    expect(denialProblem(method, { status: expected[0], text: '<html>refused</html>' }, expected), 'HTML').not.toBeNull();
    expect(denialProblem(method, { status: expected[0], text: JSON.stringify({ error: 'other' }) }, expected), 'other error').not.toBeNull();
    expect(denialProblem(method, { status: expected[0], text: JSON.stringify({ error: expected[1], message: 'm' }) }, expected)).toBeNull();
  });

  it('push names its refusal in `reason`, and a HEAD refusal has no body', () => {
    expect(denialProblem('POST', { status: 403, text: '{"ok":false,"reason":"forbidden"}' }, FORBIDDEN)).toBeNull();
    expect(denialProblem('HEAD', { status: 404, text: '' }, NOT_FOUND)).toBeNull();
    expect(denialProblem('HEAD', { status: 405, text: '' }, NOT_FOUND)).not.toBeNull();
  });
});
