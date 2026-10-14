// Every route that reads a JSON body caps it (T3.S7; A§18): a body that declares more than its route's cap is refused
// with 413 before a byte is read, and one that streams past the cap without declaring a length is refused as it passes
// it, never buffered further. Uploads stream with their own bounds (assets.test.ts); the largest note creation runs
// through the real DocDO in body-cap.harness.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREATE_BODY_MAX_BYTES, MARKDOWN_CAP_BYTES, STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { PayloadDocs } from '@moss-multi/sync/payload-docs';
import { captureRestoreBase } from '@moss-multi/sync/restore-base';
import * as Y from 'yjs';
import { handleAuthRoute } from '../auth/route.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { COMMENT_BODY_MAX_BYTES } from './comments.ts';
import { setRemoteFetchForTests } from './remote.ts';
import { JSON_BODY_MAX_BYTES } from './respond.ts';
import { RESTORE_BODY_MAX_BYTES } from './versions.ts';
import { handleApi } from './router.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);

/** Each DocDO create's arguments, by doc id. */
const created = new Map<string, unknown>();
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined, recheck: async () => ({ closed: 0 }), renameTitle: async () => undefined,
    create: async (init: unknown) => { created.set(id.name, init); },
    createComment: async ({ id: commentId }: { id: string }) => ({ ok: true, id: commentId, quote: null }),
    editComment: async () => ({ ok: true }), resolveComment: async () => ({ ok: true }), reactComment: async () => ({ ok: true }),
    acceptSuggestion: async () => ({ ok: true }), rejectSuggestion: async () => ({ ok: true }), withdrawSuggestion: async () => ({ ok: true }),
    saveVersion: async () => ({ ok: true, version: { id: 'v-cap' } }), restoreVersion: async () => ({ ok: true, restorePoint: 'p-cap', version: 'a-cap' }),
  }),
};
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({
    setName: async () => undefined, publish: async () => undefined, takeCreateToken: async () => true,
    takeWriteToken: async () => true, takeUploadToken: async () => true, takeFetchToken: async () => true,
    takeCommentToken: async () => true, takeReviewToken: async () => true, takeVersionToken: async () => true,
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let docId: string;
let sourceId: string;
let folderId: string;

/** The remote pages the unfurl and from-url controls fetch, behind a fake DNS that answers a public address. */
const REMOTE: Record<string, () => Response> = {
  'https://site.example/': () => new Response('<html><head><meta property="og:title" content="Capped"></head></html>', { headers: { 'content-type': 'text/html' } }),
  'https://img.example/cat.png': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
};

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'body-cap', 'Ada');
  docId = await insertDoc(d1.db, ada);
  folderId = await insertFolder(d1.db, ada, ada.homeId);
  sourceId = await insertDoc(d1.db, ada, { folderId });
  setRemoteFetchForTests({
    fetch: (async (input: RequestInfo | URL) => {
      const page = REMOTE[String(input)];
      if (!page) throw new Error(`unexpected fetch ${String(input)}`);
      return page();
    }) as typeof fetch,
    resolve: async (host) => (host.endsWith('.example') ? ['93.184.215.14'] : []),
  });
  // The copy control's source: a file placed in another note.
  const uploaded = await handleApi(new Request(`${BASE}/api/docs/${sourceId}/assets?filename=source.png`, {
    method: 'POST',
    headers: { origin: BASE, cookie: ada.cookie, 'content-type': 'image/png', 'content-length': String(PNG.byteLength) },
    body: PNG,
  }), env);
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
}, 60_000);
afterAll(() => {
  setRemoteFetchForTests(null);
  d1?.dispose();
});

const FEEDBACK_BODY_MAX_BYTES = 128 * 1024;

interface Route {
  method: string;
  path: () => string;
  cap: number;
  error: string;
  /** A body the route accepts, and the success status it answers it with. */
  ok: () => unknown;
  status: number;
  /** State a refused body must leave as it was and the accepted one changes. */
  state?: () => Promise<unknown>;
}

