// The folders API (T2.2; A§6, A§8, A§9): create, rename, move and trash folders, and move notes between them.
// Editors create in shared vaults with created_by recorded; only the owner trashes; a trashed subtree is one batch
// whose open docs are closed through DocDO.trash; every refusal is a sentence.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const trashed: string[] = [];
/** Each DocDO hold, with the doc's deleted_at when it was taken, and each settle, with the hold it releases. */
const holds: [doc: string, hold: string, deletedAt: unknown][] = [];
const settled: [doc: string, hold: string | undefined, deleted: boolean][] = [];
let trashFails = false;
const published = new Map<string, { type: string; docIds?: string[]; folderIds?: string[] }[]>();

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    trash: async (hold: string) => {
      if (trashFails) throw new Error('DocDO unavailable');
      holds.push([id.name, hold, (await docRow(id.name))?.deleted_at ?? null]);
      trashed.push(id.name);
    },
    settle: async (hold?: string) => {
      const deleted = (await docRow(id.name))?.deleted_at != null;
      settled.push([id.name, hold, deleted]);
      return { deleted };
    },
    create: async () => undefined,
    createFromSnapshot: async () => undefined,
    snapshotForDuplicate: async () => ({ title: 'Source', state: new Uint8Array(), markdown: '', media: [] }),
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
  ada = await signedUpUser(env, 'folders-ada');
  ben = await signedUpUser(env, 'folders-ben', 'Ben');
  cy = await signedUpUser(env, 'folders-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  trashed.length = 0;
  holds.length = 0;
  settled.length = 0;
  trashFails = false;
  published.clear();
});

const call = (user: TestUser | null, method: string, path: string, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, 'content-type': 'application/json', ...(user ? { cookie: user.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

interface FolderBody { folder: { id: string; name: string; parentId: string } }

async function create(user: TestUser, parentId: string, name: string): Promise<string> {
  const response = await call(user, 'POST', '/api/folders', { parentId, name });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as FolderBody).folder.id;
}

const row = (id: string) => d1.db.prepare('SELECT * FROM folders WHERE id = ?').bind(id).first<Record<string, unknown>>();
const docRow = (id: string) => d1.db.prepare('SELECT * FROM docs WHERE id = ?').bind(id).first<Record<string, unknown>>();

/** A refusal is a JSON `{error, message}` whose message is a sentence, never a code or a bare "Failed". */
async function expectSentence(response: Response, status: number, pattern?: RegExp): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error?: string; message?: string };
  expect(typeof body.error).toBe('string');
  expect(body.message).toMatch(/^[A-Z].*\S \S.*[.!]$/);
  expect(body.message).not.toMatch(/Unknown parent folder|^Failed$/);
  if (pattern) expect(body.message).toMatch(pattern);
}

