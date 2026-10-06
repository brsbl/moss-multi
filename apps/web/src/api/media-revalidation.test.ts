// Media writes re-check access where they commit (T3.S2; A§8, A§16): an upload whose body (or remote image) is still
// arriving, a cross-note copy and a duplicate carrying media each commit only while the doc is live and the caller can
// still edit it through a grant or link on a live credential. A late write leaves no record, asset, refcount or blob.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { setRemoteFetchForTests } from './remote.ts';
import { handleApi } from './router.ts';

const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137];
let seq = 0;
/** PNG bytes no other test stores, so their hash names only this write. */
const uniquePng = () => new Uint8Array([...PNG, ...new TextEncoder().encode(`${Date.now()}-${(seq += 1)}`)]);
const hashOf = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({
    setName: async () => undefined,
    snapshotForDuplicate: async () => ({ title: 'Original', state: new Uint8Array([1]), payloads: [] }),
    createFromSnapshot: async () => undefined,
  }),
};

/** Upload windows that a test may hold: admission waits on the gate named for the window. */
const gates = new Map<string, Promise<void>>();
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    publish: async () => undefined,
    takeWriteToken: async () => true,
    takeFetchToken: async () => true,
    takeUploadToken: async () => {
      await gates.get(id.name);
      return true;
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

/** Remote images by URL, each a body the test releases. */
const remote = new Map<string, () => ReadableStream<Uint8Array>>();

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'late-ada');
  ben = await signedUpUser(env, 'late-ben', 'Ben');
  cy = await signedUpUser(env, 'late-cy', 'Cy');
  setRemoteFetchForTests({
    fetch: (async (input: RequestInfo | URL) => {
      const body = remote.get(String(input));
      if (!body) throw new Error(`unexpected fetch ${String(input)}`);
      return new Response(body(), { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch,
    resolve: async (host) => (host === 'img.example' ? ['93.184.215.15'] : []),
  });
}, 60_000);
afterAll(() => {
  setRemoteFetchForTests(null);
  return d1?.dispose();
});
afterEach(() => {
  gates.clear();
  remote.clear();
});

/** A body that hands over `bytes` only once released; `reading` settles when the server first asks for it. */
function heldBody(bytes: Uint8Array<ArrayBuffer>) {
  let release = () => {};
  let started = () => {};
  const reading = new Promise<void>((resolve) => (started = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let sent = false;
  const stream = () => new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent) return controller.close();
      started();
      await released;
      sent = true;
      controller.enqueue(bytes);
    },
  }, { highWaterMark: 0 });
  return { stream, reading, release };
}

interface Caller { label: string; headers: Record<string, string>; query: string; id: string }
const asUser = (user: TestUser, query = ''): Caller => ({ label: user.name, headers: { cookie: user.cookie }, query, id: user.id });

