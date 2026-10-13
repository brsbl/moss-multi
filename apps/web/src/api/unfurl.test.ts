// Remote fetches (T3.2; A§16, A§18): `POST /api/unfurl` reads a page's OpenGraph card for a web embed, and
// `POST /api/docs/:id/assets/from-url` stores a pasted remote image as the note's own media. Both go through the SSRF
// guard on every hop, answer only callers who can read (or, to store, edit) the note, and are throttled per identity.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';
import { parseCard, parseWork } from './unfurl.ts';
import type { HostResolver } from './ssrf.ts';
import { setRemoteFetchForTests } from './remote.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);

const PAGE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Moss &amp; friends">
<meta property="og:description" content="A note-taking app.">
<meta property="og:site_name" content="Moss">
<meta property="og:image" content="/card.png">
<meta name="theme-color" content="#1a2b3c">
<link rel="icon" href="https://cdn.example/icon.png">
<link rel="canonical" href="https://site.example/home">
</head><body>hi</body></html>`;

/** Hosts the fake DNS answers; anything else resolves to nothing, which fails closed. */
const DNS: Record<string, string[]> = { 'site.example': ['93.184.215.14'], 'img.example': ['93.184.215.15'], 'rebind.example': ['10.0.0.9'] };
const resolve: HostResolver = async (host) => DNS[host] ?? [];

let routes: Record<string, () => Response> = {};
const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  expect(init?.redirect, 'redirects are re-checked by hand').toBe('manual');
  const route = routes[String(input)];
  if (!route) throw new Error(`unexpected fetch ${String(input)}`);
  return route();
});

let fetchTokens = true;
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({
    setName: async () => undefined,
    publish: async () => undefined,
    takeWriteToken: async () => true,
    takeFetchToken: async () => fetchTokens,
    takeUploadToken: async () => true,
  }),
};
const DocDO = { idFromName: (name: string) => ({ name, toString: () => name }), get: () => ({ setName: async () => undefined }) };

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'unfurl-ada');
  ben = await signedUpUser(env, 'unfurl-ben', 'Ben');
  setRemoteFetchForTests({ fetch: fetchImpl as unknown as typeof fetch, resolve });
}, 60_000);
afterAll(() => {
  setRemoteFetchForTests(null);
  d1?.dispose();
});
beforeEach(() => {
  routes = {};
  fetchTokens = true;
  fetchImpl.mockClear();
});

const post = (path: string, cookie: string | null, body: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }), env);

/** A body that sends its first bytes, then resets. */
const resetMidBody = (type: string, first: string) => () => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(first));
  },
  pull(controller) {
    controller.error(new TypeError('connection reset'));
  },
}), { headers: { 'content-type': type } });

const html = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('POST /api/unfurl', () => {
  it("reads a page's OpenGraph card, with relative image URLs made absolute", async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://site.example/'] = html(PAGE);
    const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url: 'https://site.example/' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      status: 'resolved',
      url: 'https://site.example/',
      title: 'Moss & friends',
      description: 'A note-taking app.',
      siteName: 'Moss',
      image: 'https://site.example/card.png',
      icon: 'https://cdn.example/icon.png',
      themeColor: '#1a2b3c',
      canonicalUrl: 'https://site.example/home',
    });
  });

  it('falls back to the <title>, and keeps only https images', async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://site.example/plain'] = html('<html><head><title> Plain  page </title><meta property="og:image" content="http://site.example/x.png"></head></html>');
    const body = (await (await post('/api/unfurl', ada.cookie, { noteId: docId, url: 'https://site.example/plain' })).json()) as Record<string, unknown>;
    expect(body.status).toBe('resolved');
    expect(body.title).toBe('Plain page');
    expect(body.image, 'a cleartext image is never offered').toBeUndefined();
  });

  it('answers a fallback card when the page is not HTML or fails', async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://site.example/file.json'] = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
    routes['https://site.example/broken'] = html('oops', 500);
    for (const url of ['https://site.example/file.json', 'https://site.example/broken']) {
      const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url });
      expect(response.status, url).toBe(200);
      expect(await response.json(), url).toEqual({ status: 'fallback', url });
    }
  });

  it('answers a fallback card when the page resets mid-body', async () => {
    const docId = await insertDoc(d1.db, ada);
    const url = 'https://site.example/reset';
    routes[url] = resetMidBody('text/html', '<html><head><title>Half');
    const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'fallback', url });
  });

  it('answers a fallback card for a host with no DNS answers, fetching nothing', async () => {
    const docId = await insertDoc(d1.db, ada);
    const url = 'https://nowhere.invalid/guide';
    const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'fallback', url });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['the metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['an obfuscated loopback', 'https://2130706433/'],
    ['a host resolving privately', 'https://rebind.example/'],
    ['cleartext http', 'http://site.example/'],
  ])('refuses %s with 422, fetching nothing', async (_label, url) => {
    const docId = await insertDoc(d1.db, ada);
    const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe('blocked-url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a redirect into a private address', async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://site.example/hop'] = () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1:8787/api/me' } });
    const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url: 'https://site.example/hop' });
    expect(response.status).toBe(422);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers only callers who can read the note: a stranger and no one get 404, a link reader its card', async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://site.example/'] = html(PAGE);
    expect((await post('/api/unfurl', ben.cookie, { noteId: docId, url: 'https://site.example/' })).status).toBe(404);
    expect((await post('/api/unfurl', null, { noteId: docId, url: 'https://site.example/' })).status).toBe(404);
    const token = await insertLink(d1.db, { docId }, 'viewer');
    const anonymous = await post(`/api/unfurl?share=${token}`, null, { noteId: docId, url: 'https://site.example/' });
    expect(anonymous.status).toBe(200);
    expect(((await anonymous.json()) as { title: string }).title).toBe('Moss & friends');
  });

  it('throttles with 429 once the identity is out of fetch tokens', async () => {
    const docId = await insertDoc(d1.db, ada);
    fetchTokens = false;
    const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url: 'https://site.example/' });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a body without a note or a URL', async () => {
    expect((await post('/api/unfurl', ada.cookie, { url: 'https://site.example/' })).status).toBe(400);
    expect((await post('/api/unfurl', ada.cookie, { noteId: await insertDoc(d1.db, ada) })).status).toBe(400);
  });
});

/** The page prefix parseCard reads; hostile pages are grown to it. */
const CAP = 512 * 1024;
/** Openers with no closing delimiter, each of which used to rescan the rest of the page. */
const UNCLOSED: [string, string][] = [['meta', '<meta '], ['link', '<LINK '], ['title without >', '<title '], ['title without </title>', '<title>']];
const hostile = (opener: string, bytes: number) => opener.repeat(Math.ceil(bytes / opener.length)).slice(0, bytes);

/**
 * Runs `run` on pages doubling to the cap: parseCard's searches pass over at most about twice the characters for twice
 * the page (a rescan per opener is quadratic), and the cap page takes under `ceilingMs`, a generous backstop.
 */
async function expectLinear(opener: string, run: (body: string, size: number) => Promise<void> | void, ceilingMs: number) {
  const scanned = async (size: number) => {
    const body = hostile(opener, size);
    parseWork.scanned = 0;
    const startedAt = performance.now();
    await run(body, size);
    return { work: parseWork.scanned, ms: performance.now() - startedAt };
  };
  let previous = (await scanned(2048)).work;
  let last = { work: previous, ms: 0 };
  for (let size = 4096; size <= CAP; size *= 2) {
    last = await scanned(size);
    expect(last.work, `${size} bytes scanned ${last.work} characters after ${previous} for half`).toBeLessThanOrEqual(2 * previous + 64);
    expect(last.work, `${size} bytes scanned ${last.work} characters`).toBeLessThanOrEqual(4 * size);
    previous = last.work;
  }
  expect(last.ms, `the ${CAP}-byte page took ${Math.round(last.ms)} ms`).toBeLessThan(ceilingMs);
}

/** The tags the regexes before T3.S12 read, rebuilt as a well-formed page: the answer key for ordinary pages. */
function regexReading(head: string): string {
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag);
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => tag);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  return `${title === undefined ? '' : `<title>${title}</title>`}${metas.join('')}${links.join('')}`;
}

describe('parseCard on hostile and ordinary pages', () => {
  it.each(UNCLOSED)('reads repeated unclosed %s openers in linear time, within budget', async (_label, opener) => {
    const empty = parseCard('', 'https://site.example/');
    await expectLinear(opener, (body) => {
      expect(parseCard(body, 'https://site.example/')).toEqual(empty);
    }, 2_500);
  }, 120_000);

  it.each([
    ['the OpenGraph page', PAGE],
    ['upper-case tags and a title with attributes', '<HTML><HEAD><TITLE lang="en">Shout &lt;3</TITLE><META NAME="description" CONTENT="Loud"><LINK REL="apple-touch-icon" HREF="/t.png"></HEAD>'],
    ['Twitter tags over the title', "<title>Plain</title><meta name='twitter:title' content='Tweet'><meta name=twitter:image content=https://img.example/t.png>"],
    ['look-alike tags', '<metadata name="description" content="no"><meta-x name="description" content="no"><linkage rel="icon" href="/no.png"><titles>This one</titles><meta name="description" content="yes"><meta_x name="theme-color" content="#000"><meta name="theme-color" content="#fff">'],
    ['the first of each tag', '<title>One</title><title>Two</title><meta property="og:title" content="A"><meta property="og:title" content="B"><link rel="icon" href="/a.png"><link rel="icon" href="/b.png">'],
    ['an opener inside a tag', '<meta name="x" <meta property="og:title" content="Inner"><link <link rel="canonical" href="/c"><meta\tname="description" content="tab">'],
    ['an unclosed title then a closed one', '<title>Lost<meta name="description" content="d"></title><title>Kept</title>'],
    ['a title opener with no >', '<meta name="description" content="d"><title'],
    ['a title with no </title>', '<title>Open<meta name="description" content="d">'],
    ['a meta opener with no >, then a closed one', '<meta name="description" content="d"<meta property="og:title" content="t">'],
    ['a meta at the very end', '<title>T</title><meta'],
  ])('reads %s as the regexes did', (_label, page) => {
    const url = 'https://site.example/page';
    const reading = regexReading(page);
    expect(parseCard(page, url), reading).toEqual(parseCard(reading, url));
  });
});

describe('POST /api/unfurl on a hostile page', () => {
  it.each(UNCLOSED)('answers a fallback card for repeated unclosed %s openers in linear time, then serves the next request', async (label, opener) => {
    const docId = await insertDoc(d1.db, ada);
    let n = 0;
    await expectLinear(opener, async (body, size) => {
      const url = `https://site.example/hostile-${label.replace(/\W+/g, '-')}-${size}-${n++}`;
      routes[url] = html(body);
      const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'fallback', url });
    }, 10_000);
    routes['https://site.example/'] = html(PAGE);
    const startedAt = performance.now();
    const response = await post('/api/unfurl', ada.cookie, { noteId: docId, url: 'https://site.example/' });
    expect(((await response.json()) as { title: string }).title).toBe('Moss & friends');
    expect(performance.now() - startedAt, 'the next request is served promptly').toBeLessThan(1000);
  }, 120_000);
});