const DOC_INVITE = 'mm-t3s7-cap@example.invalid';
const FOLDER_INVITE = 'mm-t3s7-folder@example.invalid';
const folderInvite = () => d1.db.prepare("SELECT role, revoked_at FROM invites WHERE target_type = 'folder' AND target_id = ?1 AND email = ?2")
  .bind(folderId, FOLDER_INVITE).all().then((r) => r.results);

/** Every route that reads a JSON body, a body it accepts and its status, and the 413 error past its cap. In order. */
const ROUTES: Route[] = [
  { method: 'POST', path: () => '/api/docs', cap: CREATE_BODY_MAX_BYTES, error: 'doc-cap', ok: () => ({ title: 'Fine' }), status: 201 },
  { method: 'PATCH', path: () => `/api/docs/${docId}`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ title: 'Renamed' }), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: DOC_INVITE, role: 'viewer' }), status: 201 },
  { method: 'PATCH', path: () => `/api/docs/${docId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: DOC_INVITE, role: 'editor' }), status: 200 },
  { method: 'DELETE', path: () => `/api/docs/${docId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: DOC_INVITE }), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/links`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ role: 'viewer' }), status: 201 },
  { method: 'POST', path: () => `/api/docs/${docId}/assets/copy`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ sourceNoteId: sourceId, sourceRelativePath: 'assets/source.png' }), status: 201 },
  { method: 'POST', path: () => `/api/docs/${docId}/assets/from-url`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ url: 'https://img.example/cat.png' }), status: 201 },
  { method: 'POST', path: () => '/api/folders', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ parentId: ada.homeId, name: 'Capped' }), status: 201 },
  { method: 'PATCH', path: () => `/api/folders/${folderId}`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Renamed folder' }), status: 200 },
  { method: 'POST', path: () => `/api/folders/${folderId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: FOLDER_INVITE, role: 'viewer' }), status: 201, state: folderInvite },
  { method: 'PATCH', path: () => `/api/folders/${folderId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: FOLDER_INVITE, role: 'editor' }), status: 200, state: folderInvite },
  { method: 'DELETE', path: () => `/api/folders/${folderId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: FOLDER_INVITE }), status: 200, state: folderInvite },
  { method: 'POST', path: () => `/api/folders/${folderId}/links`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ role: 'viewer' }), status: 201 },
  { method: 'POST', path: () => '/api/vaults', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Capped vault' }), status: 201 },
  { method: 'PATCH', path: () => `/api/vaults/${ada.homeId}`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Home again' }), status: 200 },
  { method: 'POST', path: () => '/api/agents', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Scribe' }), status: 201 },
  { method: 'POST', path: () => '/api/notifications/read', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ ids: [] }), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/comments`, cap: COMMENT_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ id: 'c-ok', text: 'Fine' }), status: 201 },
  { method: 'PATCH', path: () => `/api/docs/${docId}/comments/c-ok`, cap: COMMENT_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ text: 'Edited' }), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/comments/c-ok/resolve`, cap: COMMENT_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ resolved: true }), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/comments/c-ok/reactions`, cap: COMMENT_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ emoji: '👍', on: true }), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/suggestions/s-cap/accept`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ previewHash: 'h'.repeat(64), digest: 'd'.repeat(64) }), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/suggestions/s-cap/reject`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({}), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/suggestions/s-cap/withdraw`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({}), status: 200 },
  { method: 'POST', path: () => `/api/docs/${docId}/versions`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Checkpoint' }), status: 201 },
  { method: 'POST', path: () => `/api/docs/${docId}/versions/v-cap/restore`, cap: RESTORE_BODY_MAX_BYTES, error: 'too-large', ok: () => ({}), status: 200 },
  { method: 'POST', path: () => '/api/unfurl', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ noteId: docId, url: 'https://site.example/' }), status: 200 },
  { method: 'POST', path: () => '/api/feedback', cap: FEEDBACK_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ body: 'Lovely.' }), status: 201 },
];

