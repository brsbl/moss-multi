// Trash and restore (T2.3; A§8, A§11): only the owner trashes and restores a note, on ownership alone; a trash stamps
// the row, closes every open socket through DocDO.trash and tells everyone who could see it; a trashed note answers
// every other route with the one 404, while its owner reads it on the one trashed-doc read path; restore brings it
// back where it can live.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const trashed: string[] = [];
const restored: string[] = [];
/** Every DocDO trash (a hold) and settle in order, with the hold it names and whether D1 had the note trashed then. */
const calls: [op: 'trash' | 'settle', doc: string, hold: string | undefined, trashedInD1: boolean][] = [];
/** The DocDO as A§5.1 models it: a note admits sockets only with no hold and a live row at its last settle. */
const model = new Map<string, { holds: Set<string>; deleted: boolean }>();
let closeFails = 0;
let settleFails = 0;
/** While set, a settle that names a hold waits for it. */
let settleGate: Promise<void> | null = null;
/** While set, the next D1 statement matching it fails, as a D1 outage would. */
let failSql: RegExp | null = null;
const published = new Map<string, { type: string; docIds?: string[]; folderIds?: string[] }[]>();

const docState = (doc: string) => model.get(doc) ?? model.set(doc, { holds: new Set(), deleted: false }).get(doc)!;
const trashedInD1 = async (doc: string) => (await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(doc).first<{ deleted_at: number | null }>())?.deleted_at != null;
/** Whether the DocDO admits a socket to the note. */
const admits = (doc: string) => docState(doc).holds.size === 0 && !docState(doc).deleted;

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    trash: async (hold: string) => {
      calls.push(['trash', id.name, hold, await trashedInD1(id.name)]);
      if (closeFails > 0) {
        closeFails -= 1;
        throw new Error('DocDO unavailable');
      }
      docState(id.name).holds.add(hold);
      trashed.push(id.name);
    },
    settle: async (hold?: string) => {
      if (hold) await settleGate;
      const deleted = await trashedInD1(id.name);
      calls.push(['settle', id.name, hold, deleted]);
      if (settleFails > 0) {
        settleFails -= 1;
        throw new Error('DocDO unavailable');
      }
      const state = docState(id.name);
      if (hold) state.holds.delete(hold);
      if (state.deleted && !deleted) restored.push(id.name);
      state.deleted = deleted;
      return { deleted };
    },
    exportMarkdown: async () => `Body of ${id.name}\n`,
  }),
};

/** D1 as the routes see it: the test's D1, except a statement matching failSql fails once. */
function flakyDb(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key, target);
      return (sql: string) => {
        if (!failSql?.test(sql)) return target.prepare(sql);
        failSql = null;
        const refuse = async () => { throw new Error('D1_ERROR: storage unavailable'); };
        const failing = { bind: () => failing, run: refuse, all: refuse, raw: refuse, first: refuse };
        return failing;
      };
    },
  });
}

const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    publish: async (event: { type: string }) => { published.set(id.name, [...(published.get(id.name) ?? []), event]); },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: flakyDb(d1.db), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'trash-ada');
  ben = await signedUpUser(env, 'trash-ben', 'Ben');
  cy = await signedUpUser(env, 'trash-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  trashed.length = 0;
  restored.length = 0;
  calls.length = 0;
  model.clear();
  settleGate = null;
  failSql = null;
  closeFails = 0;
  settleFails = 0;
  published.clear();
});