describe('POST /api/folders', () => {
  it('creates a folder in the caller’s vault and under a folder, recording who made it', async () => {
    const top = await create(ada, ada.homeId, 'Plans');
    expect(await row(top)).toMatchObject({ owner_user_id: ada.id, created_by: ada.id, name: 'Plans', kind: 'folder', parent_id: ada.homeId, deleted_at: null });
    const nested = await create(ada, top, 'Drafts');
    expect(await row(nested)).toMatchObject({ parent_id: top });
    expect(published.get(ada.id)).toContainEqual({ type: 'meta', docIds: [], folderIds: [nested] });
  });

  it('lets an editor on a shared vault create there: the vault owner owns it and created_by names the editor', async () => {
    const vault = (await signedUpUser(env, 'folders-shared')).homeId;
    const owner = (await d1.db.prepare('SELECT owner_user_id FROM folders WHERE id = ?').bind(vault).first<{ owner_user_id: string }>())!.owner_user_id;
    await insertGrant(d1.db, { folderId: vault }, ben, 'editor');
    const id = await create(ben, vault, 'Ben research');
    expect(await row(id)).toMatchObject({ owner_user_id: owner, created_by: ben.id, parent_id: vault });
    expect(published.get(owner), 'the owner hears about it').toContainEqual({ type: 'meta', docIds: [], folderIds: [id] });
    expect(published.get(ben.id)).toContainEqual({ type: 'meta', docIds: [], folderIds: [id] });
  });

  it('refuses a viewer in words, and answers an inaccessible or missing parent with the one 404', async () => {
    const vault = (await signedUpUser(env, 'folders-viewer')).homeId;
    await insertGrant(d1.db, { folderId: vault }, cy, 'viewer');
    await expectSentence(await call(cy, 'POST', '/api/folders', { parentId: vault, name: 'Nope' }), 403);
    const hidden = await call(ben, 'POST', '/api/folders', { parentId: ada.homeId, name: 'Nope' });
    const missing = await call(ben, 'POST', '/api/folders', { parentId: crypto.randomUUID(), name: 'Nope' });
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe(await missing.text());
  });

  it('refuses a duplicate sibling name case-insensitively, a bad name and a trashed parent, each in words', async () => {
    const parent = await create(ada, ada.homeId, 'Duplicates');
    await create(ada, parent, 'Roadmap');
    await expectSentence(await call(ada, 'POST', '/api/folders', { parentId: parent, name: 'roadmap' }), 409, /already/);
    await expectSentence(await call(ada, 'POST', '/api/folders', { parentId: parent, name: '  ' }), 400);
    await expectSentence(await call(ada, 'POST', '/api/folders', { parentId: parent, name: 'a/b' }), 400);
    await expectSentence(await call(ada, 'POST', '/api/folders', { parentId: parent, name: 'x'.repeat(101) }), 400);
    expect((await call(ada, 'DELETE', `/api/folders/${parent}`)).status).toBe(200);
    await expectSentence(await call(ada, 'POST', '/api/folders', { parentId: parent, name: 'Late' }), 404, /no longer/);
  });

  it('refuses nesting deeper than the access resolver reads', async () => {
    let parent = ada.homeId;
    for (let depth = 1; depth <= 10; depth += 1) parent = await create(ada, parent, `Level ${depth}`);
    await expectSentence(await call(ada, 'POST', '/api/folders', { parentId: parent, name: 'Level 11' }), 409, /deep/);
  });

  it('needs a session', async () => {
    expect((await call(null, 'POST', '/api/folders', { parentId: ada.homeId, name: 'Anon' })).status).toBe(401);
  });
});

describe('PATCH /api/folders/:id', () => {
  it('renames a folder for an editor, keeps sibling names unique, and never renames a vault here', async () => {
    const id = await create(ada, ada.homeId, 'Old name');
    await create(ada, ada.homeId, 'Taken');
    const renamed = await call(ada, 'PATCH', `/api/folders/${id}`, { name: 'New name' });
    expect(renamed.status).toBe(200);
    expect(await row(id)).toMatchObject({ name: 'New name' });
    await expectSentence(await call(ada, 'PATCH', `/api/folders/${id}`, { name: 'taken' }), 409, /already/);
    await expectSentence(await call(ada, 'PATCH', `/api/folders/${ada.homeId}`, { name: 'Vault' }), 409);
    await insertGrant(d1.db, { folderId: id }, cy, 'viewer');
    await expectSentence(await call(cy, 'PATCH', `/api/folders/${id}`, { name: 'Viewer rename' }), 403);
  });

  it('moves a folder within its vault, refusing a cycle, another owner’s vault and a name clash', async () => {
    const a = await create(ada, ada.homeId, 'Move A');
    const b = await create(ada, ada.homeId, 'Move B');
    const child = await create(ada, a, 'Child');
    const moved = await call(ada, 'PATCH', `/api/folders/${a}`, { parentId: b });
    expect(moved.status).toBe(200);
    expect(await row(a)).toMatchObject({ parent_id: b });
    await expectSentence(await call(ada, 'PATCH', `/api/folders/${b}`, { parentId: child }), 409, /itself|inside/);
    const other = await signedUpUser(env, 'folders-other-owner');
    await insertGrant(d1.db, { folderId: other.homeId }, ada, 'editor');
    await expectSentence(await call(ada, 'PATCH', `/api/folders/${a}`, { parentId: other.homeId }), 409, /vault/);
    await create(ada, ada.homeId, 'Child');
    await expectSentence(await call(ada, 'PATCH', `/api/folders/${child}`, { parentId: ada.homeId }), 409, /already/);
  });

  it('keeps folders and notes within their vault even when the owner has another vault', async () => {
    const second = crypto.randomUUID();
    await d1.db.prepare("INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, 'Second vault', 'vault', NULL, ?)")
      .bind(second, ada.id, ada.id, Date.now()).run();
    const folder = await create(ada, ada.homeId, 'Stays home');
    const doc = await insertDoc(d1.db, ada);
    await expectSentence(await call(ada, 'PATCH', `/api/folders/${folder}`, { parentId: second }), 409, /vault/);
    await expectSentence(await call(ada, 'PATCH', `/api/docs/${doc}`, { folderId: second }), 409, /vault/);
    expect(await row(folder)).toMatchObject({ parent_id: ada.homeId });
    expect(await docRow(doc)).toMatchObject({ folder_id: ada.homeId });
  });
});

