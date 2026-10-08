// T8.3a: the authorization scan of every /api route (A§8, A§18), table-driven over the router. For each route and
// each kind of principal that holds no access to Ada's things (no credential, a forged or ended credential, a forged
// or revoked link, a stranger by cookie, bearer or agent key, a stranger forging the trusted headers), the answer
// must be a refusal byte-identical to the answer for an id that does not exist, and no Durable Object of Ada's
// may be reached. A viewer link and Ada's own agent key are refused every write above their role. A completeness check
// fails when a route pattern in api/*.ts has no row in the table.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
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
  ids = { doc, trashed, folder: ada.homeId, vault: ada.homeId };
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
  ['POST', '/api/docs/:doc/suggestions/s1/preview', {}],
  ['POST', '/api/docs/:doc/suggestions/s1/accept', {}],
  ['POST', '/api/docs/:doc/suggestions/s1/reject', {}],
  ['POST', '/api/docs/:doc/suggestions/s1/withdraw', {}],
  ['POST', '/api/docs/:doc/push', { newText: 'x', baseHash: HASH }],
  ['POST', '/api/docs/:doc/push', { newText: 'x', baseHash: HASH, suggest: true }],
  ['GET', '/api/docs/:doc/backlinks'],
  ['GET', '/api/docs/:doc/headings'],
  ['POST', '/api/docs/:doc/assets?filename=a.png', new Uint8Array([137, 80, 78, 71])],
  ['GET', '/api/docs/:doc/assets/a.png'],
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

const request = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { ...(body instanceof Uint8Array ? { 'content-type': 'image/png' } : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });

async function answer(row: Row, target: Record<string, string>, headers: Record<string, string>) {
  const [method, template, body] = row;
  const path = template.replace(/:(doc|folder|vault)\b/g, (_, key: string) => target[key]);
  const response = await handleApi(request(method, path, headers, body), env);
  return { status: response.status, text: await response.text() };
}

/** Principal kinds that hold nothing of Ada's. */
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
  it('lists every route pattern in api/*.ts', () => {
    const dir = new URL('./', import.meta.url);
    const rows = [...DOC_ROUTES, ...FOLDER_ROUTES, ...SELF_ROUTES].map(([, path]) =>
      path.split('?')[0].replace(/:(doc|folder|vault)\b/g, MISSING));
    const missing: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      // Regex literals that anchor an /api path, and exact path strings compared against the pathname.
      for (let at = source.indexOf('/^\\/api'); at >= 0; at = source.indexOf('/^\\/api', at + 1)) {
        const end = source.indexOf('$/', at);
        const pattern = new RegExp(source.slice(at + 1, end + 1));
        if (!rows.some((path) => pattern.test(path))) missing.push(`${file}: ${pattern.source}`);
      }
      for (const [, path] of source.matchAll(/pathname === '(\/api\/[^']*)'/g)) {
        if (!rows.includes(path)) missing.push(`${file}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it.each(outsiders().map(([name], index) => [name, index] as const))(
    '%s: every doc, trash, folder and vault route refuses as for an id that does not exist',
    async (_name, index) => {
      const [, headers] = outsiders()[index];
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
      expect(leaks).toEqual([]);
      expect(reached.filter((call) => call.startsWith('DocDO:'))).toEqual([]);
    },
    120_000,
  );

  it.each(outsiders().slice(0, 9).map(([name], index) => [name, index] as const))(
    '%s: every route about the caller refuses',
    async (_name, index) => {
      const [, headers] = outsiders()[index];
      const served: string[] = [];
      for (const row of SELF_ROUTES) {
        const { status, text } = await answer(row, {}, headers);
        if (status < 400) served.push(`${row[0]} ${row[1]}: ${status} ${text.slice(0, 80)}`);
      }
      expect(served).toEqual([]);
    },
    60_000,
  );

  it('a viewer link, signed out or signed in as a stranger, is refused every write', async () => {
    const reads = new Set(['GET']);
    const served: string[] = [];
    for (const headers of [{ 'x-moss-share': viewerLink }, { 'x-moss-share': viewerLink, cookie: ben.cookie, origin: BASE }]) {
      for (const row of DOC_ROUTES.filter(([method]) => !reads.has(method))) {
        reached.length = 0;
        const { status, text } = await answer(row, { doc: ids.doc }, headers);
        if (status < 400) served.push(`${row[0]} ${row[1]}${headers.cookie ? ' signed in' : ''}: ${status} ${text.slice(0, 80)}`);
        if (reached.some((call) => call.startsWith('DocDO:'))) served.push(`${row[0]} ${row[1]}: reached ${reached.join(', ')}`);
      }
      for (const row of [['GET', '/api/docs/:doc/members'], ['GET', '/api/docs/:doc/links'], ['GET', '/api/docs/:doc/invites'], ['GET', '/api/docs/:doc/instance'], ['GET', '/api/trash/:doc']] as Row[]) {
        const { status } = await answer(row, { doc: ids.doc }, headers);
        if (status < 400) served.push(`${row[0]} ${row[1]}: ${status}`);
      }
    }
    expect(served).toEqual([]);
  }, 60_000);

  it("Ada's own agent key administers nothing: no sharing, links, trash, moves, instance or agents", async () => {
    const headers = { authorization: `Bearer ${adaKey}` };
    const admin: Row[] = [
      ['DELETE', '/api/docs/:doc'], ['PATCH', '/api/docs/:doc', { folderId: ada.homeId }], ['POST', '/api/docs/:doc/restore', {}],
      ['POST', '/api/docs/:doc/members', { email: 'x@example.invalid', role: 'editor' }], ['POST', '/api/docs/:doc/links', { role: 'editor' }],
      ['GET', '/api/docs/:doc/instance'], ['GET', '/api/trash/:doc'], ['POST', '/api/folders/:folder/links', { role: 'editor' }],
      ['DELETE', '/api/folders/:folder'], ['DELETE', '/api/vaults/:vault'], ['GET', '/api/agents'], ['POST', '/api/agents', { name: 'A' }],
    ];
    const served: string[] = [];
    for (const row of admin) {
      const { status, text } = await answer(row, { doc: ids.doc, folder: ids.folder, vault: ids.vault }, headers);
      if (status < 400) served.push(`${row[0]} ${row[1]}: ${status} ${text.slice(0, 80)}`);
    }
    expect(served).toEqual([]);
  }, 60_000);
});