/** A body that fails the request if anything reads it. */
const unreadable = () => new ReadableStream<Uint8Array>({ pull() { throw new Error('the body was read'); } });

/**
 * A body of spaces with no declared length, longer than `cap`, that counts what is pulled and fails the request if it
 * is read more than two chunks past the cap (the reader's one chunk plus the stream's one queued ahead).
 */
function endless(cap: number) {
  const chunk = Math.max(16 * 1024, Math.ceil(cap / 64));
  const read = { bytes: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (read.bytes > cap + 2 * chunk) throw new Error('the body was read past its cap');
      read.bytes += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(0x20));
    },
  });
  return { stream, read, limit: cap + 2 * chunk };
}

const send = (route: Route, body: BodyInit, headers: Record<string, string> = {}) => handleApi(new Request(`${BASE}${route.path()}`, {
  method: route.method,
  headers: { origin: BASE, cookie: ada.cookie, 'content-type': 'application/json', ...headers },
  body,
  ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
} as RequestInit), env);

async function expectRefused(response: Response, error: string): Promise<void> {
  const text = await response.text();
  expect(response.status, text).toBe(413);
  expect((JSON.parse(text) as { error: string }).error).toBe(error);
}

describe('JSON bodies are capped on every route that reads one', () => {
  for (const route of ROUTES) {
    const name = `${route.method} ${route.path.toString().replace(/^\(\) => /, '').replaceAll('`', '')}`;

    it(`${name}: a declared length over the cap is refused with 413 before a byte is read`, async () => {
      const before = await route.state?.();
      await expectRefused(await send(route, unreadable(), { 'content-length': String(route.cap + 1) }), route.error);
      expect(await route.state?.(), 'a refused body changes nothing').toEqual(before);
    }, 30_000);

    it(`${name}: an undeclared body that runs past the cap is refused with 413, read no further`, async () => {
      const before = await route.state?.();
      const { stream, read, limit } = endless(route.cap);
      await expectRefused(await send(route, stream), route.error);
      expect(read.bytes, 'read no further than the cap').toBeLessThanOrEqual(limit);
      expect(await route.state?.(), 'a refused body changes nothing').toEqual(before);
    }, 60_000);

    it(`${name}: a body of ordinary size succeeds with ${route.status}`, async () => {
      const before = await route.state?.();
      const response = await send(route, JSON.stringify(route.ok()));
      expect(response.status, await response.text()).toBe(route.status);
      if (route.state) expect(await route.state(), 'the accepted body is applied').not.toEqual(before);
    }, 30_000);
  }

  it('POST /api/docs seeds the DocDO with the title its ordinary body named', () => {
    expect([...created.values()]).toContainEqual(expect.objectContaining({ title: 'Fine' }));
  });

  it('the feedback cap takes the longest message the dialog sends, every character escaped', async () => {
    const sent = JSON.stringify({ body: '\u0001'.repeat(10_000), page: '\u0001'.repeat(2_000) });
    expect(sent.length, 'longer than the default cap').toBeGreaterThan(JSON_BODY_MAX_BYTES);
    const response = await send(ROUTES.at(-1)!, sent);
    expect(response.status, await response.clone().text()).toBe(201);
  }, 30_000);

  // T4.R2: T3.S7's caps must refuse no comment body the DocDO accepts (comments.ts: 10,000 characters of text and of
  // quote), whatever a client escapes.
  const comment = (method: string, path: string, body: string) => send({ method, path: () => path, cap: 0, error: '', ok: () => ({}), status: 0 }, body);

  it('a comment create takes the longest text and quote, every character escaped', async () => {
    const sent = JSON.stringify({ id: 'c-cap', text: '\u0001'.repeat(10_000), anchor: { quote: { exact: '\u0001'.repeat(10_000), prefix: '', suffix: '' } } });
    expect(sent.length, 'longer than the default cap').toBeGreaterThan(JSON_BODY_MAX_BYTES);
    const response = await comment('POST', `/api/docs/${docId}/comments`, sent);
    expect(response.status, await response.clone().text()).toBe(201);
  }, 30_000);

  // T5.R2: an accept names the previewed hash and digest (each at most 128 characters), far under the default cap.
  it('a suggestion accept takes the longest hash and digest it accepts', async () => {
    const sent = JSON.stringify({ previewHash: 'h'.repeat(128), digest: 'd'.repeat(128) });
    const response = await comment('POST', `/api/docs/${docId}/suggestions/s-cap/accept`, sent);
    expect(response.status, await response.clone().text()).toBe(200);
  }, 30_000);

  // T6.R: a restore carries its base, the state vectors of the note and of every payload the restorer held (A§14),
  // captured by captureRestoreBase. Each session's payload doc writes under its own random 32-bit client id, so a
  // payload's vector grows by about six bytes for every session that ever wrote it; nothing bounds that count.
  const writtenBy = (sessions: number, first = 0xf000_0000): Y.Doc => {
    // Each session writes on its own and the doc takes them merged, as a server would hold them.
    const updates: Uint8Array[] = [];
    for (let s = 0; s < sessions; s += 1) {
      const session = new Y.Doc();
      session.clientID = first + s;
      session.getMap('m').set(String(s), 1);
      updates.push(Y.encodeStateAsUpdate(session));
      session.destroy();
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.mergeUpdates(updates));
    return doc;
  };
  const captured = (note: Y.Doc, payload: Y.Doc, ids: number, idLength: number) => {
    const held = new PayloadDocs();
    // One real doc held under every id: its vector is captured as each payload's would be.
    for (let i = 0; i < ids; i += 1) held.docs.set(i.toString(16).padStart(idLength, '0'), payload);
    return captureRestoreBase(note, held);
  };
  const decoded = (base: { note: string; payloads: Record<string, string> }) =>
    [base.note, ...Object.values(base.payloads)].reduce((sum, sv) => sum + Buffer.from(sv, 'base64').byteLength, 0);

  it('a restore takes a captured base of 10,000 payloads, each written by 105 sessions', async () => {
    const base = captured(writtenBy(1), writtenBy(105), 10_000, 32);
    const sent = JSON.stringify({ base: { ...base, age: 599_999 } });
    expect(sent.length, 'past a cap that assumed 64 writers a payload').toBeGreaterThan(8_571_072);
    const response = await comment('POST', `/api/docs/${docId}/versions/v-cap/restore`, sent);
    expect(response.status, await response.clone().text()).toBe(200);
  }, 120_000);

  // A state vector never encodes longer than the state it describes (restore-base.test.ts), and every entry point holds
  // a note and its payloads to STATE_CAP_BYTES together (A§5.1). So no honest base's vectors decode past that cap.
  it('a restore takes a base whose vectors decode to the whole state cap, with the longest ids', async () => {
    const note = writtenBy(20_000, 0xe000_0000);
    const noteBytes = Y.encodeStateVector(note).byteLength;
    const each = Math.floor((STATE_CAP_BYTES - noteBytes) / 10_000);
    const payload = writtenBy(Math.floor((each - 3) / 6));
    const base = captured(note, payload, 10_000, 64);
    expect(base.note.length, 'one vector far past 64 KiB').toBeGreaterThan(65_536 * 2);
    expect(decoded(base)).toBeLessThanOrEqual(STATE_CAP_BYTES);
    expect(decoded(base)).toBeGreaterThan(STATE_CAP_BYTES - 10_000 * 6);
    const sent = JSON.stringify({ base: { ...base, age: 599_999 } });
    expect(sent.length, 'under the restore cap').toBeLessThanOrEqual(RESTORE_BODY_MAX_BYTES);
    const response = await comment('POST', `/api/docs/${docId}/versions/v-cap/restore`, sent);
    expect(response.status, await response.clone().text()).toBe(200);
  }, 120_000);

  it('a restore past its write budget is refused 429 before its body is read', async () => {
    const read = { pulled: false };
    // No queue ahead: the stream is pulled only when something reads it.
    const body = new ReadableStream<Uint8Array>({ pull(controller) { read.pulled = true; controller.close(); } }, { highWaterMark: 0 });
    const spent = { ...env, PrincipalDO: { ...PrincipalDO, get: () => ({ ...PrincipalDO.get(), takeWriteToken: async () => false }) } as never };
    const response = await handleApi(new Request(`${BASE}/api/docs/${docId}/versions/v-cap/restore`, {
      method: 'POST', headers: { origin: BASE, cookie: ada.cookie, 'content-type': 'application/json' }, body, duplex: 'half',
    } as RequestInit), spent);
    expect(response.status).toBe(429);
    expect(read.pulled, 'the body was not read').toBe(false);
  }, 30_000);

  it('a named save takes the longest name, every character escaped', async () => {
    const response = await comment('POST', `/api/docs/${docId}/versions`, JSON.stringify({ name: '\u0001'.repeat(80) }));
    expect(response.status, await response.clone().text()).toBe(201);
  }, 30_000);

  it('note creation takes 2 MB of markdown, every byte escaped, with a full comments sidecar', async () => {
    const markdown = '\u0001'.repeat(MARKDOWN_CAP_BYTES - 1024);
    const comments = { version: 1, comments: { c1: { text: '\u0001'.repeat(Math.floor((MARKDOWN_CAP_BYTES - 1024) / 6)) } } };
    const sent = JSON.stringify({ title: 'Imported', markdown, comments });
    expect(sent.length, 'longer than a body of markdown alone').toBeGreaterThan(MARKDOWN_CAP_BYTES * 6 + 64 * 1024);
    const status = await send(ROUTES[0]!, sent).then((r) => r.status, () => 500);
    expect(status).not.toBe(413);
  }, 60_000);
});

