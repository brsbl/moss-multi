// Assets (T3.1; A§16): folder-scoped uploads into content-addressed R2 bytes, served with SWR caching, ETag/304,
// HTTP Range and a sandboxed SVG; editors upload, readers (a share link included) read; copies carry their media.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const OTHER_PNG = new Uint8Array([...PNG, 1, 2, 3]);
const VIDEO = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>');

/** The DocDO RPCs duplicate calls, over markdown each test sets. */
const exported = new Map<string, string>();
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    exportMarkdown: async () => exported.get(id.name) ?? '',
    snapshotForDuplicate: async () => ({ title: 'Original', state: new Uint8Array([1]) }),
    createFromSnapshot: async () => undefined,
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never };
  ada = await signedUpUser(env, 'assets-ada');
  ben = await signedUpUser(env, 'assets-ben', 'Ben');
  cy = await signedUpUser(env, 'assets-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());

function call(method: string, path: string, cookie: string | null, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  return handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, ...(cookie ? { cookie } : {}), ...init.headers },
    body: init.body,
  }), env);
}

const upload = (cookie: string | null, docId: string, filename: string, bytes: Uint8Array, contentType = '') =>
  call('POST', `/api/docs/${docId}/assets?filename=${encodeURIComponent(filename)}`, cookie, {
    body: bytes, headers: contentType ? { 'content-type': contentType } : {},
  });

interface Uploaded { relativePath: string; filename: string; asset: { id: string; versionId: string; size: number } }

async function uploaded(response: Response): Promise<Uploaded> {
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Uploaded;
}

const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

describe('upload (A§16)', () => {
  it('stores every moss media type in the doc folder and serves it back with its type', async () => {
    const docId = await insertDoc(d1.db, ada);
    const types = { 'a.png': 'image/png', 'b.jpg': 'image/jpeg', 'c.jpeg': 'image/jpeg', 'd.gif': 'image/gif', 'e.webp': 'image/webp',
      'f.svg': 'image/svg+xml', 'g.mp4': 'video/mp4', 'h.webm': 'video/webm', 'i.mov': 'video/quicktime' };
    for (const [name, type] of Object.entries(types)) {
      const body = new Uint8Array([...PNG, name.charCodeAt(0)]);
      const result = await uploaded(await upload(ada.cookie, docId, name, body, type));
      expect(result.relativePath, name).toBe(`assets/${name}`);
      const served = await call('GET', `/api/docs/${docId}/assets/${name}`, ada.cookie);
      expect(served.status, name).toBe(200);
      expect(served.headers.get('content-type'), name).toBe(type);
      expect(served.headers.get('x-content-type-options'), name).toBe('nosniff');
      expect(served.headers.get('accept-ranges'), name).toBe('bytes');
      expect(await bytesOf(served), name).toEqual(body);
    }
  });

  it('accepts an upload to a folder by id for its editors, and refuses its viewers', async () => {
    const docId = await insertDoc(d1.db, ada);
    const sent = await call('POST', `/api/folders/${ada.homeId}/assets?filename=folder.png`, ada.cookie, { body: PNG, headers: { 'content-type': 'image/png' } });
    expect((await uploaded(sent)).relativePath).toBe('assets/folder.png');
    expect((await call('GET', `/api/docs/${docId}/assets/folder.png`, ada.cookie)).status).toBe(200);
    await insertGrant(d1.db, { folderId: ada.homeId }, ben, 'viewer');
    const refused = await call('POST', `/api/folders/${ada.homeId}/assets?filename=nope.png`, ben.cookie, { body: PNG });
    expect(refused.status).toBe(403);
    expect((await call('POST', `/api/folders/${ada.homeId}/assets?filename=nope.png`, cy.cookie, { body: PNG })).status).toBe(404);
  });

  it('keeps one content-addressed blob for identical bytes, reuses a name holding them, and suffixes a clash', async () => {
    const docId = await insertDoc(d1.db, ada);
    const first = await uploaded(await upload(ada.cookie, docId, 'Screen Shot 2026.PNG', PNG, 'image/png'));
    expect(first.filename, 'a stored name never needs escaping').toBe('Screen-Shot-2026.png');
    const again = await uploaded(await upload(ada.cookie, docId, 'Screen Shot 2026.PNG', PNG, 'image/png'));
    expect(again.relativePath, 'the same bytes under the same name are the same asset').toBe(first.relativePath);
    const twin = await uploaded(await upload(ada.cookie, docId, 'twin.png', PNG, 'image/png'));
    const clash = await uploaded(await upload(ada.cookie, docId, 'Screen Shot 2026.PNG', OTHER_PNG, 'image/png'));
    expect(clash.filename).toBe('Screen-Shot-2026-2.png');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', PNG))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const row = await d1.db.prepare('SELECT refcount FROM content_objects WHERE hash = ?').bind(hash).first<{ refcount: number }>();
    expect(row?.refcount, 'two assets hold the bytes').toBe(2);
    expect(await d1.assets.head(`asset-blobs/sha256/${hash}`)).not.toBeNull();
    expect(twin.asset.id).not.toBe(first.asset.id);
  });

  it('refuses a type outside moss set with 415, an empty body with 400 and an oversized one with 413', async () => {
    const docId = await insertDoc(d1.db, ada);
    expect((await upload(ada.cookie, docId, 'paper.pdf', PNG, 'application/pdf')).status).toBe(415);
    expect((await upload(ada.cookie, docId, 'page.html', PNG, 'text/html')).status).toBe(415);
    expect((await upload(ada.cookie, docId, 'disguised.png', PNG, 'text/html')).status, 'a body that says it is not the named type').toBe(415);
    expect((await upload(ada.cookie, docId, 'empty.png', new Uint8Array(), 'image/png')).status).toBe(400);
    expect((await upload(ada.cookie, docId, 'huge.png', new Uint8Array(10 * 1024 * 1024 + 1), 'image/png')).status).toBe(413);
  });

  it('refuses a viewer 403 and a stranger or anonymous caller 404, and a trashed doc takes no upload', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    expect((await upload(ben.cookie, docId, 'v.png', PNG, 'image/png')).status).toBe(403);
    expect((await upload(cy.cookie, docId, 'v.png', PNG, 'image/png')).status).toBe(404);
    const token = await insertLink(d1.db, { docId }, 'editor');
    expect((await call('POST', `/api/docs/${docId}/assets?filename=v.png&share=${token}`, null, { body: PNG })).status, 'a link alone reads at most').toBe(403);
    const trashed = await insertDoc(d1.db, ada, { deleted: true });
    expect((await upload(ada.cookie, trashed, 'v.png', PNG, 'image/png')).status).toBe(404);
  });
});

