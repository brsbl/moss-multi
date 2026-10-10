// Every route that reads a JSON body caps it (T3.S7; A§18): a body that declares more than its route's cap is refused
// with 413 before a byte is read, and one that streams past the cap without declaring a length is refused as it passes
// it, never buffered further. Uploads stream with their own bounds (assets.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREATE_BODY_MAX_BYTES, MARKDOWN_CAP_BYTES } from '@moss-multi/protocol/limits';
import { handleAuthRoute } from '../auth/route.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { COMMENT_BODY_MAX_BYTES } from './comments.ts';
import { JSON_BODY_MAX_BYTES } from './respond.ts';
import { RESTORE_BODY_MAX_BYTES } from './versions.ts';
import { handleApi } from './router.ts';

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({
    setName: async () => undefined, recheck: async () => ({ closed: 0 }), renameTitle: async () => undefined,
    createComment: async () => ({ ok: true, id: 'c-cap', quote: null }),
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
let folderId: string;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'body-cap', 'Ada');
  docId = await insertDoc(d1.db, ada);
  folderId = await insertFolder(d1.db, ada, ada.homeId);
}, 60_000);
afterAll(() => d1?.dispose());

const FEEDBACK_BODY_MAX_BYTES = 128 * 1024;

interface Route { method: string; path: () => string; cap: number; error: string; ok: () => unknown }