const call = (user: TestUser | null, method: string, path: string, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, 'content-type': 'application/json', ...(user ? { cookie: user.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

const docRow = (id: string) => d1.db.prepare('SELECT * FROM docs WHERE id = ?').bind(id).first<Record<string, unknown>>();

async function expectSentence(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error?: string; message?: string };
  expect(typeof body.error).toBe('string');
  expect(body.message).toMatch(/^[A-Z].*\S \S.*[.!]$/);
}

/** A response's status and exact bytes, for byte-identical comparisons. */
const bytes = async (response: Response) => ({ status: response.status, body: await response.text() });

describe('DELETE /api/docs/:id', () => {
  it('moves the owner’s note to Trash: the row is stamped, open sockets close, everyone who could see it hears, and the answer says it is restorable for 30 days', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'editor');
    const before = Date.now();
    const response = await call(ada, 'DELETE', `/api/docs/${doc}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'trashed', restorable: true, retentionDays: 30, doc: { id: doc } });
    const row = await docRow(doc);
    expect(row?.deleted_at).toBeGreaterThanOrEqual(before);
    expect(typeof row?.trash_batch_id).toBe('string');
    expect(trashed).toEqual([doc]);
    for (const principal of [ada.id, ben.id]) {
      expect(published.get(principal), `${principal} hears about the trash`).toContainEqual({ type: 'meta', docIds: [doc], folderIds: [] });
    }
    expect(published.has(cy.id)).toBe(false);
  });

  it('refuses an editor by grant, a viewer, and an editor-link holder in words; a stranger gets the one 404', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'editor');
    await expectSentence(await call(ben, 'DELETE', `/api/docs/${doc}`), 403);
    const viewed = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: viewed }, ben, 'viewer');
    await expectSentence(await call(ben, 'DELETE', `/api/docs/${viewed}`), 403);
    const linked = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId: linked }, 'editor');
    await expectSentence(await call(cy, 'DELETE', `/api/docs/${linked}?share=${token}`), 403);
    const stranger = await bytes(await call(cy, 'DELETE', `/api/docs/${doc}`));
    const missing = await bytes(await call(cy, 'DELETE', `/api/docs/${crypto.randomUUID()}`));
    expect(stranger).toEqual(missing);
    expect(stranger.status).toBe(404);
    for (const id of [doc, viewed, linked]) expect((await docRow(id))?.deleted_at).toBeNull();
    expect(trashed).toEqual([]);
  });

  it('closes the note on its DocDO before the row commits, and settles it from the committed row', async () => {
    const doc = await insertDoc(d1.db, ada);
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    const { trash_batch_id: batch } = (await docRow(doc)) as { trash_batch_id: string };
    expect(calls).toEqual([['trash', doc, batch, false], ['settle', doc, batch, true]]);
    expect(admits(doc)).toBe(false);
  });

  it('a DocDO that cannot close the note fails the trash before anything commits, in words, and the owner’s retry trashes it', async () => {
    const doc = await insertDoc(d1.db, ada);
    closeFails = 1;
    await expectSentence(await call(ada, 'DELETE', `/api/docs/${doc}`), 503);
    expect((await docRow(doc))?.deleted_at, 'nothing committed').toBeNull();
    expect(admits(doc), 'and the note stays open').toBe(true);
    const retry = await call(ada, 'DELETE', `/api/docs/${doc}`);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ action: 'trashed', retentionDays: 30 });
    expect(trashed).toEqual([doc]);
    expect(admits(doc)).toBe(false);
    expect((await call(ben, 'DELETE', `/api/docs/${doc}`)).status, 'nobody else learns it exists').toBe(404);
  });

  it('a D1 failure after the note closed reopens it from the row, in words, and nothing is trashed', async () => {
    const doc = await insertDoc(d1.db, ada);
    failSql = /^update "docs"/i;
    await expectSentence(await call(ada, 'DELETE', `/api/docs/${doc}`), 503);
    expect((await docRow(doc))?.deleted_at).toBeNull();
    expect(calls.map(([op, , , inD1]) => [op, inD1])).toEqual([['trash', false], ['settle', false]]);
    expect(admits(doc), 'the states agree: live').toBe(true);
  });

  it('a settle that fails after the commit leaves the note held closed: the trash stands and no write lands', async () => {
    const doc = await insertDoc(d1.db, ada);
    settleFails = 1;
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    expect((await docRow(doc))?.deleted_at).not.toBeNull();
    expect(admits(doc)).toBe(false);
    // The owner's repeat settles it from the row.
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    expect(calls.at(-1)).toEqual(['settle', doc, undefined, true]);
  });

  it('a trashed note gets the byte-identical 404 on a fresh load, for its owner too, and refuses changes', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'editor');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    const missing = crypto.randomUUID();
    for (const user of [ben, ada]) {
      expect(await bytes(await call(user, 'GET', `/api/docs/${doc}`))).toEqual(await bytes(await call(user, 'GET', `/api/docs/${missing}`)));
    }
    expect((await call(ada, 'PATCH', `/api/docs/${doc}`, { title: 'Late' })).status).toBe(404);
    expect((await call(ben, 'GET', `/api/trash/${doc}`)).status).toBe(404);
  });
});

describe('GET /api/trash/:id, the owner’s one read path for a trashed note', () => {
  it('gives the owner the trashed note and its markdown, and everyone else the one 404', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'editor');
    expect((await call(ada, 'GET', `/api/trash/${doc}`)).status, 'a live note is not in Trash').toBe(404);
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    const response = await call(ada, 'GET', `/api/trash/${doc}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { doc: { id: string; trashedAt: number }; markdown: string };
    expect(body.doc.id).toBe(doc);
    expect(body.doc.trashedAt).toBeGreaterThan(0);
    expect(body.markdown).toBe(`Body of ${doc}\n`);
    const missing = await bytes(await call(ben, 'GET', `/api/trash/${crypto.randomUUID()}`));
    expect(await bytes(await call(ben, 'GET', `/api/trash/${doc}`))).toEqual(missing);
    expect(await bytes(await call(cy, 'GET', `/api/trash/${doc}`))).toEqual(missing);
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/docs/:id/restore', () => {
  it('brings the owner’s note back: the row is live, the doc reopens and everyone who can see it hears', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'editor');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    published.clear();
    const response = await call(ada, 'POST', `/api/docs/${doc}/restore`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ doc: { id: doc, folderId: ada.homeId } });
    expect(await docRow(doc)).toMatchObject({ deleted_at: null, trash_batch_id: null });
    expect(restored).toEqual([doc]);
    for (const principal of [ada.id, ben.id]) expect(published.get(principal)).toContainEqual({ type: 'meta', docIds: [doc], folderIds: [] });
    expect((await call(ben, 'GET', `/api/docs/${doc}`)).status, 'a fresh load opens again').toBe(200);
  });

  it('restores a note from a trashed folder to its vault’s root, stepping aside from a filename the root now holds', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await d1.db.prepare('UPDATE docs SET filename = ? WHERE id = ?').bind('plans.md', doc).run();
    const trashFolder = await call(ada, 'DELETE', `/api/folders/${folder}`);
    expect(trashFolder.status).toBe(200);
    expect(await trashFolder.json(), 'a folder’s trash says the same').toMatchObject({ action: 'trashed', restorable: true, retentionDays: 30 });
    const twin = await insertDoc(d1.db, ada);
    await d1.db.prepare('UPDATE docs SET filename = ? WHERE id = ?').bind('plans.md', twin).run();
    const response = await call(ada, 'POST', `/api/docs/${doc}/restore`);
    expect(response.status).toBe(200);
    const row = await docRow(doc);
    expect(row).toMatchObject({ folder_id: ada.homeId, deleted_at: null });
    expect(row?.filename).not.toBe('plans.md');
  });

  it('restore commits the row before the doc reopens, so the doc never admits a socket the row refuses', async () => {
    const doc = await insertDoc(d1.db, ada);
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    calls.length = 0;
    expect((await call(ada, 'POST', `/api/docs/${doc}/restore`)).status).toBe(200);
    expect(calls).toEqual([['settle', doc, undefined, false]]);
    expect(admits(doc)).toBe(true);
  });

  it('a D1 failure in restore never reopens the doc: it answers in words and the note stays in Trash, closed', async () => {
    const doc = await insertDoc(d1.db, ada);
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    calls.length = 0;
    failSql = /^update "docs"/i;
    await expectSentence(await call(ada, 'POST', `/api/docs/${doc}/restore`), 503);
    expect((await docRow(doc))?.deleted_at).not.toBeNull();
    expect(calls).toEqual([]);
    expect(admits(doc)).toBe(false);
    expect((await call(ada, 'POST', `/api/docs/${doc}/restore`)).status, 'the retry restores it').toBe(200);
    expect(admits(doc)).toBe(true);
  });

  it('a restore that lands while the trash is still settling converges: the row is live and the doc admits again', async () => {
    const doc = await insertDoc(d1.db, ada);
    let release!: () => void;
    settleGate = new Promise((resolve) => { release = resolve; });
    const trashing = call(ada, 'DELETE', `/api/docs/${doc}`);
    await vi.waitFor(async () => expect(await trashedInD1(doc)).toBe(true));
    expect((await call(ada, 'POST', `/api/docs/${doc}/restore`)).status).toBe(200);
    expect(admits(doc), 'the trash still holds it').toBe(false);
    release();
    expect((await trashing).status).toBe(200);
    expect(await docRow(doc)).toMatchObject({ deleted_at: null, trash_batch_id: null });
    expect(admits(doc), 'the states agree: live').toBe(true);
  });

  it('refuses everyone but the owner: an editor in words, a stranger with the one 404', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'editor');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    const missing = await bytes(await call(cy, 'POST', `/api/docs/${crypto.randomUUID()}/restore`));
    expect(await bytes(await call(cy, 'POST', `/api/docs/${doc}/restore`))).toEqual(missing);
    expect(await bytes(await call(ben, 'POST', `/api/docs/${doc}/restore`))).toEqual(missing);
    expect((await docRow(doc))?.deleted_at).not.toBeNull();
    expect(restored).toEqual([]);
  });
});