describe('serving (A§16)', () => {
  it('serves the current version stale-while-revalidate with an ETag that answers 304, and a version immutably', async () => {
    const docId = await insertDoc(d1.db, ada);
    const { asset } = await uploaded(await upload(ada.cookie, docId, 'cache.png', PNG, 'image/png'));
    const served = await call('GET', `/api/docs/${docId}/assets/cache.png`, ada.cookie);
    expect(served.headers.get('cache-control')).toBe('private, max-age=0, stale-while-revalidate=86400');
    const etag = served.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const revalidated = await call('GET', `/api/docs/${docId}/assets/cache.png`, ada.cookie, { headers: { 'if-none-match': etag ?? '' } });
    expect(revalidated.status).toBe(304);
    const pinned = await call('GET', `/api/docs/${docId}/assets/cache.png?version=${asset.versionId}`, ada.cookie);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect((await call('GET', `/api/docs/${docId}/assets/cache.png?version=nope`, ada.cookie)).status).toBe(404);
    expect((await call('HEAD', `/api/docs/${docId}/assets/cache.png`, ada.cookie)).headers.get('content-length')).toBe(String(PNG.byteLength));
  });

  it('answers HTTP Range with 206 and the exact bytes, and an unsatisfiable range with 416', async () => {
    const docId = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, docId, 'clip.webm', VIDEO, 'video/webm'));
    const path = `/api/docs/${docId}/assets/clip.webm`;
    for (const [range, from, to] of [['bytes=0-9', 0, 9], ['bytes=60-', 60, 63], ['bytes=-4', 60, 63], ['bytes=10-1000', 10, 63]] as const) {
      const part = await call('GET', path, ada.cookie, { headers: { range } });
      expect(part.status, range).toBe(206);
      expect(part.headers.get('content-range'), range).toBe(`bytes ${from}-${to}/64`);
      expect(part.headers.get('content-length'), range).toBe(String(to - from + 1));
      expect(await bytesOf(part), range).toEqual(VIDEO.slice(from, to + 1));
    }
    const beyond = await call('GET', path, ada.cookie, { headers: { range: 'bytes=64-' } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */64');
  });

  it('sandboxes SVG so its script can never run as a page', async () => {
    const docId = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, docId, 'icon.svg', SVG, 'image/svg+xml'));
    const served = await call('GET', `/api/docs/${docId}/assets/icon.svg`, ada.cookie);
    expect(served.headers.get('content-security-policy')).toMatch(/^sandbox\b/);
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('lets a reader and an anonymous link holder read, and gives a stranger, a forged link and a trashed doc one 404', async () => {
    const docId = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, docId, 'shared.png', PNG, 'image/png'));
    const path = `/api/docs/${docId}/assets/shared.png`;
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    expect((await call('GET', path, ben.cookie)).status).toBe(200);
    const token = await insertLink(d1.db, { docId }, 'viewer');
    const anonymous = await call('GET', `${path}?share=${token}`, null);
    expect(anonymous.status).toBe(200);
    expect(await bytesOf(anonymous)).toEqual(PNG);
    expect((await call('GET', `${path}?share=${token}`, cy.cookie)).status, 'a signed-in link holder').toBe(200);
    const denied = [
      await call('GET', path, cy.cookie),
      await call('GET', path, null),
      await call('GET', `${path}?share=forged`, null),
      await call('GET', `/api/docs/${docId}/assets/missing.png`, ada.cookie),
    ];
    const bodies = await Promise.all(denied.map((response) => response.text()));
    expect(denied.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(bodies).size, 'the 404s are byte-identical').toBe(1);
  });
});