/** Every route that reads a JSON body, a body it accepts, and the 413 error it answers past its cap. */
const ROUTES: Route[] = [
  { method: 'POST', path: () => '/api/docs', cap: CREATE_BODY_MAX_BYTES, error: 'doc-cap', ok: () => ({ title: 'Fine' }) },
  { method: 'PATCH', path: () => `/api/docs/${docId}`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ title: 'Renamed' }) },
  { method: 'POST', path: () => `/api/docs/${docId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: 'mm-t3s7-cap@example.invalid', role: 'viewer' }) },
  { method: 'PATCH', path: () => `/api/docs/${docId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: 'mm-t3s7-cap@example.invalid', role: 'editor' }) },
  { method: 'DELETE', path: () => `/api/docs/${docId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: 'mm-t3s7-cap@example.invalid' }) },
  { method: 'POST', path: () => `/api/docs/${docId}/links`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ role: 'viewer' }) },
  { method: 'POST', path: () => `/api/docs/${docId}/assets/copy`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ sourceNoteId: docId, sourceRelativePath: 'assets/none.png' }) },
  { method: 'POST', path: () => `/api/docs/${docId}/assets/from-url`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ url: 'http://127.0.0.1/x.png' }) },
  { method: 'POST', path: () => '/api/folders', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ parentId: ada.homeId, name: 'Capped' }) },
  { method: 'PATCH', path: () => `/api/folders/${folderId}`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Renamed folder' }) },
  { method: 'POST', path: () => `/api/folders/${folderId}/members`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ email: 'mm-t3s7-folder@example.invalid', role: 'viewer' }) },
  { method: 'POST', path: () => `/api/folders/${folderId}/links`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ role: 'viewer' }) },
  { method: 'POST', path: () => '/api/vaults', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Capped vault' }) },
  { method: 'PATCH', path: () => `/api/vaults/${ada.homeId}`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Home again' }) },
  { method: 'POST', path: () => '/api/agents', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Scribe' }) },
  { method: 'POST', path: () => '/api/notifications/read', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ ids: [] }) },
  { method: 'POST', path: () => `/api/docs/${docId}/comments`, cap: COMMENT_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ id: 'c-ok', text: 'Fine' }) },
  { method: 'PATCH', path: () => `/api/docs/${docId}/comments/c-ok`, cap: COMMENT_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ text: 'Edited' }) },
  { method: 'POST', path: () => `/api/docs/${docId}/comments/c-ok/resolve`, cap: COMMENT_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ resolved: true }) },
  { method: 'POST', path: () => `/api/docs/${docId}/comments/c-ok/reactions`, cap: COMMENT_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ emoji: '👍', on: true }) },
  { method: 'POST', path: () => `/api/docs/${docId}/suggestions/s-cap/accept`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ previewHash: 'h'.repeat(64), digest: 'd'.repeat(64) }) },
  { method: 'POST', path: () => `/api/docs/${docId}/suggestions/s-cap/reject`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({}) },
  { method: 'POST', path: () => `/api/docs/${docId}/suggestions/s-cap/withdraw`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({}) },
  { method: 'POST', path: () => `/api/docs/${docId}/versions`, cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ name: 'Checkpoint' }) },
  { method: 'POST', path: () => `/api/docs/${docId}/versions/v-cap/restore`, cap: RESTORE_BODY_MAX_BYTES, error: 'too-large', ok: () => ({}) },
  { method: 'POST', path: () => '/api/unfurl', cap: JSON_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ noteId: docId, url: 'http://127.0.0.1/' }) },
  { method: 'POST', path: () => '/api/feedback', cap: FEEDBACK_BODY_MAX_BYTES, error: 'too-large', ok: () => ({ body: 'Lovely.' }) },
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
      await expectRefused(await send(route, unreadable(), { 'content-length': String(route.cap + 1) }), route.error);
    }, 30_000);

    it(`${name}: an undeclared body that runs past the cap is refused with 413, read no further`, async () => {
      const { stream, read, limit } = endless(route.cap);
      await expectRefused(await send(route, stream), route.error);
      expect(read.bytes, 'read no further than the cap').toBeLessThanOrEqual(limit);
    }, 60_000);

    it(`${name}: a body of ordinary size is not refused as too large`, async () => {
      // Only the cap is under test here; the route's own answer to this body is its own tests'.
      const status = await send(route, JSON.stringify(route.ok())).then((r) => r.status, () => 500);
      expect(status).not.toBe(413);
    }, 30_000);
  }

  it('the feedback cap takes the longest message the dialog sends, every character escaped', async () => {
    const sent = JSON.stringify({ body: '\u0001'.repeat(10_000), page: '\u0001'.repeat(2_000) });
    expect(sent.length, 'longer than the default cap').toBeGreaterThan(JSON_BODY_MAX_BYTES);
    const response = await send(ROUTES.at(-1)!, sent);
    expect(response.status, await response.clone().text()).toBe(201);
  }, 30_000);

  // T4.R2: T3.S7's caps must refuse no comment body the DocDO accepts (comments.ts: 10,000 characters of text and of
  // quote), whatever a client escapes.
  const comment = (method: string, path: string, body: string) => send({ method, path: () => path, cap: 0, error: '', ok: () => ({}) }, body);

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

  // T6.R: a restore carries its base, the state vectors of the note and of every payload the restorer held (A§14). The
  // route admits up to 10,000 payloads; a long-lived note's vectors name every session that wrote it, so an honest
  // maximal base (the note's vector at its 65,536-character bound, 10,000 minted ids, each vector naming 64 clients
  // with clocks in the millions) is far past T3.S7's 64 KiB default.
  it('a restore takes the base of a note with the most payloads the route admits', async () => {
    const vector = (clients: number) => {
      const bytes: number[] = [clients];
      for (let c = 0; c < clients; c += 1) bytes.push(0xff, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x03);
      return Buffer.from(bytes).toString('base64');
    };
    const payloads: Record<string, string> = {};
    for (let i = 0; i < 10_000; i += 1) payloads[i.toString(16).padStart(32, '0')] = vector(64);
    const sent = JSON.stringify({ base: { note: 'A'.repeat(65_536), payloads, age: 599_999 } });
    expect(sent.length, 'longer than the default cap').toBeGreaterThan(JSON_BODY_MAX_BYTES * 100);
    expect(sent.length, 'under the restore cap').toBeLessThanOrEqual(RESTORE_BODY_MAX_BYTES);
    const response = await comment('POST', `/api/docs/${docId}/versions/v-cap/restore`, sent);
    expect(response.status, await response.clone().text()).toBe(200);
  }, 60_000);

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

  it('refuses a declared length over the cap with 413 before reading or counting a sign-up', async () => {
    for (const path of ['/api/auth/sign-in/email', '/api/auth/sign-up/email']) {
      const refused = await auth(path, unreadable(), { 'content-length': String(JSON_BODY_MAX_BYTES + 1) });
      expect(refused.status, path).toBe(413);
    }
    const counted = await d1.db.prepare("SELECT count(*) AS n FROM signup_limits WHERE key LIKE 'address:203.0.113.7%'").first<{ n: number }>();
    expect(counted?.n ?? 0, 'no sign-up counted').toBe(0);
  }, 30_000);

  it('refuses an undeclared body that runs past the cap with 413, read no further', async () => {
    const { stream, read, limit } = endless(JSON_BODY_MAX_BYTES);
    expect((await auth('/api/auth/sign-in/email', stream)).status).toBe(413);
    expect(read.bytes).toBeLessThanOrEqual(limit);
  }, 30_000);

  it('still signs in with an ordinary body', async () => {
    const response = await auth('/api/auth/sign-in/email', JSON.stringify({ email: ada.email, password: 'correct horse battery' }));
    expect(response.status, await response.clone().text()).toBe(200);
  }, 30_000);
});
