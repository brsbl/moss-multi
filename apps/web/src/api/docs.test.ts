// POST /api/docs writes the D1 row and calls DocDO.create (A§9 "+ Note"); GET /api/docs/:id/instance is the
// owner-only probe (A§19).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { d1Projections } from '@moss-multi/sync/projections';
import { handleApi } from './router.ts';

interface Created {
  docId: string;
  input: unknown;
}

const created: Created[] = [];
const probed: string[] = [];
const exported: string[] = [];
const renamed: { docId: string; title: string }[] = [];
let renameFails = false;
let notificationFails = false;
const publish = async () => { if (notificationFails) throw new Error('PrincipalDO unavailable'); };

/** A DocDO namespace: getServerByName's setName, then the RPCs these routes call. */
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    create: async (input: unknown) => {
      created.push({ docId: id.name, input });
      await d1Projections(d1.db, publish).title(id.name, (input as { title?: string }).title ?? '');
    },
    renameTitle: async (title: string) => {
      if (renameFails) throw new Error('projection unavailable');
      renamed.push({ docId: id.name, title });
      await d1Projections(d1.db, publish).title(id.name, title);
    },
    snapshotForDuplicate: async () => ({ title: 'Original', state: new Uint8Array([1, 2]), markdown: '', media: [] }),
    createFromSnapshot: async (input: unknown) => {
      created.push({ docId: id.name, input });
      await d1Projections(d1.db, publish).title(id.name, (input as { title?: string }).title ?? '');
    },
    exportMarkdown: async () => {
      exported.push(id.name);
      return `Exported ${id.name} {{2+2|4}}\n`;
    },
    probeInstance: async () => {
      probed.push(id.name);
      return { instanceId: `instance-${id.name}`, constructedAt: 1 };
    },
  }),
};

/** A PrincipalDO namespace: grants REST write tokens until `writeTokens` runs out, recording whose DO was asked. */
const tokenAsks: string[] = [];
let writeTokens = Infinity;
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    takeWriteToken: async () => {
      tokenAsks.push(id.name);
      writeTokens -= 1;
      return writeTokens >= 0;
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'docs-ada');
  ben = await signedUpUser(env, 'docs-ben', 'Ben');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  created.length = 0;
  probed.length = 0;
  exported.length = 0;
  renamed.length = 0;
  renameFails = false;
  notificationFails = false;
  tokenAsks.length = 0;
  writeTokens = Infinity;
});