describe('copies carry media (A§16)', () => {
  it('copies an asset from one note into another folder for moss cross-note paste', async () => {
    const source = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, source, 'moved.png', PNG, 'image/png'));
    const elsewhere = await insertFolder(d1.db, ada, ada.homeId);
    const target = await insertDoc(d1.db, ada, { folderId: elsewhere });
    const body = JSON.stringify({ sourceNoteId: source, sourceRelativePath: 'assets/moved.png', filename: 'moved.png' });
    const copied = await call('POST', `/api/docs/${target}/assets/copy`, ada.cookie, { body, headers: { 'content-type': 'application/json' } });
    expect(copied.status, await copied.clone().text()).toBe(201);
    expect(((await copied.json()) as Uploaded).relativePath).toBe('assets/moved.png');
    expect(await bytesOf(await call('GET', `/api/docs/${target}/assets/moved.png`, ada.cookie))).toEqual(PNG);
    // A note in the same folder already reaches it; a reader of the source who cannot edit the target is refused.
    const sibling = await insertDoc(d1.db, ada);
    const same = await call('POST', `/api/docs/${sibling}/assets/copy`, ada.cookie, { body, headers: { 'content-type': 'application/json' } });
    expect(((await same.json()) as Uploaded).relativePath).toBe('assets/moved.png');
    await insertGrant(d1.db, { docId: target }, ben, 'viewer');
    expect((await call('POST', `/api/docs/${target}/assets/copy`, ben.cookie, { body, headers: { 'content-type': 'application/json' } })).status).toBe(403);
  });

  it("a duplicate made in the caller's Home keeps the media its markdown references", async () => {
    const docId = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, docId, 'kept.png', PNG, 'image/png'));
    await uploaded(await upload(ada.cookie, docId, 'unused.png', OTHER_PNG, 'image/png'));
    exported.set(docId, 'Before\n\n![A pattern](assets/kept.png)\n');
    // A doc grant gives no right to create siblings in Ada's folder, so Ben's copy lands in his Home.
    await insertGrant(d1.db, { docId }, ben, 'editor');
    const response = await call('POST', `/api/docs/${docId}/duplicate`, ben.cookie);
    expect(response.status, await response.clone().text()).toBe(201);
    const { doc } = (await response.json()) as { doc: { id: string; folderId: string } };
    expect(doc.folderId).toBe(ben.homeId);
    const kept = await call('GET', `/api/docs/${doc.id}/assets/kept.png`, ben.cookie);
    expect(kept.status).toBe(200);
    expect(await bytesOf(kept)).toEqual(PNG);
    expect((await call('GET', `/api/docs/${doc.id}/assets/unused.png`, ben.cookie)).status, 'only referenced media travels').toBe(404);
  });
});

describe('export (A§12)', () => {
  it("returns the DocDO's markdown to a reader and the one 404 to anyone else", async () => {
    const docId = await insertDoc(d1.db, ada);
    exported.set(docId, '![Alt](assets/x.png)\n');
    const response = await call('GET', `/api/docs/${docId}/export`, ada.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe('![Alt](assets/x.png)\n');
    expect((await call('GET', `/api/docs/${docId}/export`, cy.cookie)).status).toBe(404);
  });
});
