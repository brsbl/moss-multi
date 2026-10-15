// Assets (T3.1; A§16): uploads into content-addressed R2 bytes, served `private, no-cache` with ETag/304, HTTP Range
// and a sandboxed SVG; editors upload, readers (a share link included) read. A doc's media are its own record, mapping
// each `assets/<file>` it uses to the exact version placed in it: never a filename looked up in its folder. Stored
// bytes are the type their name declares (T3.B10).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UPLOAD_RATE, VAULT_MEDIA_QUOTA_BYTES } from '@moss-multi/protocol/limits';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { MEDIA_CAP_BYTES } from '@moss-multi/protocol/media';
import { setUploadDeadlineForTests, uploadBufferSize } from './assets.ts';
import { setRemoteFetchForTests } from './remote.ts';
import { handleApi } from './router.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const OTHER_PNG = new Uint8Array([...PNG, 1, 2, 3]);
const SHOT = new Uint8Array([...PNG, 7, 7]);
/** A webm's EBML magic, then filler: 64 bytes for the Range legs. */
const VIDEO = new Uint8Array(Array.from({ length: 64 }, (_, i) => [0x1a, 0x45, 0xdf, 0xa3][i] ?? i));
/** The journeys' real media, one of every moss type. */
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../../e2e/fixtures/media/${name}`, import.meta.url)));
const SVG =new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>');

/** The DocDO RPCs duplicate and export call, over markdown each test sets; `created` records each copy's arguments. */
const exported = new Map<string, string>();
const created = new Map<string, unknown[]>();
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    pullMarkdown: async () => exported.get(id.name) ?? '',
    snapshotForDuplicate: async () => ({ title: 'Original', state: new Uint8Array([1]), payloads: [] }),
    createFromSnapshot: async (...args: unknown[]) => {
      created.set(id.name, args);
    },
  }),
};

/** Workspace notifications and REST write tokens, which these tests never count; upload tokens counted per window name
 * (the PrincipalDO's persisted window is tested in packages/sync's harness). */
const uploadsTaken = new Map<string, number>();
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    takeCreateToken: async () => true,
    publish: async () => undefined,
    takeWriteToken: async () => true,
    takeFetchToken: async () => true,
    takeUploadToken: async () => {
      const taken = (uploadsTaken.get(id.name) ?? 0) + 1;
      uploadsTaken.set(id.name, taken);
      return taken <= UPLOAD_RATE.max;
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'assets-ada');
  ben = await signedUpUser(env, 'assets-ben', 'Ben');
  cy = await signedUpUser(env, 'assets-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());

function call(method: string, path: string, cookie: string | null, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  // A fixed-size body carries its Content-Length, as a browser's and the Workers runtime's do.
  const length = init.body instanceof Uint8Array ? { 'content-length': String(init.body.byteLength) } : {};
  return handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, ...(cookie ? { cookie } : {}), ...length, ...init.headers },
    body: init.body,
    // A streamed body, which a test holds open.
    ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit), env);
}

const upload = (cookie: string | null, docId: string, filename: string, bytes: Uint8Array<ArrayBuffer>, contentType = '', headers: Record<string, string> = {}) =>
  call('POST', `/api/docs/${docId}/assets?filename=${encodeURIComponent(filename)}`, cookie, {
    body: bytes, headers: { ...(contentType ? { 'content-type': contentType } : {}), ...headers },
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
    const types = { 'a.png': ['image/png', 'pattern.png'], 'b.jpg': ['image/jpeg', 'pattern.jpg'], 'c.jpeg': ['image/jpeg', 'pattern.jpg'],
      'd.gif': ['image/gif', 'pattern.gif'], 'e.webp': ['image/webp', 'pattern.webp'], 'f.svg': ['image/svg+xml', 'pattern.svg'],
      'g.mp4': ['video/mp4', 'clip.mp4'], 'h.webm': ['video/webm', 'clip.webm'], 'i.mov': ['video/quicktime', 'clip.mov'] };
    for (const [name, [type, real]] of Object.entries(types)) {
      const body = fixture(real);
      const result = await uploaded(await upload(ada.cookie, docId, name, body, type));
      expect(result.relativePath, name).toBe(`assets/${name}`);
      const served = await call('GET', `/api/docs/${docId}/assets/${name}`, ada.cookie);
      expect(served.status, name).toBe(200);
      expect(served.headers.get('content-type'), name).toBe(type);
      expect(served.headers.get('x-content-type-options'), name).toBe('nosniff');
      expect(served.headers.get('accept-ranges'), name).toBe('bytes');
      expect(await bytesOf(served), name).toEqual(body);
    }
  }, 20_000); // nine uploads and nine reads; a loaded runner has taken past the 5 s default

  it('takes uploads only into a note, never into a folder no note reads', async () => {
    const sent = await call('POST', `/api/folders/${ada.homeId}/assets?filename=folder.png`, ada.cookie, { body: PNG, headers: { 'content-type': 'image/png' } });
    expect(sent.status).toBe(404);
  });

  it('keeps one content-addressed blob for identical bytes, reuses a name holding them, and suffixes a clash', async () => {
    const docId = await insertDoc(d1.db, ada);
    const first = await uploaded(await upload(ada.cookie, docId, 'Screen Shot 2026.PNG', SHOT, 'image/png'));
    expect(first.filename, 'a stored name never needs escaping').toBe('Screen-Shot-2026.png');
    const again = await uploaded(await upload(ada.cookie, docId, 'Screen Shot 2026.PNG', SHOT, 'image/png'));
    expect(again.relativePath, 'the same bytes under the same name are the same asset').toBe(first.relativePath);
    const twin = await uploaded(await upload(ada.cookie, docId, 'twin.png', SHOT, 'image/png'));
    const clash = await uploaded(await upload(ada.cookie, docId, 'Screen Shot 2026.PNG', OTHER_PNG, 'image/png'));
    expect(clash.filename).toBe('Screen-Shot-2026-2.png');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', SHOT))].map((b) => b.toString(16).padStart(2, '0')).join('');
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

  it('takes an upload from a signed-in holder of an editor link', async () => {
    const docId = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId }, 'editor');
    const sent = await call('POST', `/api/docs/${docId}/assets?filename=linked.png&share=${token}`, cy.cookie, { body: PNG, headers: { 'content-type': 'image/png' } });
    expect((await uploaded(sent)).relativePath).toBe('assets/linked.png');
  });

  it("never stores an upload under moss desktop's derived-thumbnail name, which the web would not load", async () => {
    const docId = await insertDoc(d1.db, ada);
    const result = await uploaded(await upload(ada.cookie, docId, 'video-thumb-abc.png', PNG, 'image/png'));
    expect(result.filename).not.toMatch(/^video-thumb-/);
    expect((await call('GET', `/api/docs/${docId}/${result.relativePath}`, ada.cookie)).status).toBe(200);
  });

  it('reads back a suffixed long name as its own file, not the first', async () => {
    const docId = await insertDoc(d1.db, ada);
    const long = `${'x'.repeat(120)}.png`;
    const first = await uploaded(await upload(ada.cookie, docId, long, PNG, 'image/png'));
    const second = await uploaded(await upload(ada.cookie, docId, long, OTHER_PNG, 'image/png'));
    expect(second.filename).not.toBe(first.filename);
    expect(await bytesOf(await call('GET', `/api/docs/${docId}/assets/${second.filename}`, ada.cookie))).toEqual(OTHER_PNG);
    expect(await bytesOf(await call('GET', `/api/docs/${docId}/assets/${first.filename}`, ada.cookie))).toEqual(PNG);
  });
});

describe('stored bytes are the type their name declares (T3.B10, B166)', () => {
  const text = (value: string) => new TextEncoder().encode(value);
  const hashOf = async (bytes: Uint8Array<ArrayBuffer>) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  /** Everything a stored upload of `bytes` leaves, anywhere, plus the doc's own record and its folder's assets. */
  const traceOf = async (docId: string, bytes: Uint8Array<ArrayBuffer>) => {
    const hash = await hashOf(bytes);
    const n = (sql: string, ...args: unknown[]) => d1.db.prepare(sql).bind(...args).first<{ n: number }>().then((row) => row?.n ?? 0);
    return {
      docMedia: await n('SELECT count(*) AS n FROM doc_media WHERE doc_id = ?1', docId),
      assets: await n('SELECT count(*) AS n FROM assets WHERE folder_id = (SELECT folder_id FROM docs WHERE id = ?1)', docId),
      rows: await n(`SELECT (SELECT count(*) FROM content_objects WHERE hash = ?1) + (SELECT count(*) FROM asset_versions WHERE content_hash = ?1)
        + (SELECT count(*) FROM doc_media WHERE content_hash = ?1) AS n`, hash),
      blob: (await d1.assets.head(`asset-blobs/sha256/${hash}`)) !== null,
    };
  };
  const MISMATCHED: [string, string, Uint8Array<ArrayBuffer>][] = [
    ['png bytes named .jpg', 'image/jpeg', new Uint8Array([...PNG, 1])],
    ['text named .png', 'image/png', text('just some text, not a picture')],
    ['an HTML page named .svg', 'image/svg+xml', text('<!DOCTYPE html><html><body><svg></svg></body></html>')],
    ['png bytes named .svg', 'image/svg+xml', new Uint8Array([...PNG, 2])],
    ['text named .gif', 'image/gif', text('GIF? no')],
    ['a RIFF that is not WebP named .webp', 'image/webp', text('RIFF\u0004\u0000\u0000\u0000WAVEfmt ')],
    ['text named .mp4', 'video/mp4', text('not a movie at all')],
    ['png bytes named .webm', 'video/webm', new Uint8Array([...PNG, 3])],
    ['text named .mov', 'video/quicktime', text('not a QuickTime movie')],
  ];
  const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

  let owner: TestUser;
  /** Remote images by URL, as a server sends them. */
  const remote = new Map<string, { type: string; bytes: Uint8Array<ArrayBuffer> }>();
  beforeAll(async () => {
    owner = await signedUpUser(env, 'assets-sniff-owner', 'Sniff');
    setRemoteFetchForTests({
      fetch: (async (input: RequestInfo | URL) => {
        const served = remote.get(String(input));
        if (!served) throw new Error(`unexpected fetch ${String(input)}`);
        return new Response(served.bytes, { headers: { 'content-type': served.type } });
      }) as typeof fetch,
      resolve: async (host) => (host === 'img.example' ? ['93.184.215.15'] : []),
    });
  }, 60_000);
  afterAll(() => setRemoteFetchForTests(null));

  const fromUrl = (docId: string, url: string) => call('POST', `/api/docs/${docId}/assets/from-url`, owner.cookie, {
    body: JSON.stringify({ url }), headers: { 'content-type': 'application/json' },
  });

  it.each(MISMATCHED)('refuses %s with 415 on the raw route, writing nothing', async (_label, type, bytes) => {
    const docId = await insertDoc(d1.db, owner);
    const before = await traceOf(docId, bytes);
    const sent = await upload(owner.cookie, docId, `wrong.${EXTENSION[type]}`, bytes, type);
    expect(sent.status, await sent.clone().text()).toBe(415);
    expect(await traceOf(docId, bytes), 'no record, asset, refcount or blob').toEqual(before);
  });

  it.each(MISMATCHED.filter(([, type]) => type.startsWith('image/')))('refuses %s with 415 from a URL, writing nothing', async (_label, type, bytes) => {
    const docId = await insertDoc(d1.db, owner);
    const url = `https://img.example/${crypto.randomUUID()}.${EXTENSION[type]}`;
    remote.set(url, { type, bytes });
    const before = await traceOf(docId, bytes);
    const sent = await fromUrl(docId, url);
    expect(sent.status, await sent.clone().text()).toBe(415);
    expect(await traceOf(docId, bytes), 'no record, asset, refcount or blob').toEqual(before);
  });

  it('stores a real file of every moss type through both routes', async () => {
    const docId = await insertDoc(d1.db, owner);
    const files = { 'pattern.png': 'image/png', 'pattern.jpg': 'image/jpeg', 'pattern.gif': 'image/gif', 'pattern.webp': 'image/webp',
      'pattern.svg': 'image/svg+xml', 'clip.mp4': 'video/mp4', 'clip.webm': 'video/webm', 'clip.mov': 'video/quicktime' };
    for (const [name, type] of Object.entries(files)) {
      const result = await uploaded(await upload(owner.cookie, docId, name, fixture(name), type));
      expect(await bytesOf(await call('GET', `/api/docs/${docId}/${result.relativePath}`, owner.cookie)), name).toEqual(fixture(name));
      if (!type.startsWith('image/')) continue;
      const url = `https://img.example/remote-${name}`;
      remote.set(url, { type, bytes: fixture(name) });
      await uploaded(await fromUrl(docId, url));
    }
  });

  it('takes an SVG past its XML declaration, comments, a doctype and a byte-order mark', async () => {
    const docId = await insertDoc(d1.db, owner);
    const shapes = [
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
      '﻿  <svg viewBox="0 0 1 1"></svg>',
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<!DOCTYPE svg [<!ENTITY fill "#fff">]>\n<svg xmlns="http://www.w3.org/2000/svg"><rect fill="&fill;"/></svg>',
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"></svg:svg>',
    ];
    for (const [i, shape] of shapes.entries()) {
      const sent = await upload(owner.cookie, docId, `shape-${i}.svg`, text(shape), 'image/svg+xml');
      expect(sent.status, shape).toBe(201);
    }
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'<svg/>'].flatMap((char) => [char.charCodeAt(0), 0])]);
    expect((await upload(owner.cookie, docId, 'wide.svg', utf16, 'image/svg+xml')).status, 'UTF-16 with its byte-order mark').toBe(201);
  });

  it('takes a well-formed SVG whose doctype quotes or comments a bracket, or whose root has any XML name prefix, through both routes', async () => {
    const docId = await insertDoc(d1.db, owner);
    const NS = 'http://www.w3.org/2000/svg';
    const long = 'p'.repeat(400);
    const shapes = [
      `<!DOCTYPE svg [<!ENTITY label "]">]><svg xmlns="${NS}"/>`,
      `<!DOCTYPE svg [<!ENTITY label ']>'>]><svg xmlns="${NS}"/>`,
      `<!DOCTYPE svg [<!-- ] -->]><svg xmlns="${NS}"/>`,
      `<!DOCTYPE svg [<!-- > [ -->]><svg xmlns="${NS}"/>`,
      `<!DOCTYPE svg [<?note ] > ?>]><svg xmlns="${NS}"/>`,
      `<!DOCTYPE svg SYSTEM "odd>name[.dtd"><svg xmlns="${NS}"/>`,
      `<!DOCTYPE svg [<!ATTLIST svg data-x CDATA "a]b>">]><svg xmlns="${NS}"/>`,
      `<é:svg xmlns:é="${NS}"/>`,
      `<図形:svg xmlns:図形="${NS}"></図形:svg>`,
      `<${long}:svg xmlns:${long}="${NS}"/>`,
    ];
    for (const [i, shape] of shapes.entries()) {
      expect((await upload(owner.cookie, docId, `odd-${i}.svg`, text(shape), 'image/svg+xml')).status, shape).toBe(201);
      const url = `https://img.example/odd-${crypto.randomUUID()}.svg`;
      remote.set(url, { type: 'image/svg+xml', bytes: text(shape) });
      expect((await fromUrl(docId, url)).status, `from a URL: ${shape}`).toBe(201);
    }
    const be = new Uint8Array([0xfe, 0xff, ...[...'<svg/>'].flatMap((char) => [0, char.charCodeAt(0)])]);
    expect((await upload(owner.cookie, docId, 'wide-be.svg', be, 'image/svg+xml')).status, 'UTF-16BE with its byte-order mark').toBe(201);
    for (const page of [`<!DOCTYPE html [<!ENTITY x "]">]><html><svg/></html>`, `<!-- <svg> -->\n<html></html>`, `<p:svgx xmlns:p="${NS}"/>`]) {
      expect((await upload(owner.cookie, docId, 'page.svg', text(page), 'image/svg+xml')).status, page).toBe(415);
    }
  });

  it('takes an SVG in any XML-autodetected encoding (UTF-32 and odd UCS-4 orders, BOM-less UTF-16, EBCDIC) through both routes', async () => {
    uploadsTaken.clear(); // this block's owner has spent most of its per-minute upload window on the cases above
    const docId = await insertDoc(d1.db, owner);
    const NS = 'http://www.w3.org/2000/svg';
    // Each code point as `size` big-endian bytes, then laid out in `order` (XML 1.0 Appendix F's 1234, 4321, 2143, 3412).
    const wide = (doc: string, size: 2 | 4, order: number[], bom: boolean) =>
      new Uint8Array(
        [...(bom ? '\uFEFF' : '') + doc].flatMap((char) => {
          const code = char.codePointAt(0) ?? 0;
          const be = size === 4 ? [code >>> 24, (code >>> 16) & 0xff, (code >>> 8) & 0xff, code & 0xff] : [code >>> 8, code & 0xff];
          return order.map((at) => be[at]);
        }),
      );
    const declared = (encoding: string) => `<?xml version="1.0" encoding="${encoding}"?><svg xmlns="${NS}"/>`;
    const cases: [string, Uint8Array<ArrayBuffer>][] = [
      ['UTF-32BE with its mark', wide(declared('UTF-32'), 4, [0, 1, 2, 3], true)],
      ['UTF-32LE with its mark', wide(declared('UTF-32'), 4, [3, 2, 1, 0], true)],
      ['UCS-4 2143 with its mark', wide(declared('UCS-4'), 4, [1, 0, 3, 2], true)],
      ['UCS-4 3412 with its mark', wide(declared('UCS-4'), 4, [2, 3, 0, 1], true)],
      ['UTF-32BE without a mark', wide(declared('UTF-32BE'), 4, [0, 1, 2, 3], false)],
      ['UTF-32LE without a mark', wide(declared('UTF-32LE'), 4, [3, 2, 1, 0], false)],
      ['UTF-16BE without a mark', wide(declared('UTF-16'), 2, [0, 1], false)],
      ['UTF-16LE without a mark', wide(declared('UTF-16'), 2, [1, 0], false)],
      ['UTF-16LE without a mark or declaration', wide(`<svg xmlns="${NS}"/>`, 2, [1, 0], false)],
      ['UTF-32LE with a non-BMP prefix', wide(`<𝒮:svg xmlns:𝒮="${NS}"/>`, 4, [3, 2, 1, 0], true)],
      [
        'EBCDIC (IBM037)',
        Uint8Array.from(
          '4c6fa7949340a58599a28996957e7ff14bf07f4085958396848995877e7fc9c2d4f0f3f77f6f6e4ca2a58740a7949395a27e7f88a3a3977a6161a6a6a64ba6f34b96998761f2f0f0f061a2a5877f616e'
            .match(/../g)!
            .map((hex) => parseInt(hex, 16)),
        ),
      ],
    ];
    for (const [i, [label, bytes]] of cases.entries()) {
      expect((await upload(owner.cookie, docId, `encoded-${i}.svg`, bytes, 'image/svg+xml')).status, label).toBe(201);
      const url = `https://img.example/encoded-${crypto.randomUUID()}.svg`;
      remote.set(url, { type: 'image/svg+xml', bytes });
      expect((await fromUrl(docId, url)).status, `from a URL: ${label}`).toBe(201);
    }
    for (const [label, bytes] of [
      ['UTF-32LE HTML', wide('<html><svg/></html>', 4, [3, 2, 1, 0], true)],
      ['BOM-less UTF-16BE HTML', wide('<?xml version="1.0"?><html/>', 2, [0, 1], false)],
    ] as const) {
      expect((await upload(owner.cookie, docId, 'page.svg', bytes, 'image/svg+xml')).status, label).toBe(415);
    }
  });
});