function post(path: string, caller: Caller, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const url = `${BASE}${path}${caller.query ? `${path.includes('?') ? '&' : '?'}${caller.query}` : ''}`;
  return handleApi(new Request(url, {
    method: 'POST',
    headers: { origin: BASE, ...caller.headers, ...init.headers },
    body: init.body,
    ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit), env);
}

/** A held write into `docId` by `caller`: the direct upload with its body held, or from-url with the remote body held. */
function heldWrite(route: 'upload' | 'from-url', caller: Caller, docId: string, bytes: Uint8Array<ArrayBuffer>) {
  const held = heldBody(bytes);
  if (route === 'upload') {
    const response = post(`/api/docs/${docId}/assets?filename=late-${seq}.png`, caller, {
      body: held.stream(), headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
    });
    return { response, reading: held.reading, release: held.release };
  }
  const url = `https://img.example/late-${seq}-${caller.id}.png`;
  remote.set(url, held.stream);
  const response = post(`/api/docs/${docId}/assets/from-url`, caller, {
    body: JSON.stringify({ url }), headers: { 'content-type': 'application/json' },
  });
  return { response, reading: held.reading, release: held.release };
}

/** What a media write can leave behind for `docId` and its folder, and for `hash` anywhere. */
async function footprint(docId: string, hash: string) {
  const one = async (sql: string, ...args: unknown[]) => (await d1.db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;
  return {
    docMedia: await one('SELECT COUNT(*) AS n FROM doc_media WHERE doc_id = ?1', docId),
    assets: await one('SELECT COUNT(*) AS n FROM assets WHERE folder_id = (SELECT folder_id FROM docs WHERE id = ?1)', docId),
    lateMedia: await one('SELECT COUNT(*) AS n FROM doc_media WHERE content_hash = ?1', hash),
    lateVersions: await one('SELECT COUNT(*) AS n FROM asset_versions WHERE content_hash = ?1', hash),
    lateRefs: await one('SELECT COALESCE(SUM(refcount), 0) AS n FROM content_objects WHERE hash = ?1', hash),
    lateBlob: (await d1.assets.head(`asset-blobs/sha256/${hash}`)) !== null,
  };
}

interface Scenario {
  name: string;
  /** The caller, with a doc of Ada's they can edit now. */
  setup: () => Promise<{ caller: Caller; docId: string; control: string }>;
  /** Commits the change while the caller's write is in flight. */
  commit: (docId: string, caller: Caller) => Promise<unknown>;
}

const run = (sql: string, ...args: unknown[]) => d1.db.prepare(sql).bind(...args).run();

const SCENARIOS: Scenario[] = [
  {
    name: 'the grant is removed',
    setup: async () => {
      const docId = await insertDoc(d1.db, ada);
      await insertGrant(d1.db, { docId }, ben, 'editor');
      return { caller: asUser(ben), docId, control: docId };
    },
    commit: (docId) => run('DELETE FROM doc_members WHERE doc_id = ?1 AND principal_id = ?2', docId, ben.id),
  },
  {
    name: 'the caller is demoted to viewer',
    setup: async () => {
      const docId = await insertDoc(d1.db, ada);
      await insertGrant(d1.db, { docId }, ben, 'editor');
      return { caller: asUser(ben), docId, control: docId };
    },
    commit: (docId) => run("UPDATE doc_members SET role = 'viewer' WHERE doc_id = ?1 AND principal_id = ?2", docId, ben.id),
  },
  {
    name: "the agent's key is revoked",
    setup: async () => {
      const docId = await insertDoc(d1.db, ada);
      await insertGrant(d1.db, { docId }, ben, 'editor');
      const agent = await insertAgent(d1.db, ben);
      return { caller: { label: 'agent', headers: { authorization: `Bearer ${agent.key}` }, query: '', id: agent.id }, docId, control: docId };
    },
    commit: (_docId, caller) => run('UPDATE agents SET revoked_at = ?2 WHERE id = ?1', caller.id, Date.now()),
  },
  {
    name: 'the editor link is revoked',
    setup: async () => {
      const docId = await insertDoc(d1.db, ada);
      const token = await insertLink(d1.db, { docId }, 'editor');
      return { caller: asUser(cy, `share=${token}`), docId, control: docId };
    },
    commit: (_docId, caller) => run('UPDATE share_links SET revoked_at = ?2 WHERE token = ?1', caller.query.slice('share='.length), Date.now()),
  },
  {
    name: 'the note is trashed',
    setup: async () => {
      const docId = await insertDoc(d1.db, ada);
      await insertGrant(d1.db, { docId }, ben, 'editor');
      return { caller: asUser(ben), docId, control: await insertDoc(d1.db, ada) };
    },
    commit: (docId) => run('UPDATE docs SET deleted_at = ?2 WHERE id = ?1', docId, Date.now()),
  },
];

describe('a media write in flight meets a change committed after its access check (T3.S2)', () => {
  for (const route of ['upload', 'from-url'] as const) {
    it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(`${route}: refused when %s, while Ada's upload lands`, async (_name, scenario) => {
      const { caller, docId, control } = await scenario.setup();
      const late = uniquePng();
      const lateHash = await hashOf(late);
      const before = await footprint(docId, lateHash);
      const controlBefore = await footprint(control, lateHash);
      const write = heldWrite(route, caller, docId, late);
      const allowed = uniquePng();
      const concurrent = heldWrite(route, asUser(ada), control, allowed);
      // Both have passed their access checks and wait on their bytes.
      await Promise.all([write.reading, concurrent.reading]);
      await scenario.commit(docId, caller);
      write.release();
      concurrent.release();
      const [refused, landed] = await Promise.all([write.response, concurrent.response]);
      expect([403, 404], `${caller.label}: ${await refused.clone().text()}`).toContain(refused.status);
      expect(landed.status, `Ada: ${await landed.clone().text()}`).toBe(201);
      expect(await d1.assets.head(`asset-blobs/sha256/${await hashOf(allowed)}`), "Ada's bytes are stored").not.toBeNull();
      const after = await footprint(docId, lateHash);
      // Ada's control upload lands in the same folder, and in the same note unless that note was trashed.
      const added = control === docId ? 1 : 0;
      expect(after, 'the late write leaves nothing').toEqual({ ...before, docMedia: before.docMedia + added, assets: before.assets + 1 });
      expect((await footprint(control, lateHash)).docMedia, "Ada's file is bound").toBe(controlBefore.docMedia + 1);
    }, 30_000);
  }

  it('a cross-note copy refuses a target whose grant was removed after its check', async () => {
    const source = await insertDoc(d1.db, ada);
    const target = await insertDoc(d1.db, ada);
    const bytes = uniquePng();
    const seeded = await post(`/api/docs/${source}/assets?filename=seed.png`, asUser(ada), { body: bytes, headers: { 'content-type': 'image/png' } });
    expect(seeded.status, await seeded.clone().text()).toBe(201);
    await insertGrant(d1.db, { docId: source }, ben, 'viewer');
    await insertGrant(d1.db, { docId: target }, ben, 'editor');
    let open = () => {};
    gates.set(ben.id, new Promise<void>((resolve) => (open = resolve)));
    const copying = post(`/api/docs/${target}/assets/copy`, asUser(ben), {
      body: JSON.stringify({ sourceNoteId: source, sourceRelativePath: 'assets/seed.png' }), headers: { 'content-type': 'application/json' },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await run('DELETE FROM doc_members WHERE doc_id = ?1 AND principal_id = ?2', target, ben.id);
    open();
    const refused = await copying;
    expect([403, 404], await refused.clone().text()).toContain(refused.status);
    expect((await footprint(target, await hashOf(bytes))).docMedia, 'the target binds nothing').toBe(0);
  });

  it('a duplicate carrying media refuses a folder grant removed after its check, leaving no copy', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const source = await insertDoc(d1.db, ada, { folderId: folder });
    const bytes = uniquePng();
    const seeded = await post(`/api/docs/${source}/assets?filename=seed.png`, asUser(ada), { body: bytes, headers: { 'content-type': 'image/png' } });
    expect(seeded.status, await seeded.clone().text()).toBe(201);
    await insertGrant(d1.db, { folderId: folder }, ben, 'editor');
    const docsIn = async () => (await d1.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE folder_id = ?1').bind(folder).first<{ n: number }>())?.n;
    const docsBefore = await docsIn();
    let open = () => {};
    gates.set(ben.id, new Promise<void>((resolve) => (open = resolve)));
    const duplicating = post(`/api/docs/${source}/duplicate`, asUser(ben));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await run('DELETE FROM folder_members WHERE folder_id = ?1 AND principal_id = ?2', folder, ben.id);
    open();
    const refused = await duplicating;
    expect([403, 404], await refused.clone().text()).toContain(refused.status);
    expect(await docsIn(), 'no copy is left in the folder').toBe(docsBefore);
    const media = await d1.db.prepare('SELECT COUNT(*) AS n FROM doc_media WHERE content_hash = ?1').bind(await hashOf(bytes)).first<{ n: number }>();
    expect(media?.n, "only the source binds the file").toBe(1);
  });
});