describe('POST /api/docs/:id/assets/from-url (images.persistUrl)', () => {
  const image = (bytes: Uint8Array<ArrayBuffer>, type = 'image/png') => () => new Response(bytes, { headers: { 'content-type': type } });

  it("stores an editor's remote image as the note's own media", async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://img.example/pics/cat'] = image(PNG);
    const response = await post(`/api/docs/${docId}/assets/from-url`, ada.cookie, { url: 'https://img.example/pics/cat' });
    expect(response.status, await response.clone().text()).toBe(201);
    const saved = (await response.json()) as { relativePath: string; filename: string };
    expect(saved.relativePath).toBe('assets/cat.png');
    const served = await handleApi(new Request(`${BASE}/api/docs/${docId}/assets/cat.png`, { headers: { cookie: ada.cookie } }), env);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it('takes the filename hint, given the type the server sent', async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://img.example/a.jpg?x=1'] = image(PNG, 'image/png');
    const response = await post(`/api/docs/${docId}/assets/from-url`, ada.cookie, { url: 'https://img.example/a.jpg?x=1', filename: 'Holiday photo' });
    expect(((await response.json()) as { filename: string }).filename).toBe('Holiday-photo.png');
  });

  it('refuses a viewer 403 and a stranger 404, fetching nothing', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    expect((await post(`/api/docs/${docId}/assets/from-url`, ben.cookie, { url: 'https://img.example/cat.png' })).status).toBe(403);
    const other = await insertDoc(d1.db, ada);
    expect((await post(`/api/docs/${other}/assets/from-url`, ben.cookie, { url: 'https://img.example/cat.png' })).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['the metadata address', 'https://169.254.169.254/latest/meta-data/iam'],
    ['a ULA literal', 'https://[fd00::1]/cat.png'],
    ['a host resolving privately', 'https://rebind.example/cat.png'],
  ])('refuses %s with 422', async (_label, url) => {
    const docId = await insertDoc(d1.db, ada);
    const response = await post(`/api/docs/${docId}/assets/from-url`, ada.cookie, { url });
    expect(response.status).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses something that is not an image with 415, and an oversized one with 413', async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://img.example/page'] = html('<p>not an image</p>');
    routes['https://img.example/clip.mp4'] = image(new Uint8Array([0, 0, 0, 24]), 'video/mp4');
    routes['https://img.example/huge.png'] = () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) } });
    expect((await post(`/api/docs/${docId}/assets/from-url`, ada.cookie, { url: 'https://img.example/page' })).status).toBe(415);
    expect((await post(`/api/docs/${docId}/assets/from-url`, ada.cookie, { url: 'https://img.example/clip.mp4' })).status).toBe(415);
    expect((await post(`/api/docs/${docId}/assets/from-url`, ada.cookie, { url: 'https://img.example/huge.png' })).status).toBe(413);
  });

  it('answers 502 when the image cannot be downloaded', async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://img.example/gone.png'] = () => new Response('missing', { status: 404 });
    expect((await post(`/api/docs/${docId}/assets/from-url`, ada.cookie, { url: 'https://img.example/gone.png' })).status).toBe(502);
  });

  it('answers 502 when the image resets mid-body', async () => {
    const docId = await insertDoc(d1.db, ada);
    routes['https://img.example/reset.png'] = resetMidBody('image/png', 'PNG');
    expect((await post(`/api/docs/${docId}/assets/from-url`, ada.cookie, { url: 'https://img.example/reset.png' })).status).toBe(502);
  });
});