describe('upload bounds (T3.1s)', () => {
  it('refuses a body with no Content-Length with 411, never reading it', async () => {
    const docId = await insertDoc(d1.db, ada);
    const CHUNK = 1024 * 1024;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 40 * CHUNK) return controller.close();
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      },
    }, { highWaterMark: 0 });
    const sent = await call('POST', `/api/docs/${docId}/assets?filename=chunked.png`, ada.cookie, { body, headers: { 'content-type': 'image/png' } });
    expect(sent.status, await sent.clone().text()).toBe(411);
    expect(pulled, 'the body is never read').toBe(0);
  });

  it('refuses a stream that outruns its Content-Length with 413 as it passes it, never reading the rest', async () => {
    const docId = await insertDoc(d1.db, ada);
    const CHUNK = 1024 * 1024;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 40 * CHUNK) return controller.close();
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      },
    }, { highWaterMark: 0 });
    const sent = await call('POST', `/api/docs/${docId}/assets?filename=understated.png`, ada.cookie, {
      body, headers: { 'content-type': 'image/png', 'content-length': String(CHUNK) },
    });
    expect(sent.status, await sent.clone().text()).toBe(413);
    expect(pulled, 'the body is read no further than its declared length').toBeLessThanOrEqual(2 * CHUNK);
  });

  it('copies each chunk into one buffer of the declared length as it arrives, never holding the chunks', async () => {
    const docId = await insertDoc(d1.db, ada);
    const half = 2048;
    // A PNG's signature, then filler: the bytes as the first chunk arrives.
    const arrived = new Uint8Array(half).fill(1);
    arrived.set(PNG);
    const first = arrived.slice();
    let pulls = 0;
    // The stream reuses its first chunk's memory once it is read: an upload that kept chunks would store the reuse.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) return controller.enqueue(first);
        if (pulls === 2) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          first.fill(2);
          return controller.enqueue(new Uint8Array(half).fill(3));
        }
        controller.close();
      },
    }, { highWaterMark: 0 });
    const result = await uploaded(await call('POST', `/api/docs/${docId}/assets?filename=streamed.png`, ada.cookie, {
      body, headers: { 'content-type': 'image/png', 'content-length': String(2 * half) },
    }));
    const stored = await bytesOf(await call('GET', `/api/docs/${docId}/assets/${result.filename}`, ada.cookie));
    expect(stored.byteLength).toBe(2 * half);
    expect(stored.slice(0, half), 'the first chunk as it arrived').toEqual(arrived);
    expect(stored.slice(half).every((b) => b === 3)).toBe(true);
  });

  it('refuses an invalid Content-Length with 400', async () => {
    const docId = await insertDoc(d1.db, ada);
    const sent = await upload(ada.cookie, docId, 'bad-length.png', PNG, 'image/png', { 'content-length': 'abc' });
    expect(sent.status, await sent.clone().text()).toBe(400);
  });

  it('refuses the upload past the per-identity window with 429 and a sentence', async () => {
    const dee = await signedUpUser(env, 'assets-rate-dee', 'Dee');
    const docId = await insertDoc(d1.db, dee);
    for (let i = 0; i < UPLOAD_RATE.max; i += 1) {
      expect((await upload(dee.cookie, docId, 'burst.png', PNG, 'image/png')).status, `upload ${i + 1}`).toBe(201);
    }
    const refused = await upload(dee.cookie, docId, 'burst.png', PNG, 'image/png');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe(String(UPLOAD_RATE.windowMs / 1000));
    expect(((await refused.json()) as { message: string }).message).toMatch(/too many uploads/i);
    const copy = JSON.stringify({ sourceNoteId: docId, sourceRelativePath: 'assets/burst.png' });
    const copied = await call('POST', `/api/docs/${docId}/assets/copy`, dee.cookie, { body: copy, headers: { 'content-type': 'application/json' } });
    expect(copied.status, 'a cross-note copy counts as an upload').toBe(429);
  }, 60_000);

  it('counts holders of a link under the link and their IP, whichever account they use', async () => {
    const docId = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId }, 'editor');
    const [eve, fay] = [await signedUpUser(env, 'assets-rate-eve', 'Eve'), await signedUpUser(env, 'assets-rate-fay', 'Fay')];
    const viaLink = (who: TestUser, ip: string) => call('POST', `/api/docs/${docId}/assets?filename=linked-burst.png&share=${token}`, who.cookie, {
      body: PNG, headers: { 'content-type': 'image/png', 'cf-connecting-ip': ip },
    });
    for (let i = 0; i < UPLOAD_RATE.max; i += 1) expect((await viaLink(eve, '203.0.113.7')).status, `upload ${i + 1}`).toBe(201);
    expect((await viaLink(fay, '203.0.113.7')).status, 'another account on the same link and IP').toBe(429);
    expect((await viaLink(fay, '203.0.113.8')).status, 'the same link from another IP').toBe(201);
  }, 60_000);

  it('counts a holder whose own grant is weaker than the link under the link and their IP too', async () => {
    const docId = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId }, 'editor');
    const [ivy, jon] = [await signedUpUser(env, 'assets-rate-ivy', 'Ivy'), await signedUpUser(env, 'assets-rate-jon', 'Jon')];
    await insertGrant(d1.db, { docId }, ivy, 'viewer');
    await insertGrant(d1.db, { docId }, jon, 'viewer');
    const viaLink = (who: TestUser) => call('POST', `/api/docs/${docId}/assets?filename=weak-grant.png&share=${token}`, who.cookie, {
      body: PNG, headers: { 'content-type': 'image/png', 'cf-connecting-ip': '203.0.113.9' },
    });
    for (let i = 0; i < UPLOAD_RATE.max; i += 1) expect((await viaLink(ivy)).status, `upload ${i + 1}`).toBe(201);
    expect((await viaLink(jon)).status, 'another viewer on the same link and IP').toBe(429);
  }, 60_000);

  it('enforces a per-vault media quota with 413, over every folder in the vault', async () => {
    const gil = await signedUpUser(env, 'assets-quota-gil', 'Gil');
    const nested = await insertFolder(d1.db, gil, gil.homeId);
    const docId = await insertDoc(d1.db, gil, { folderId: nested });
    await uploaded(await upload(gil.cookie, docId, 'fits.png', PNG, 'image/png'));
    // Fill the vault to within a few bytes of its quota with an asset in its root folder.
    await d1.db.prepare("INSERT INTO assets (id, folder_id, filename, kind, content_type, size, current_version_id, created_by, created_at) VALUES (?1, ?2, 'filler.mp4', 'video', 'video/mp4', ?3, NULL, ?4, ?5)")
      .bind(crypto.randomUUID(), gil.homeId, VAULT_MEDIA_QUOTA_BYTES - PNG.byteLength - 4, gil.id, Date.now()).run();
    const refused = await upload(gil.cookie, docId, 'over.png', OTHER_PNG, 'image/png');
    expect(refused.status).toBe(413);
    const { message } = (await refused.json()) as { message: string };
    expect(message).toMatch(/media storage is full/i);
    // Nothing deletes an asset yet, so removing media from notes frees no quota (B231).
    expect(message).not.toMatch(/delete|remove/i);
    // Another person's vault is untouched.
    const own = await insertDoc(d1.db, ada);
    expect((await upload(ada.cookie, own, 'over.png', OTHER_PNG, 'image/png')).status).toBe(201);
  });

  it('holds the quota against uploads running at the same time', async () => {
    const kim = await signedUpUser(env, 'assets-quota-kim', 'Kim');
    const docId = await insertDoc(d1.db, kim);
    const size = 4096;
    // Room for exactly one more upload.
    await d1.db.prepare("INSERT INTO assets (id, folder_id, filename, kind, content_type, size, current_version_id, created_by, created_at) VALUES (?1, ?2, 'filler.mp4', 'video', 'video/mp4', ?3, NULL, ?4, ?5)")
      .bind(crypto.randomUUID(), kim.homeId, VAULT_MEDIA_QUOTA_BYTES - size, kim.id, Date.now()).run();
    const N = 4;
    let reading = 0;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
      setTimeout(resolve, 3000);
    });
    // Each body is held until every upload is reading its body, past any check made before it.
    const sends = Array.from({ length: N }, (_, i) => {
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          reading += 1;
          if (reading === N) open();
          await gate;
          const png = new Uint8Array(size).fill(i + 1);
          png.set(PNG);
          controller.enqueue(png);
          controller.close();
        },
      }, { highWaterMark: 0 });
      return call('POST', `/api/docs/${docId}/assets?filename=race-${i}.png`, kim.cookie, {
        body, headers: { 'content-type': 'image/png', 'content-length': String(size) },
      });
    });
    const statuses = (await Promise.all(sends)).map((response) => response.status).sort();
    expect(statuses).toEqual([201, ...Array<number>(N - 1).fill(413)]);
    const used = await d1.db.prepare('SELECT SUM(size) AS used FROM assets WHERE folder_id = ?1').bind(kim.homeId).first<{ used: number }>();
    expect(used?.used).toBeLessThanOrEqual(VAULT_MEDIA_QUOTA_BYTES);
  }, 60_000);
  it('grows an upload buffer to its declared length holding at most 1 MiB more, even for a near-cap video (B230, B219)', () => {
    const length = MEDIA_CAP_BYTES.video;
    for (const chunk of [4096, 64 * 1024, 1024 * 1024, 7_777_777]) {
      let capacity = 0;
      let peak = 0;
      for (let offset = 0; offset < length; offset = Math.min(length, offset + chunk)) {
        const next = uploadBufferSize(capacity, Math.min(length, offset + chunk), length);
        // While the buffer grows, the old one stays live until its bytes are copied over.
        if (next !== capacity) peak = Math.max(peak, capacity + next);
        capacity = next;
      }
      expect(capacity, `${chunk}-byte chunks fill the declared length`).toBe(length);
      expect(peak, `${chunk}-byte chunks: peak buffer bytes`).toBeLessThanOrEqual(length + 1024 * 1024);
    }
    // A body that sends a few bytes and stalls holds a small buffer, not its declared length.
    expect(uploadBufferSize(0, 10, length)).toBeLessThanOrEqual(64 * 1024);
  });
  it('refuses an upload whose body stalls past its deadline with 408, cancelling the stream (B230)', async () => {
    const docId = await insertDoc(d1.db, ada);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0]));
        // Then nothing more, ever.
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    setUploadDeadlineForTests(500);
    try {
      const started = Date.now();
      const sent = await call('POST', `/api/docs/${docId}/assets?filename=stalled.webm`, ada.cookie, {
        body, headers: { 'content-type': 'video/webm', 'content-length': String(95 * 1024 * 1024) },
      });
      expect(sent.status, await sent.clone().text()).toBe(408);
      expect(Date.now() - started, 'refused at its deadline').toBeLessThan(5_000);
      await expect.poll(() => cancelled, { message: 'the stalled stream is cancelled', timeout: 2_000 }).toBe(true);
    } finally {
      setUploadDeadlineForTests(null);
    }
    await uploaded(await upload(ada.cookie, docId, 'after-stall.png', PNG, 'image/png'));
  }, 20_000);
});