describe('PATCH /api/docs/:id {folderId}', () => {
  it('moves a note into a folder, giving it a free filename there', async () => {
    const folder = await create(ada, ada.homeId, 'Inbox');
    const clash = await insertDoc(d1.db, ada, { folderId: folder });
    const doc = await insertDoc(d1.db, ada);
    await d1.db.prepare("UPDATE docs SET title = 'Clash', filename = 'clash.md' WHERE id IN (?, ?)").bind(clash, doc).run();
    const response = await call(ada, 'PATCH', `/api/docs/${doc}`, { folderId: folder });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await docRow(doc)).toMatchObject({ folder_id: folder, filename: 'clash-2.md' });
    expect(published.get(ada.id)?.some((event) => event.docIds?.includes(doc))).toBe(true);
  });

  it('refuses a move into a folder the caller cannot edit or into another owner’s vault', async () => {
    const other = await signedUpUser(env, 'folders-other-vault');
    const doc = await insertDoc(d1.db, ada);
    const viewing = await insertFolder(d1.db, other, other.homeId);
    const editing = await insertFolder(d1.db, other, other.homeId);
    await insertGrant(d1.db, { folderId: viewing }, ada, 'viewer');
    await insertGrant(d1.db, { folderId: editing }, ada, 'editor');
    await expectSentence(await call(ada, 'PATCH', `/api/docs/${doc}`, { folderId: viewing }), 403);
    await expectSentence(await call(ada, 'PATCH', `/api/docs/${doc}`, { folderId: editing }), 409, /vault/);
    expect(await docRow(doc)).toMatchObject({ folder_id: ada.homeId });
  });
});

