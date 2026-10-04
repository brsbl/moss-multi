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
/** Every DocDO trash and restore in order, with the trash batch it names. */
const calls: [op: 'trash' | 'restore', doc: string, batch: unknown][] = [];
let closeFails = 0;
/** While set, a DocDO trash waits for it after being called. */
let trashGate: Promise<void> | null = null;
const published = new Map<string, { type: string; docIds?: string[]; folderIds?: string[] }[]>();

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    trash: async (batch?: unknown) => {
      calls.push(['trash', id.name, batch]);
      await trashGate;
      if (closeFails > 0) {
        closeFails -= 1;
        throw new Error('DocDO unavailable');
      }
      trashed.push(id.name);
    },
    restore: async (batch?: unknown) => { calls.push(['restore', id.name, batch]); restored.push(id.name); },
    exportMarkdown: async () => `Body of ${id.name}\n`,
  }),
};

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
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'trash-ada');
  ben = await signedUpUser(env, 'trash-ben', 'Ben');
  cy = await signedUpUser(env, 'trash-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  trashed.length = 0;
  restored.length = 0;
  calls.length = 0;
  trashGate = null;
  closeFails = 0;
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

  it('answers 503 in words when an open doc did not close, and the owner’s retry closes it', async () => {
    const doc = await insertDoc(d1.db, ada);
    closeFails = 1;
    await expectSentence(await call(ada, 'DELETE', `/api/docs/${doc}`), 503);
    expect((await docRow(doc))?.deleted_at, 'the note is in Trash all the same').not.toBeNull();
    const retry = await call(ada, 'DELETE', `/api/docs/${doc}`);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ action: 'trashed', retentionDays: 30 });
    expect(trashed).toEqual([doc]);
    expect((await call(ben, 'DELETE', `/api/docs/${doc}`)).status, 'nobody else learns it exists').toBe(404);
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

  it('a restore that lands while the trash is still closing the doc names that trash’s batch, so the late close is stale and the note stays live', async () => {
    const doc = await insertDoc(d1.db, ada);
    let release!: () => void;
    trashGate = new Promise((resolve) => { release = resolve; });
    const trashing = call(ada, 'DELETE', `/api/docs/${doc}`);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const { trash_batch_id: batch } = (await docRow(doc)) as { trash_batch_id: string };
    expect((await call(ada, 'POST', `/api/docs/${doc}/restore`)).status).toBe(200);
    release();
    expect((await trashing).status).toBe(200);
    expect(typeof batch).toBe('string');
    // The DocDO orders the two by the batch: a trash of a batch already restored changes nothing.
    expect(calls).toEqual([['trash', doc, batch], ['restore', doc, batch]]);
    expect(await docRow(doc)).toMatchObject({ deleted_at: null, trash_batch_id: null });
  });

  it('a second restore of an older batch never reopens a newer trash', async () => {
    const doc = await insertDoc(d1.db, ada);
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    expect((await call(ada, 'POST', `/api/docs/${doc}/restore`)).status).toBe(200);
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    const [[, , first], [, , restoredBatch], [, , second]] = calls;
    expect(restoredBatch).toBe(first);
    expect(second, 'each trash is its own batch').not.toBe(first);
    expect((await docRow(doc))?.trash_batch_id).toBe(second);
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
});