describe('the workspace listing', () => {
  it('lists the owner’s trashed notes in the active vault with when they were trashed, and nobody else’s', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'editor');
    const live = await insertDoc(d1.db, ada);
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    const mine = (await (await call(ada, 'GET', '/api/workspace')).json()) as { docs: { id: string; trashedAt?: number | null; folderPath: string }[] };
    expect(mine.docs.find((row) => row.id === doc)).toMatchObject({ folderPath: 'Notes', trashedAt: expect.any(Number) });
    expect(mine.docs.find((row) => row.id === live)?.trashedAt ?? null).toBeNull();
    const theirs = (await (await call(ben, 'GET', '/api/workspace')).json()) as { docs: { id: string }[] };
    expect(theirs.docs.map((row) => row.id)).not.toContain(doc);
    const refreshed = (await (await call(ada, 'GET', `/api/workspace?vault=${ada.homeId}&ids=${doc}`)).json()) as { docs: { id: string; trashedAt?: number }[] };
    expect(refreshed.docs).toEqual([expect.objectContaining({ id: doc, trashedAt: expect.any(Number) })]);
  });

  it('lists a note for a co-owner who trashed it, by a doc grant or a vault grant, so he can restore it from Trash', async () => {
    type Listing = { docs: { id: string; trashedAt?: number | null; role: string }[] };
    const list = async (user: TestUser, query = '') => ((await (await call(user, 'GET', `/api/workspace${query}`)).json()) as Listing).docs;
    const byDoc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: byDoc }, ben, 'owner');
    const vault = await insertFolder(d1.db, ada, null);
    const byVault = await insertDoc(d1.db, ada, { folderId: vault });
    await insertGrant(d1.db, { folderId: vault }, ben, 'owner');
    const editorOnly = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: editorOnly }, cy, 'editor');
    expect((await call(ben, 'DELETE', `/api/docs/${byDoc}`)).status).toBe(200);
    expect((await call(ben, 'DELETE', `/api/docs/${byVault}`)).status).toBe(200);
    expect((await call(ada, 'DELETE', `/api/docs/${editorOnly}`)).status).toBe(200);

    expect((await list(ben)).find((row) => row.id === byDoc)).toMatchObject({ trashedAt: expect.any(Number), role: 'owner' });
    expect((await list(ben, `?vault=${vault}`)).find((row) => row.id === byVault)).toMatchObject({ trashedAt: expect.any(Number), role: 'owner' });
    expect((await list(ben)).map((row) => row.id), 'a note in a vault he can see lists only in that vault').not.toContain(byVault);
    expect((await list(cy)).map((row) => row.id), 'an editor never sees it in Trash').not.toContain(editorOnly);
    expect((await list(ada)).find((row) => row.id === byDoc)).toMatchObject({ trashedAt: expect.any(Number) });

    expect((await call(ben, 'POST', `/api/docs/${byDoc}/restore`)).status).toBe(200);
    expect((await list(ben)).find((row) => row.id === byDoc)?.trashedAt ?? null).toBeNull();
  });
});