// Access inherits through the folder chain, so a move changes who can open what: it is a sharing decision, the
// vault owner's alone (A§8 manage). An editor grant on the vault, a sub-folder or the doc, and a share link, never move.
describe('moving is the vault owner’s', () => {
  const linked = (user: TestUser, method: string, path: string, token: string, body: unknown) =>
    handleApi(new Request(`${BASE}${path}?share=${token}`, {
      method, headers: { origin: BASE, 'content-type': 'application/json', cookie: user.cookie }, body: JSON.stringify(body),
    }), env);

  it('refuses an editor on the vault a doc or folder move in words, keeps their rename, and lets the owner move', async () => {
    const owner = await signedUpUser(env, 'folders-move-owner');
    await insertGrant(d1.db, { folderId: owner.homeId }, ben, 'editor');
    const a = await create(owner, owner.homeId, 'Move source');
    const b = await create(owner, owner.homeId, 'Move target');
    const doc = await insertDoc(d1.db, owner);
    await expectSentence(await call(ben, 'PATCH', `/api/folders/${a}`, { parentId: b }), 403, /owner/);
    await expectSentence(await call(ben, 'PATCH', `/api/folders/${a}`, { name: 'Renamed and moved', parentId: b }), 403, /owner/);
    await expectSentence(await call(ben, 'PATCH', `/api/docs/${doc}`, { folderId: b }), 403, /owner/);
    expect(await row(a)).toMatchObject({ parent_id: owner.homeId, name: 'Move source' });
    expect(await docRow(doc)).toMatchObject({ folder_id: owner.homeId });

    expect((await call(ben, 'PATCH', `/api/folders/${a}`, { name: 'Ben renamed' })).status, 'an editor still renames').toBe(200);
    expect((await call(ben, 'PATCH', `/api/folders/${a}`, { name: 'Ben renamed again', parentId: owner.homeId })).status,
      'a rename that names the current parent is not a move').toBe(200);
    expect(await create(ben, b, 'Ben made'), 'an editor still creates').toBeTruthy();

    expect((await call(owner, 'PATCH', `/api/folders/${a}`, { parentId: b })).status).toBe(200);
    expect((await call(owner, 'PATCH', `/api/docs/${doc}`, { folderId: a })).status).toBe(200);
    expect(await row(a)).toMatchObject({ parent_id: b });
    expect(await docRow(doc)).toMatchObject({ folder_id: a });
  });

  it('refuses an editor on a sub-folder or on the doc itself, even within what they can edit', async () => {
    const owner = await signedUpUser(env, 'folders-move-sub');
    const shared = await create(owner, owner.homeId, 'Shared');
    const inner = await create(owner, shared, 'Inner');
    const loose = await create(owner, shared, 'Loose');
    const doc = await insertDoc(d1.db, owner, { folderId: shared });
    const rootDoc = await insertDoc(d1.db, owner);
    await insertGrant(d1.db, { folderId: shared }, ben, 'editor');
    await insertGrant(d1.db, { docId: rootDoc }, ben, 'editor');
    await expectSentence(await call(ben, 'PATCH', `/api/folders/${loose}`, { parentId: inner }), 403, /owner/);
    await expectSentence(await call(ben, 'PATCH', `/api/docs/${doc}`, { folderId: inner }), 403, /owner/);
    // Out of the shared folder, the doc would leave everyone else who reaches it through that folder.
    await expectSentence(await call(ben, 'PATCH', `/api/docs/${rootDoc}`, { folderId: inner }), 403, /owner/);
    expect(await row(loose)).toMatchObject({ parent_id: shared });
    expect(await docRow(doc)).toMatchObject({ folder_id: shared });
    expect(await docRow(rootDoc)).toMatchObject({ folder_id: owner.homeId });
  });

  it('never moves on a share link’s authority, a doc link or a folder link', async () => {
    const owner = await signedUpUser(env, 'folders-move-link');
    const target = await create(owner, owner.homeId, 'Link target');
    const linkedFolder = await create(owner, owner.homeId, 'Linked folder');
    const doc = await insertDoc(d1.db, owner);
    // Cy edits the target by grant, so only the link stands between Cy and moving the doc there.
    await insertGrant(d1.db, { folderId: target }, cy, 'editor');
    const docLink = await insertLink(d1.db, { docId: doc }, 'editor');
    const folderLink = await insertLink(d1.db, { folderId: linkedFolder }, 'editor');
    await expectSentence(await linked(cy, 'PATCH', `/api/docs/${doc}`, docLink, { folderId: target }), 403, /owner/);
    const folderMove = await linked(cy, 'PATCH', `/api/folders/${linkedFolder}`, folderLink, { parentId: target });
    expect([403, 404]).toContain(folderMove.status);
    expect(await docRow(doc)).toMatchObject({ folder_id: owner.homeId });
    expect(await row(linkedFolder)).toMatchObject({ parent_id: owner.homeId });
  });
});