describe('auth bodies are capped before better-auth reads them', () => {
  const auth = (path: string, body: BodyInit, headers: Record<string, string> = {}) => handleAuthRoute(new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit), env);

  /** Accounts and the sign-up counts, which a refused body leaves as they were. */
  const accounts = async () => ({
    users: (await d1.db.prepare('SELECT count(*) AS n FROM "user"').first<{ n: number }>())?.n,
    signups: (await d1.db.prepare('SELECT * FROM signup_limits ORDER BY key').all()).results,
  });

  it('refuses a declared length over the cap with 413 before reading or counting a sign-up', async () => {
    for (const path of ['/api/auth/sign-in/email', '/api/auth/sign-up/email']) {
      const refused = await auth(path, unreadable(), { 'content-length': String(JSON_BODY_MAX_BYTES + 1) });
      expect(refused.status, path).toBe(413);
    }
    const counted = await d1.db.prepare("SELECT count(*) AS n FROM signup_limits WHERE key LIKE 'address:203.0.113.7%'").first<{ n: number }>();
    expect(counted?.n ?? 0, 'no sign-up counted').toBe(0);
  }, 30_000);

  for (const path of ['/api/auth/sign-in/email', '/api/auth/sign-up/email']) {
    it(`${path}: refuses an undeclared body that runs past the cap with 413, read no further, creating and counting nothing`, async () => {
      const before = await accounts();
      const { stream, read, limit } = endless(JSON_BODY_MAX_BYTES);
      const response = await auth(path, stream);
      const text = await response.text();
      expect(response.status, text).toBe(413);
      expect((JSON.parse(text) as { code: string }).code).toBe('TOO_LARGE');
      expect(read.bytes).toBeLessThanOrEqual(limit);
      expect(await accounts(), 'no account and no sign-up counted').toEqual(before);
    }, 30_000);
  }

  it('still signs in with an ordinary body', async () => {
    const response = await auth('/api/auth/sign-in/email', JSON.stringify({ email: ada.email, password: 'correct horse battery' }));
    expect(response.status, await response.clone().text()).toBe(200);
  }, 30_000);
});