const create = (cookie: string | null, body: unknown = {}, headers: Record<string, string> = {}) =>
  handleApi(
    new Request(`${BASE}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );

interface DocBody {
  doc: { id: string; folderId: string; title: string; filename: string; createdAt: number; updatedAt: number };
}

describe('POST /api/docs', () => {
  it.each([{}, { title: 'Created despite notification failure' }])('keeps a successful create when notification fails: %j', async (body) => {
    const owner = await signedUpUser(env, 'docs-notification');
    notificationFails = true;
    const response = await create(owner.cookie, body);
    expect(response.status).toBe(201);
    const { doc } = await response.json() as DocBody;
    expect(await d1.db.prepare('SELECT id FROM docs WHERE id = ?').bind(doc.id).first()).toEqual({ id: doc.id });
  });

  it('passes markdown, including an empty body, to the server converter without lifting its H1', async () => {
    for (const markdown of ['# Body heading\n\n**Imported** text.', '']) {
      const response = await create(ada.cookie, { title: 'File stem', markdown });
      expect(response.status).toBe(201);
      const { doc } = await response.json() as DocBody;
      expect(doc.title).toBe('File stem');
      expect(created.at(-1)).toEqual({ docId: doc.id, input: { folderId: ada.homeId, ownerId: ada.id, title: 'File stem', markdown } });
    }
  });

  it('refuses invalid and oversized markdown before creating a doc', async () => {
    expect((await create(ada.cookie, { markdown: 42 })).status).toBe(400);
    expect((await create(ada.cookie, { markdown: 'é'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect(created).toEqual([]);
  });

  it('gets 401 without a session', async () => {
    const response = await create(null);
    expect(response.status).toBe(401);
    expect(created).toEqual([]);
  });

  it("creates an empty note in the caller's Home vault and has the DocDO seed it", async () => {
    const response = await create(ada.cookie);
    expect(response.status).toBe(201);
    const { doc } = (await response.json()) as DocBody;
    expect(doc).toMatchObject({ folderId: ada.homeId, title: '', filename: 'untitled.md' });
    const row = await d1.db
      .prepare('SELECT owner_user_id, created_by, folder_id, title, filename, deleted_at FROM docs WHERE id = ?')
      .bind(doc.id)
      .first();
    expect(row).toEqual({ owner_user_id: ada.id, created_by: ada.id, folder_id: ada.homeId, title: '', filename: 'untitled.md', deleted_at: null });
    expect(created).toEqual([{ docId: doc.id, input: { folderId: ada.homeId, ownerId: ada.id } }]);
  });

  it('gives each live note in a folder its own filename', async () => {
    const user = await signedUpUser(env, 'docs-names');
    const names: string[] = [];
    for (let i = 0; i < 3; i += 1) names.push(((await (await create(user.cookie)).json()) as DocBody).doc.filename);
    names.push(((await (await create(user.cookie, { title: '  Café notes ' })).json()) as DocBody).doc.filename);
    expect(names).toEqual(['untitled.md', 'untitled-2.md', 'untitled-3.md', 'café-notes.md']);
  });

  it("gets 404 for a folder the caller does not own, and writes nothing", async () => {
    const response = await create(ben.cookie, { folderId: ada.homeId });
    expect(response.status).toBe(404);
    expect(created).toEqual([]);
    const count = await d1.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE created_by = ?').bind(ben.id).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('gets 403 from a foreign Origin', async () => {
    const response = await create(ada.cookie, {}, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(created).toEqual([]);
  });
});

describe('GET /api/docs/:id/instance', () => {
  const probe = (docId: string, cookie: string | null) =>
    handleApi(new Request(`${BASE}/api/docs/${docId}/instance`, { headers: cookie ? { cookie } : {} }), env);

  it("answers the owner with the DO's instance", async () => {
    const docId = await insertDoc(d1.db, ada);
    const response = await probe(docId, ada.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ instanceId: `instance-${docId}`, constructedAt: 1 });
  });

  it('gives anyone else the same 404 as a missing doc, without waking the DO', async () => {
    const docId = await insertDoc(d1.db, ada);
    const denied = await probe(docId, ben.cookie);
    const missing = await probe(crypto.randomUUID(), ada.cookie);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
    expect((await probe(docId, null)).status).toBe(404);
    expect(probed).toEqual([]);
  });
});


describe('PATCH /api/docs/:id', () => {
  const rename = (id: string, cookie: string, title: string) => handleApi(new Request(`${BASE}/api/docs/${id}`, {
    method: 'PATCH', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ title }),
  }), env);

  it('returns a committed rename when notification fails', async () => {
    const id = await insertDoc(d1.db, ada);
    notificationFails = true;
    const response = await rename(id, ada.cookie, 'Committed rename');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ doc: { title: 'Committed rename' } });
  });

  it('routes an owner rename through the DocDO and returns its projection', async () => {
    const id = await insertDoc(d1.db, ada);
    const response = await rename(id, ada.cookie, 'Renamed via DO');
    expect(response.status).toBe(200);
    expect(renamed).toEqual([{ docId: id, title: 'Renamed via DO' }]);
    expect(await response.json()).toMatchObject({ doc: { title: 'Renamed via DO' } });
  });

  it('does not disclose or write inaccessible documents', async () => {
    const id = await insertDoc(d1.db, ada);
    const denied = await rename(id, ben.cookie, 'Forbidden');
    const missing = await rename(crypto.randomUUID(), ben.cookie, 'Forbidden');
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
    expect(renamed).toEqual([]);
  });

  it('refuses a viewer rename before it reaches the DocDO', async () => {
    const id = await insertDoc(d1.db, ada);
    await d1.db.prepare("INSERT INTO doc_members (doc_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, 'user', 'viewer', ?, ?)")
      .bind(id, ben.id, ada.id, Date.now()).run();
    expect((await rename(id, ben.cookie, 'Viewer write')).status).toBe(403);
    expect(renamed).toEqual([]);
  });

  it("refuses a rename past the caller's own write rate with 429 before it reaches the DocDO @p:tech-8", async () => {
    const id = await insertDoc(d1.db, ada);
    writeTokens = 1;
    expect((await rename(id, ada.cookie, 'Within the rate')).status).toBe(200);
    const limited = await rename(id, ada.cookie, 'Past the rate');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toEqual({ error: 'rate-limited' });
    expect(renamed).toEqual([{ docId: id, title: 'Within the rate' }]);
    expect(tokenAsks).toEqual([ada.id, ada.id]);
  });

  it('spends no write token on a rename it refuses for access', async () => {
    const id = await insertDoc(d1.db, ada);
    expect((await rename(id, ben.cookie, 'Forbidden')).status).toBe(404);
    expect(tokenAsks).toEqual([]);
  });

  it('reports a failed DocDO write as 503', async () => {
    const id = await insertDoc(d1.db, ada);
    renameFails = true;
    expect((await rename(id, ada.cookie, 'Failed')).status).toBe(503);
  });
});

describe('POST /api/docs/:id/duplicate', () => {
  const duplicate = (id: string, cookie: string) => handleApi(new Request(`${BASE}/api/docs/${id}/duplicate`, {
    method: 'POST', headers: { cookie, origin: BASE },
  }), env);

  it('keeps a successful duplicate when notification fails', async () => {
    const id = await insertDoc(d1.db, ada);
    notificationFails = true;
    const response = await duplicate(id, ada.cookie);
    expect(response.status).toBe(201);
    const { doc } = await response.json() as DocBody;
    expect(await d1.db.prepare('SELECT id FROM docs WHERE id = ?').bind(doc.id).first()).toEqual({ id: doc.id });
  });

  it('copies in the source folder for its owner, with a new name and no doc grants', async () => {
    const id = await insertDoc(d1.db, ada);
    const response = await duplicate(id, ada.cookie);
    expect(response.status).toBe(201);
    const { doc } = await response.json() as DocBody;
    expect(doc.id).not.toBe(id);
    expect(doc).toMatchObject({ title: 'Original copy', folderId: ada.homeId });
    expect(created).toEqual([{ docId: doc.id, input: { folderId: ada.homeId, ownerId: ada.id, title: 'Original copy' } }]);
  });

  it('puts a direct editor’s copy in their Home, without granting access to the source folder', async () => {
    const id = await insertDoc(d1.db, ada);
    await d1.db.prepare("INSERT INTO doc_members (doc_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, 'user', ?, ?, 1)").bind(id, ben.id, 'editor', ada.id).run();
    const response = await duplicate(id, ben.cookie);
    expect(response.status).toBe(201);
    const { doc } = await response.json() as DocBody;
    expect(doc.folderId).toBe(ben.homeId);
    expect(await d1.db.prepare('SELECT owner_user_id FROM docs WHERE id = ?').bind(doc.id).first()).toEqual({ owner_user_id: ben.id });
  });

  it('hides inaccessible sources and refuses a viewer without creating anything', async () => {
    const id = await insertDoc(d1.db, ada);
    const denied = await duplicate(id, ben.cookie);
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await (await duplicate(crypto.randomUUID(), ben.cookie)).text());
    await d1.db.prepare("INSERT INTO doc_members (doc_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, 'user', ?, ?, 1)").bind(id, ben.id, 'viewer', ada.id).run();
    expect((await duplicate(id, ben.cookie)).status).toBe(403);
    expect(created).toEqual([]);
  });
});

describe('GET /api/docs/:id/access', () => {
  it('uses the same share-link access as a doc read for a signed-in nonmember', async () => {
    const docId = await insertDoc(d1.db, ada);
    const share = await insertLink(d1.db, { docId }, 'viewer');
    const withoutLink = await handleApi(new Request(`${BASE}/api/docs/${docId}/access`, { headers: { cookie: ben.cookie } }), env);
    expect(withoutLink.status).toBe(404);
    for (const suffix of ['', '/access']) {
      const response = await handleApi(new Request(`${BASE}/api/docs/${docId}${suffix}?share=${share}`, { headers: { cookie: ben.cookie } }), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ role: 'viewer' });
    }
  });
});

describe('GET /api/docs/:id/content (T3.7 Save as Markdown)', () => {
  const content = (docId: string, cookie: string | null, init: RequestInit = {}, query = '') =>
    handleApi(new Request(`${BASE}/api/docs/${docId}/content${query}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } }), env);

  it("answers any reader with the DocDO's export as text/markdown, uncached", async () => {
    const docId = await insertDoc(d1.db, ada);
    const response = await content(docId, ada.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(`Exported ${docId} {{2+2|4}}\n`);
    const share = await insertLink(d1.db, { docId }, 'viewer');
    const viaLink = await content(docId, null, {}, `?share=${share}`);
    expect(viaLink.status, 'an anonymous link reader').toBe(200);
    expect(exported).toEqual([docId, docId]);
  });

  it('gives a caller who cannot read the doc the same 404 as a missing doc, without waking the DO', async () => {
    const docId = await insertDoc(d1.db, ada);
    const trashed = await insertDoc(d1.db, ada, { deleted: true });
    const denied = await content(docId, ben.cookie);
    const missing = await content(crypto.randomUUID(), ben.cookie);
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
    expect((await content(trashed, ada.cookie)).status).toBe(404);
    expect((await content(docId, null)).status).toBe(401);
    expect((await content(docId, ada.cookie, { method: 'POST', headers: { origin: BASE } })).status).toBe(405);
    expect(exported).toEqual([]);
  });
});