describe('DELETE /api/folders/:id', () => {
  it('sends the subtree to Trash as one batch, closes every live doc in it and tells everyone who could see it', async () => {
    const top = await create(ada, ada.homeId, 'Doomed');
    const sub = await create(ada, top, 'Inside');
    const keep = await create(ada, ada.homeId, 'Survivor');
    const inTop = await insertDoc(d1.db, ada, { folderId: top });
    const inSub = await insertDoc(d1.db, ada, { folderId: sub });
    const already = await insertDoc(d1.db, ada, { folderId: sub, deleted: true });
    const survivor = await insertDoc(d1.db, ada, { folderId: keep });
    await insertGrant(d1.db, { docId: inSub }, cy, 'viewer');

    const response = await call(ada, 'DELETE', `/api/folders/${top}`);
    expect(response.status).toBe(200);
    const [a, b, c] = await Promise.all([row(top), row(sub), row(keep)]);
    expect(a?.deleted_at).not.toBeNull();
    expect(a?.trash_batch_id).toBeTruthy();
    expect(b).toMatchObject({ deleted_at: a?.deleted_at, trash_batch_id: a?.trash_batch_id });
    expect(c).toMatchObject({ deleted_at: null, trash_batch_id: null });
    expect(await docRow(inTop)).toMatchObject({ deleted_at: a?.deleted_at, trash_batch_id: a?.trash_batch_id });
    expect(await docRow(inSub)).toMatchObject({ trash_batch_id: a?.trash_batch_id });
    expect((await docRow(already))?.trash_batch_id, 'an already-trashed note keeps its own batch').not.toBe(a?.trash_batch_id);
    expect(await docRow(survivor)).toMatchObject({ deleted_at: null });
    expect(trashed.sort()).toEqual([inTop, inSub].sort());
    expect(holds.every(([, hold, deletedAt]) => hold === a?.trash_batch_id && deletedAt === null), 'each doc closes before the batch commits').toBe(true);
    expect(settled.map(([doc, hold, deleted]) => [doc, hold, deleted]).sort()).toEqual([[inSub, a?.trash_batch_id, true], [inTop, a?.trash_batch_id, true]].sort());
    expect(published.get(cy.id), "a grantee inside the subtree hears about their note, and nothing else").toEqual([
      { type: 'meta', docIds: [inSub], folderIds: [] },
    ]);
    expect(published.get(ada.id)).toContainEqual({ type: 'meta', docIds: expect.arrayContaining([inTop, inSub]), folderIds: expect.arrayContaining([top, sub]) });

    // A fresh read of a doc in the batch is the one 404.
    const gone = await call(ada, 'GET', `/api/docs/${inTop}`);
    expect(gone.status).toBe(404);
  });

  it('is owner-only: an editor is refused in words and nothing changes', async () => {
    const vaultOwner = await signedUpUser(env, 'folders-trash-owner');
    const folder = await insertFolder(d1.db, vaultOwner, vaultOwner.homeId);
    await insertGrant(d1.db, { folderId: vaultOwner.homeId }, ben, 'editor');
    await expectSentence(await call(ben, 'DELETE', `/api/folders/${folder}`), 403);
    expect(await row(folder)).toMatchObject({ deleted_at: null });
    await expectSentence(await call(vaultOwner, 'DELETE', `/api/folders/${vaultOwner.homeId}`), 409);
    expect(trashed).toEqual([]);
  });

  it('answers 503 before anything commits when a doc does not close, and a retry trashes it', async () => {
    const folder = await create(ada, ada.homeId, 'Retry');
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    trashFails = true;
    expect((await call(ada, 'DELETE', `/api/folders/${folder}`)).status).toBe(503);
    expect(await row(folder), 'the folder is not in Trash').toMatchObject({ deleted_at: null });
    expect(await docRow(doc)).toMatchObject({ deleted_at: null });
    trashFails = false;
    expect((await call(ada, 'DELETE', `/api/folders/${folder}`)).status).toBe(200);
    expect(trashed).toEqual([doc]);
  });
});