describe('upload storage bounds (T3.1s)', () => {
  const hashOf = async (bytes: Uint8Array<ArrayBuffer>) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const traceOf = async (hash: string) => ({
    blob: (await d1.assets.head(`asset-blobs/sha256/${hash}`)) !== null,
    rows: await d1.db.prepare(`SELECT (SELECT count(*) FROM content_objects WHERE hash = ?1) + (SELECT count(*) FROM asset_versions WHERE content_hash = ?1)
      + (SELECT count(*) FROM doc_media WHERE content_hash = ?1) AS n`).bind(hash).first<{ n: number }>().then((row) => row?.n),
  });
  const fill = (owner: TestUser, folderId: string, size: number) =>
    d1.db.prepare("INSERT INTO assets (id, folder_id, filename, kind, content_type, size, current_version_id, created_by, created_at) VALUES (?1, ?2, ?3, 'video', 'video/mp4', ?4, NULL, ?5, ?6)")
      .bind(crypto.randomUUID(), folderId, `filler-${crypto.randomUUID()}.mp4`, size, owner.id, Date.now());

  it('stores no bytes for an upload that finds no free name', async () => {
    const lea = await signedUpUser(env, 'assets-names-lea', 'Lea');
    const docId = await insertDoc(d1.db, lea);
    for (let i = 0; i < 50; i += 1) await uploaded(await upload(lea.cookie, docId, 'same.png', new Uint8Array([...PNG, i]), 'image/png'));
    const big = new Uint8Array([...PNG, ...new Uint8Array(4096).fill(9)]);
    const refused = await upload(lea.cookie, docId, 'same.png', big, 'image/png');
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(await traceOf(await hashOf(big)), 'an unbound upload leaves no blob and no rows').toEqual({ blob: false, rows: 0 });
  }, 60_000);

  it('refuses in the asset insert an upload whose room was taken after its checks, leaving no blob and no rows', async () => {
    const max = await signedUpUser(env, 'assets-quota-max', 'Max');
    const docId = await insertDoc(d1.db, max);
    const body = new Uint8Array([...PNG, ...new Uint8Array(4096).fill(5)]);
    // Every check before the write sees room; another upload takes it just before the write commits.
    const DB = new Proxy(d1.db, {
      get(target, key) {
        if (key === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await fill(max, max.homeId, VAULT_MEDIA_QUOTA_BYTES - body.byteLength + 1).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const sent = await handleApi(new Request(`${BASE}/api/docs/${docId}/assets?filename=late.png`, {
      method: 'POST', headers: { origin: BASE, cookie: max.cookie, 'content-type': 'image/png', 'content-length': String(body.byteLength) }, body,
    }), { ...env, DB });
    expect(sent.status, await sent.clone().text()).toBe(413);
    expect(((await sent.json()) as { error: string }).error).toBe('over-quota');
    expect(await traceOf(await hashOf(body))).toEqual({ blob: false, rows: 0 });
  });

  it('lets a same-file retry fill the blob a failed put left at the quota, unchanged totals, and refuses a different file (B228)', async () => {
    const ola = await signedUpUser(env, 'assets-retry-ola', 'Ola');
    const docId = await insertDoc(d1.db, ola);
    const body = new Uint8Array([...PNG, ...new Uint8Array(2048).fill(6)]);
    // Room for exactly this file.
    await fill(ola, ola.homeId, VAULT_MEDIA_QUOTA_BYTES - body.byteLength).run();
    let failures = 1;
    const ASSETS = new Proxy(d1.assets, {
      get(target, key) {
        if (key === 'put' && failures > 0) {
          return async () => {
            failures -= 1;
            throw new Error('R2 put failed');
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const send = (name: string, bytes: Uint8Array<ArrayBuffer>) => handleApi(new Request(`${BASE}/api/docs/${docId}/assets?filename=${name}`, {
      method: 'POST', headers: { origin: BASE, cookie: ola.cookie, 'content-type': 'image/png', 'content-length': String(bytes.byteLength) }, body: bytes,
    }), { ...env, ASSETS });
    const failed = await send('retry.png', body).catch(() => null);
    expect(failed?.status ?? 500, 'the first put fails after the rows commit').not.toBe(201);
    expect(failures).toBe(0);
    const totals = () => d1.db.prepare('SELECT COUNT(*) AS n, SUM(size) AS used FROM assets WHERE folder_id = ?1').bind(ola.homeId).first<{ n: number; used: number }>();
    const before = await totals();
    expect(before?.used).toBe(VAULT_MEDIA_QUOTA_BYTES);
    const retried = await uploaded(await send('retry.png', body));
    expect(retried.filename).toBe('retry.png');
    expect(await bytesOf(await call('GET', `/api/docs/${docId}/assets/retry.png`, ola.cookie)), 'the retry filled the blob').toEqual(body);
    expect(await totals(), 'the retry added no asset').toEqual(before);
    const other = new Uint8Array([...PNG, ...new Uint8Array(2048).fill(7)]);
    for (const name of ['retry.png', 'other.png']) {
      const refused = await send(name, other);
      expect(refused.status, `${name}: ${await refused.clone().text()}`).toBe(413);
      expect(((await refused.json()) as { error: string }).error).toBe('over-quota');
    }
    expect(await totals()).toEqual(before);
  });

  it('lets a same-file retry at the quota fill the blob a failed put left under a -2 name', async () => {
    const ory = await signedUpUser(env, 'assets-retry-ory', 'Ory');
    const docId = await insertDoc(d1.db, ory);
    await uploaded(await upload(ory.cookie, docId, 'shot.png', PNG, 'image/png'));
    const body = new Uint8Array([...PNG, ...new Uint8Array(3000).fill(8)]);
    const usage = () => d1.db.prepare('SELECT COUNT(*) AS n, SUM(size) AS used FROM assets WHERE folder_id = ?1').bind(ory.homeId).first<{ n: number; used: number }>();
    await fill(ory, ory.homeId, VAULT_MEDIA_QUOTA_BYTES - ((await usage())?.used ?? 0) - body.byteLength).run();
    let failures = 1;
    const ASSETS = new Proxy(d1.assets, {
      get(target, key) {
        if (key === 'put' && failures > 0) {
          return async () => {
            failures -= 1;
            throw new Error('R2 put failed');
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const send = () => handleApi(new Request(`${BASE}/api/docs/${docId}/assets?filename=shot.png`, {
      method: 'POST', headers: { origin: BASE, cookie: ory.cookie, 'content-type': 'image/png', 'content-length': String(body.byteLength) }, body,
    }), { ...env, ASSETS });
    const failed = await send().catch(() => null);
    expect(failed?.status ?? 500, 'the first put fails after the rows commit').not.toBe(201);
    expect(failures).toBe(0);
    const before = await usage();
    expect(before?.used).toBe(VAULT_MEDIA_QUOTA_BYTES);
    const retried = await uploaded(await send());
    expect(retried.filename, 'the retry finds the -2 name its first attempt bound').toBe('shot-2.png');
    expect(await bytesOf(await call('GET', `/api/docs/${docId}/assets/shot-2.png`, ory.cookie)), 'the retry filled the blob').toEqual(body);
    expect(await usage(), 'the retry added no asset').toEqual(before);
  });

  it('refuses an import from a URL into a vault exactly at its quota before fetching anything (B236)', async () => {
    const pia = await signedUpUser(env, 'assets-fromurl-pia', 'Pia');
    const docId = await insertDoc(d1.db, pia);
    const fetched: string[] = [];
    setRemoteFetchForTests({
      fetch: (async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      }) as typeof fetch,
      resolve: async (host) => (host === 'img.example' ? ['93.184.215.15'] : []),
    });
    const fromUrl = () => call('POST', `/api/docs/${docId}/assets/from-url`, pia.cookie, {
      body: JSON.stringify({ url: 'https://img.example/full.png' }), headers: { 'content-type': 'application/json' },
    });
    try {
      const filler = crypto.randomUUID();
      await d1.db.prepare("INSERT INTO assets (id, folder_id, filename, kind, content_type, size, current_version_id, created_by, created_at) VALUES (?1, ?2, 'filler.mp4', 'video', 'video/mp4', ?3, NULL, ?4, ?5)")
        .bind(filler, pia.homeId, VAULT_MEDIA_QUOTA_BYTES, pia.id, Date.now()).run();
      const refused = await fromUrl();
      expect(refused.status, await refused.clone().text()).toBe(413);
      expect(((await refused.json()) as { error: string }).error).toBe('over-quota');
      expect(fetched, 'nothing is fetched for a full vault').toEqual([]);
      await d1.db.prepare('UPDATE assets SET size = ?1 WHERE id = ?2').bind(VAULT_MEDIA_QUOTA_BYTES - 4096, filler).run();
      expect((await fromUrl()).status, 'below the quota an import is stored').toBe(201);
      expect(fetched).toHaveLength(1);
    } finally {
      setRemoteFetchForTests(null);
    }
  });

  it('keeps counting media in a trashed folder after its parent moves: the move may not push it past the depth bound', async () => {
    const ned = await signedUpUser(env, 'assets-depth-ned', 'Ned');
    const a = await insertFolder(d1.db, ned, ned.homeId);
    const b = await insertFolder(d1.db, ned, a);
    await fill(ned, b, VAULT_MEDIA_QUOTA_BYTES - 8).run();
    await d1.db.prepare('UPDATE folders SET deleted_at = ?1 WHERE id = ?2').bind(Date.now(), b).run();
    // A live chain down to the deepest a folder may sit, the vault at depth 1.
    let deep = ned.homeId;
    for (let depth = 2; depth <= 10; depth += 1) deep = await insertFolder(d1.db, ned, deep);
    const moved = await call('PATCH', `/api/folders/${a}`, ned.cookie, { body: JSON.stringify({ parentId: deep }), headers: { 'content-type': 'application/json' } });
    expect(moved.status, await moved.clone().text()).toBe(409);
    const docId = await insertDoc(d1.db, ned);
    const refused = await upload(ned.cookie, docId, 'over.png', OTHER_PNG, 'image/png');
    expect(refused.status, 'the trashed media still count').toBe(413);
  });
});

describe('serving (A§16)', () => {
  it('serves every read private and revalidated (B223), with an ETag that answers 304, a version included', async () => {
    const docId = await insertDoc(d1.db, ada);
    const { asset } = await uploaded(await upload(ada.cookie, docId, 'cache.png', PNG, 'image/png'));
    const served = await call('GET', `/api/docs/${docId}/assets/cache.png`, ada.cookie);
    // A browser holds no read it may show without asking: the next account signed in gets the server's answer.
    expect(served.headers.get('cache-control')).toBe('private, no-cache');
    const etag = served.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const revalidated = await call('GET', `/api/docs/${docId}/assets/cache.png`, ada.cookie, { headers: { 'if-none-match': etag ?? '' } });
    expect(revalidated.status).toBe(304);
    const pinned = await call('GET', `/api/docs/${docId}/assets/cache.png?version=${asset.versionId}`, ada.cookie);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('cache-control'), 'a pinned version revalidates too').toBe('private, no-cache');
    const pinnedAgain = await call('GET', `/api/docs/${docId}/assets/cache.png?version=${asset.versionId}`, ada.cookie, { headers: { 'if-none-match': etag ?? '' } });
    expect(pinnedAgain.status).toBe(304);
    const part = await call('GET', `/api/docs/${docId}/assets/cache.png`, ada.cookie, { headers: { range: 'bytes=0-7' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('cache-control')).toBe('private, no-cache');
    expect(await bytesOf(part)).toEqual(PNG.slice(0, 8));
    // Revalidation asks the server, which answers someone else's request as their own: never a 304 they did not earn.
    expect((await call('GET', `/api/docs/${docId}/assets/cache.png`, cy.cookie, { headers: { 'if-none-match': etag ?? '' } })).status).toBe(404);
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

  it("shows a trashed note's media to its owner's Trash view and gives a grant or link holder the one 404", async () => {
    const docId = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, docId, 'kept.png', PNG, 'image/png'));
    await insertGrant(d1.db, { docId }, ben, 'editor');
    const token = await insertLink(d1.db, { docId }, 'viewer');
    await d1.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').bind(Date.now(), docId).run();
    const path = `/api/docs/${docId}/assets/kept.png`;
    const owner = await call('GET', path, ada.cookie);
    expect(owner.status, 'the owner previews it in Trash').toBe(200);
    expect(await bytesOf(owner)).toEqual(PNG);
    const denied = [await call('GET', path, ben.cookie), await call('GET', `${path}?share=${token}`, null), await call('GET', `${path}?share=${token}`, cy.cookie)];
    expect(denied.map((response) => response.status), 'a grant or link never reaches a trashed note').toEqual([404, 404, 404]);
    expect((await upload(ada.cookie, docId, 'late.png', PNG, 'image/png')).status, 'nor does an upload, even the owner\'s').toBe(404);
  });

  it("gives a reader of one note none of the media its folder's other notes reference", async () => {
    const reader = await signedUpUser(env, 'assets-note-reader', 'Reader');
    const secret = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, secret, 'secret.png', PNG, 'image/png'));
    const shared = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: shared }, reader, 'viewer');
    const token = await insertLink(d1.db, { docId: shared }, 'viewer');
    const path = `/api/docs/${shared}/assets/secret.png`;
    const tries = [
      await call('GET', path, reader.cookie),
      await call('GET', `${path}?share=${token}`, null),
      await call('GET', `${path}?share=${token}`, cy.cookie),
      await call('HEAD', path, reader.cookie),
    ];
    const missing = await call('GET', `/api/docs/${shared}/assets/missing.png`, reader.cookie);
    expect(tries.map((response) => response.status), 'a doc grant or link is not folder-wide media').toEqual([404, 404, 404, 404]);
    expect(await tries[0].text(), 'the refusal is the one 404').toBe(await missing.text());
    // Writing a reference to the file into the note, which any editor of it can, reaches it no better.
    exported.set(shared, '![x](assets/secret.png)\n');
    expect((await call('GET', path, reader.cookie)).status, "a reference the note's editor wrote").toBe(404);
    expect((await call('GET', `${path}?share=${token}`, null)).status).toBe(404);
    expect((await call('GET', path, ada.cookie)).status, 'nor through the folder owner: only the note holding it shows it').toBe(404);
    expect((await call('GET', `/api/docs/${secret}/assets/secret.png`, ada.cookie)).status).toBe(200);
    // What was uploaded into the shared note is its readers' to load.
    await uploaded(await upload(ada.cookie, shared, 'given.png', OTHER_PNG, 'image/png'));
    expect(await bytesOf(await call('GET', `/api/docs/${shared}/assets/given.png`, reader.cookie))).toEqual(OTHER_PNG);
    expect((await call('GET', `/api/docs/${shared}/assets/given.png?share=${token}`, null)).status).toBe(200);
  });

  it('gives a doc-only editor neither a copy nor a duplicate of a folder file they wrote a reference to', async () => {
    const editor = await signedUpUser(env, 'assets-note-editor', 'Editor');
    const secret = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, secret, 'private.png', PNG, 'image/png'));
    const shared = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: shared }, editor, 'editor');
    exported.set(shared, '![x](assets/private.png)\n');
    expect((await call('GET', `/api/docs/${shared}/assets/private.png`, editor.cookie)).status).toBe(404);
    const body = JSON.stringify({ sourceNoteId: shared, sourceRelativePath: 'assets/private.png' });
    const copied = await call('POST', `/api/docs/${shared}/assets/copy`, editor.cookie, { body, headers: { 'content-type': 'application/json' } });
    expect(copied.status, 'a copy into the same note').toBe(404);
    const response = await call('POST', `/api/docs/${shared}/duplicate`, editor.cookie);
    expect(response.status, await response.clone().text()).toBe(201);
    const { doc } = (await response.json()) as { doc: { id: string; folderId: string } };
    expect(doc.folderId).toBe(editor.homeId);
    expect((await call('GET', `/api/docs/${doc.id}/assets/private.png`, editor.cookie)).status, 'a duplicate carries none of it').toBe(404);
  });

  it('refuses a cross-note copy of a file never placed in the readable source note, even one it references', async () => {
    const reader = await signedUpUser(env, 'assets-copy-reader', 'Reader');
    const secret = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, secret, 'hidden.png', PNG, 'image/png'));
    const shared = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: shared }, reader, 'viewer');
    const own = await insertDoc(d1.db, reader);
    const body = JSON.stringify({ sourceNoteId: shared, sourceRelativePath: 'assets/hidden.png' });
    const copied = await call('POST', `/api/docs/${own}/assets/copy`, reader.cookie, { body, headers: { 'content-type': 'application/json' } });
    expect(copied.status).toBe(404);
    expect((await call('GET', `/api/docs/${own}/assets/hidden.png`, reader.cookie)).status).toBe(404);
  });
});

describe('a moved note keeps its media (A§16)', () => {
  const move = (user: TestUser, docId: string, folderId: string) =>
    call('PATCH', `/api/docs/${docId}`, user.cookie, { body: JSON.stringify({ folderId }), headers: { 'content-type': 'application/json' } });

  /** A folder of Ada's whose own note holds `name` with other bytes: a file no reader of a moved note may see. */
  async function folderHolding(name: string): Promise<string> {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const resident = await insertDoc(d1.db, ada, { folderId: folder });
    await uploaded(await upload(ada.cookie, resident, name, OTHER_PNG, 'image/png'));
    return folder;
  }

  it('keeps every file it holds', async () => {
    const docId = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, docId, 'travels.png', PNG, 'image/png'));
    await uploaded(await upload(ada.cookie, docId, 'travels.webm', VIDEO, 'video/webm'));
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const moved = await move(ada, docId, folder);
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await bytesOf(await call('GET', `/api/docs/${docId}/assets/travels.png`, ada.cookie))).toEqual(PNG);
    expect(await bytesOf(await call('GET', `/api/docs/${docId}/assets/travels.webm`, ada.cookie))).toEqual(VIDEO);
  });

  it('keeps showing its own image in a folder holding a same-named private file, to every reader', async () => {
    const folder = await folderHolding('image.png');
    const docId = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, docId, 'image.png', PNG, 'image/png'));
    exported.set(docId, '![Mine](assets/image.png)\n');
    const reader = await signedUpUser(env, 'assets-move-reader', 'Reader');
    await insertGrant(d1.db, { docId }, reader, 'viewer');
    const token = await insertLink(d1.db, { docId }, 'viewer');
    expect((await move(ada, docId, folder)).status).toBe(200);
    for (const [who, cookie, query] of [['the owner', ada.cookie, ''], ['a grant reader', reader.cookie, ''], ['an anonymous link', null, `?share=${token}`]] as const) {
      const served = await call('GET', `/api/docs/${docId}/assets/image.png${query}`, cookie);
      expect(served.status, who).toBe(200);
      expect(await bytesOf(served), `${who} sees the note's own image`).toEqual(PNG);
    }
  });

  it('an upload held open while its note moves lands as the note\'s own file, never a same-named one in the new folder', async () => {
    const folder = await folderHolding('race.png');
    const docId = await insertDoc(d1.db, ada);
    const reader = await signedUpUser(env, 'assets-race-reader', 'Reader');
    await insertGrant(d1.db, { docId }, reader, 'viewer');
    let release = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(PNG);
          controller.close();
        };
      },
    });
    const sending = call('POST', `/api/docs/${docId}/assets?filename=race.png`, ada.cookie, { body, headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) } });
    // The upload resolves its note's access and then waits on the body while the owner moves the note.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await move(ada, docId, folder)).status).toBe(200);
    release();
    const result = await uploaded(await sending);
    for (const [who, cookie] of [['the owner', ada.cookie], ['a grant reader', reader.cookie]] as const) {
      const served = await call('GET', `/api/docs/${docId}/${result.relativePath}`, cookie);
      expect(served.status, who).toBe(200);
      expect(await bytesOf(served), `${who} sees the uploaded bytes`).toEqual(PNG);
    }
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
    // A sibling note gets its own binding to the same bytes; a reader of the source who cannot edit the target is refused.
    const sibling = await insertDoc(d1.db, ada);
    const same = await call('POST', `/api/docs/${sibling}/assets/copy`, ada.cookie, { body, headers: { 'content-type': 'application/json' } });
    expect(((await same.json()) as Uploaded).relativePath).toBe('assets/moved.png');
    expect(await bytesOf(await call('GET', `/api/docs/${sibling}/assets/moved.png`, ada.cookie))).toEqual(PNG);
    await insertGrant(d1.db, { docId: source }, ben, 'viewer');
    await insertGrant(d1.db, { docId: target }, ben, 'viewer');
    expect((await call('POST', `/api/docs/${target}/assets/copy`, ben.cookie, { body, headers: { 'content-type': 'application/json' } })).status).toBe(403);
  });

  it("copies from a source the caller reads only through the link its asset URL carried, kept apart from the page's (B221)", async () => {
    const dot = await signedUpUser(env, 'assets-copy-dot', 'Dot');
    const source = await insertDoc(d1.db, ada);
    const { relativePath } = await uploaded(await upload(ada.cookie, source, 'linked-source.png', SHOT, 'image/png'));
    const sourceLink = await insertLink(d1.db, { docId: source }, 'viewer');
    const own = await insertDoc(d1.db, dot);
    const copy = (target: string, body: Record<string, unknown>, query = '') =>
      call('POST', `/api/docs/${target}/assets/copy${query}`, dot.cookie, {
        body: JSON.stringify({ sourceNoteId: source, sourceRelativePath: relativePath, ...body }), headers: { 'content-type': 'application/json' },
      });
    // Dot has no membership on the source: its viewer link, from the copied URL, opens it for the copy.
    const copied = await copy(own, { sourceShare: sourceLink });
    expect(copied.status, await copied.clone().text()).toBe(201);
    expect(await bytesOf(await call('GET', `/api/docs/${own}/${((await copied.json()) as Uploaded).relativePath}`, dot.cookie))).toEqual(SHOT);
    // Into a target she edits only through the page's own editor link, the two links each open their own note.
    const shared = await insertDoc(d1.db, ada);
    const targetLink = await insertLink(d1.db, { docId: shared }, 'editor');
    const both = await copy(shared, { sourceShare: sourceLink }, `?share=${targetLink}`);
    expect(both.status, await both.clone().text()).toBe(201);
    expect((await call('GET', `/api/docs/${shared}/${relativePath}?share=${targetLink}`, dot.cookie)).status).toBe(200);
    // The source's link never opens the target: an editor link on the source makes her no editor of Ada's other note.
    const sourceEditorLink = await insertLink(d1.db, { docId: source }, 'editor');
    const elsewhere = await insertDoc(d1.db, ada);
    expect((await copy(elsewhere, { sourceShare: sourceEditorLink })).status, 'the source link is not the target').toBe(404);
    // Without it, or with a forged, revoked or another note's link, the source stays closed: the one 404.
    const revoked = await insertLink(d1.db, { docId: source }, 'viewer', { revoked: true });
    const otherNote = await insertLink(d1.db, { docId: await insertDoc(d1.db, ada) }, 'viewer');
    const refusals = [
      await copy(own, {}),
      await copy(own, { sourceShare: 'forged' }),
      await copy(own, { sourceShare: revoked }),
      await copy(own, { sourceShare: otherNote }),
      await copy(shared, {}, `?share=${targetLink}`),
    ];
    expect(refusals.map((response) => response.status), 'missing, forged, revoked and cross-note links').toEqual([404, 404, 404, 404, 404]);
    expect((await copy(own, { sourceShare: 7 })).status, 'a link is a string').toBe(400);
    // A sourceShare that is present opens the source alone, even when empty: never the page's folder link instead.
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const folderLink = await insertLink(d1.db, { folderId: folder }, 'editor');
    const inFolder = await insertDoc(d1.db, ada, { folderId: folder });
    const folderSource = await insertDoc(d1.db, ada, { folderId: folder });
    const { relativePath: folderPath } = await uploaded(await upload(ada.cookie, folderSource, 'folder-source.png', OTHER_PNG, 'image/png'));
    const viaFolder = (body: Record<string, unknown>) => call('POST', `/api/docs/${inFolder}/assets/copy?share=${folderLink}`, dot.cookie, {
      body: JSON.stringify({ sourceNoteId: folderSource, sourceRelativePath: folderPath, ...body }), headers: { 'content-type': 'application/json' },
    });
    expect((await viaFolder({ sourceShare: '' })).status, 'an empty sourceShare is no link').toBe(404);
    expect((await viaFolder({})).status, "with none, the page's link still opens the source").toBe(201);
    // A copy through membership needs no link, as before.
    const member = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, member, 'member.png', OTHER_PNG, 'image/png'));
    await insertGrant(d1.db, { docId: member }, dot, 'viewer');
    const legacy = await call('POST', `/api/docs/${own}/assets/copy`, dot.cookie, {
      body: JSON.stringify({ sourceNoteId: member, sourceRelativePath: 'assets/member.png' }), headers: { 'content-type': 'application/json' },
    });
    expect(legacy.status, await legacy.clone().text()).toBe(201);
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
  });

  it("a duplicate shows its own copy, even in a Home whose other note holds a different file under the name", async () => {
    // A pasted clipboard image is always `image.png`, so most Homes already hold one.
    const cyNote = await insertDoc(d1.db, cy);
    await uploaded(await upload(cy.cookie, cyNote, 'image.png', OTHER_PNG, 'image/png'));
    const docId = await insertDoc(d1.db, ada);
    await uploaded(await upload(ada.cookie, docId, 'image.png', PNG, 'image/png'));
    exported.set(docId, '![Pasted](assets/image.png)\n');
    await insertGrant(d1.db, { docId }, cy, 'editor');
    const response = await call('POST', `/api/docs/${docId}/duplicate`, cy.cookie);
    expect(response.status, await response.clone().text()).toBe(201);
    const { doc } = (await response.json()) as { doc: { id: string; folderId: string } };
    expect(doc.folderId).toBe(cy.homeId);
    // The input, the source's state and its payloads, as the snapshot gave them: nothing renames a reference.
    expect(created.get(doc.id)?.slice(1), "the copy's references are the source's: nothing renames them").toEqual([new Uint8Array([1]), []]);
    expect(await bytesOf(await call('GET', `/api/docs/${doc.id}/assets/image.png`, cy.cookie)), "the copy shows the source's bytes").toEqual(PNG);
    expect(await bytesOf(await call('GET', `/api/docs/${cyNote}/assets/image.png`, cy.cookie)), "Cy's own note keeps its file").toEqual(OTHER_PNG);
  });
});

describe('export (A§12)', () => {
  it("returns the DocDO's markdown to a reader and the one 404 to anyone else", async () => {
    const docId = await insertDoc(d1.db, ada);
    exported.set(docId, '![Alt](assets/x.png)\n');
    const response = await call('GET', `/api/docs/${docId}/content`, ada.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe('![Alt](assets/x.png)\n');
    expect((await call('GET', `/api/docs/${docId}/content`, cy.cookie)).status).toBe(404);
  });
});