/**
 * A D1 whose writes to folders and docs wait until `arrivals` of them are pending (or a second passes), so two
 * requests both finish their reads before either writes: the interleaving a real race takes. With `batchFirst`, a
 * batch (a trash) commits before the other writes go; with `first`, the write whose SQL matches it does.
 */
function racingEnv(arrivals: number, { batchFirst = false, first }: { batchFirst?: boolean; first?: RegExp } = {}): typeof env {
  let waiting: (() => void)[] = [];
  let batchDone: Promise<unknown> = Promise.resolve();
  let firstGone = () => undefined as void;
  const firstDone = first ? new Promise<void>((resolve) => { firstGone = resolve; setTimeout(resolve, 2000); }) : Promise.resolve();
  const gate = () => new Promise<void>((resolve) => {
    waiting.push(resolve);
    const release = () => { const all = waiting; waiting = []; for (const go of all) go(); };
    if (waiting.length >= arrivals) release();
    else setTimeout(release, 1000);
  });
  const WRITE = /\b(update|insert\s+into)\s+[`"]?(folders|docs)\b/i;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key === 'bind') return (...args: unknown[]) => wrap(value.apply(target, args), sql);
      if (WRITE.test(sql) && ['run', 'all', 'first', 'raw'].includes(key as string)) {
        return async (...args: unknown[]) => {
          await gate();
          await batchDone;
          if (first?.test(sql)) {
            try { return await value.apply(target, args); } finally { firstGone(); }
          }
          await firstDone;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  const DB = new Proxy(d1.db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          const done = gate().then(() => target.batch(statements));
          if (batchFirst) batchDone = done.catch(() => undefined);
          return done;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...env, DB };
}

const callIn = (raceEnv: typeof env, user: TestUser, method: string, path: string, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, 'content-type': 'application/json', cookie: user.cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), raceEnv);

const visibleFolderIds = async (user: TestUser) =>
  ((await (await call(user, 'GET', '/api/workspace')).json()) as { folders: { id: string }[] }).folders.map((f) => f.id);

describe('concurrent writes', () => {
  it('two crossing moves never both commit, so no parent cycle hides the folders', async () => {
    const a = await create(ada, ada.homeId, 'Cross A');
    const b = await create(ada, ada.homeId, 'Cross B');
    const race = racingEnv(2);
    const statuses = (await Promise.all([
      callIn(race, ada, 'PATCH', `/api/folders/${a}`, { parentId: b }),
      callIn(race, ada, 'PATCH', `/api/folders/${b}`, { parentId: a }),
    ])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await visibleFolderIds(ada)).toEqual(expect.arrayContaining([a, b]));
  });

  it('a move and a deep create never together nest past the depth bound', async () => {
    let deep = ada.homeId;
    for (let depth = 1; depth <= 9; depth += 1) deep = await create(ada, deep, `Deep ${depth}`);
    const mover = await create(ada, ada.homeId, 'Mover');
    const race = racingEnv(2);
    const [moved, created] = await Promise.all([
      callIn(race, ada, 'PATCH', `/api/folders/${mover}`, { parentId: deep }),
      callIn(race, ada, 'POST', '/api/folders', { parentId: mover, name: 'Under mover' }),
    ]);
    expect([[200, 409], [409, 201]], `move ${moved.status}, create ${created.status}`).toContainEqual([moved.status, created.status]);
  });

  it('a folder created in a folder being trashed is trashed with it or refused, never left live under it', async () => {
    const doomed = await create(ada, ada.homeId, 'Doomed race');
    const race = racingEnv(2, { batchFirst: true });
    const [trash, child] = await Promise.all([
      callIn(race, ada, 'DELETE', `/api/folders/${doomed}`),
      callIn(race, ada, 'POST', '/api/folders', { parentId: doomed, name: 'Late child' }),
    ]);
    expect(trash.status).toBe(200);
    const live = await d1.db.prepare('SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL').bind(doomed).all();
    expect(live.results, `child answered ${child.status}`).toEqual([]);
  });

  it('a note moved into a folder being trashed is trashed with it or refused, never left live under it', async () => {
    const doomed = await create(ada, ada.homeId, 'Doomed note race');
    const doc = await insertDoc(d1.db, ada);
    const race = racingEnv(2, { batchFirst: true });
    const [trash, move] = await Promise.all([
      callIn(race, ada, 'DELETE', `/api/folders/${doomed}`),
      callIn(race, ada, 'PATCH', `/api/docs/${doc}`, { folderId: doomed }),
    ]);
    expect(trash.status).toBe(200);
    const live = await d1.db.prepare('SELECT id FROM docs WHERE folder_id = ? AND deleted_at IS NULL').bind(doomed).all();
    expect(live.results, `move answered ${move.status}`).toEqual([]);
  });

  it('a note created in a folder being trashed is trashed with it or refused, never left live under it', async () => {
    const doomed = await create(ada, ada.homeId, 'Doomed create race');
    const race = racingEnv(2, { batchFirst: true });
    const [trash, created] = await Promise.all([
      callIn(race, ada, 'DELETE', `/api/folders/${doomed}`),
      callIn(race, ada, 'POST', '/api/docs', { folderId: doomed }),
    ]);
    expect(trash.status).toBe(200);
    const live = await d1.db.prepare('SELECT id FROM docs WHERE folder_id = ? AND deleted_at IS NULL').bind(doomed).all();
    expect(live.results, `create answered ${created.status}`).toEqual([]);
    if (created.status !== 201) await expectSentence(created, 404, /no longer/);
  });

  it('a note duplicated into a folder being trashed is trashed with it or refused, never left live under it', async () => {
    const doomed = await create(ada, ada.homeId, 'Doomed duplicate race');
    const source = await insertDoc(d1.db, ada, { folderId: doomed });
    const race = racingEnv(2, { batchFirst: true });
    const [trash, copy] = await Promise.all([
      callIn(race, ada, 'DELETE', `/api/folders/${doomed}`),
      callIn(race, ada, 'POST', `/api/docs/${source}/duplicate`),
    ]);
    expect(trash.status).toBe(200);
    const live = await d1.db.prepare('SELECT id FROM docs WHERE folder_id = ? AND deleted_at IS NULL').bind(doomed).all();
    expect(live.results, `duplicate answered ${copy.status}`).toEqual([]);
    if (copy.status !== 201) await expectSentence(copy, 404, /no longer/);
  });

  it('a move that sends no name keeps a rename that commits between its read and its write', async () => {
    const renamed = await create(ada, ada.homeId, 'Before rename');
    const target = await create(ada, ada.homeId, 'Move target');
    const race = racingEnv(2, { first: /set "name"/i });
    const statuses = (await Promise.all([
      callIn(race, ada, 'PATCH', `/api/folders/${renamed}`, { parentId: target }),
      callIn(race, ada, 'PATCH', `/api/folders/${renamed}`, { name: 'After rename' }),
    ])).map((response) => response.status);
    expect(statuses).toEqual([200, 200]);
    expect(await row(renamed)).toMatchObject({ name: 'After rename', parent_id: target });
  });
});

describe('GET /api/workspace', () => {
  it('lists a new folder with its path, role and note count for the id↔path map', async () => {
    const id = await create(ada, ada.homeId, 'Mapped');
    await insertDoc(d1.db, ada, { folderId: id });
    const listing = (await (await call(ada, 'GET', '/api/workspace')).json()) as { folders: { id: string; path: string; role: string; noteCount: number }[] };
    expect(listing.folders).toContainEqual(expect.objectContaining({ id, path: 'Notes/Mapped', role: 'owner', noteCount: 1 }));
  });
});
