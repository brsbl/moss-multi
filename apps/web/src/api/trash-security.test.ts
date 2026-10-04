// T2.3s, the security follow-up to trash: trash, restore, the trashed read path and the Trash view follow the rule
// moves follow (A§8): `manage` on the note, resolved without any share link, which a signed-in person holds as the
// vault's owner or by an `owner` grant on the note or a folder above it, and never through an editor grant, a link or
// an agent key. A restore that relocates the note is a move, and only ever narrows who can read it. Non-managers learn
// nothing about a trashed note, and a revocation that lands while a trash or restore is under way wins.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import {
  agentKey, BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser,
} from '../test/principals.ts';
import { handleApi } from './router.ts';

/** Every DocDO call, in order. */
const calls: [op: string, doc: string][] = [];
const published = new Map<string, { type: string; docIds?: string[]; folderIds?: string[] }[]>();
/** While set, runs once just before the next D1 statement matching it executes: a request landing in between. */
let before: { sql: RegExp; run: () => Promise<unknown> } | null = null;

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    trash: async () => { calls.push(['trash', id.name]); },
    settle: async () => { calls.push(['settle', id.name]); return {}; },
    exportMarkdown: async () => { calls.push(['export', id.name]); return `Body of ${id.name}\n`; },
  }),
};

const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    publish: async (event: { type: string }) => { published.set(id.name, [...(published.get(id.name) ?? []), event]); },
  }),
};

/** D1 as the routes see it, with `before` run ahead of the statement it matches. */
function racingDb(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key, target);
      return (query: string) => {
        const hook = before;
        if (!hook?.sql.test(query)) return target.prepare(query);
        before = null;
        const statement = (args: unknown[]) => {
          const run = (method: 'run' | 'all' | 'raw' | 'first') => async (...rest: unknown[]) => {
            await hook.run();
            const bound = target.prepare(query).bind(...args) as unknown as Record<string, (...a: unknown[]) => unknown>;
            return bound[method](...rest);
          };
          return { bind: (...more: unknown[]) => statement([...args, ...more]), run: run('run'), all: run('all'), raw: run('raw'), first: run('first') };
        };
        return statement([]);
      };
    },
  });
}

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;
let dee: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: racingDb(d1.db), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 't23s-ada', 'Ada');
  ben = await signedUpUser(env, 't23s-ben', 'Ben');
  cy = await signedUpUser(env, 't23s-cy', 'Cy');
  dee = await signedUpUser(env, 't23s-dee', 'Dee');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  calls.length = 0;
  published.clear();
  before = null;
});

type Who = TestUser | { key: string } | { share: string } | null;
const call = (who: Who, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { origin: BASE, 'content-type': 'application/json' };
  if (who && 'cookie' in who) headers.cookie = who.cookie;
  else if (who && 'key' in who) headers.authorization = `Bearer ${who.key}`;
  else if (who && 'share' in who) headers['x-moss-share'] = who.share;
  return handleApi(new Request(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
};
const bytes = async (response: Response) => ({ status: response.status, body: await response.text() });
const deletedAt = async (doc: string) =>
  (await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(doc).first<{ deleted_at: number | null }>())?.deleted_at ?? null;
const canRead = async (who: TestUser, doc: string) => (await call(who, 'GET', `/api/docs/${doc}`)).status === 200;

async function expectSentence(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error?: string; message?: string };
  expect(typeof body.error).toBe('string');
  expect(body.message).toMatch(/^[A-Z].*\S \S.*[.!]$/);
}

/** The three answers about a doc that should look like a doc that does not exist. */
async function looksMissing(who: Who, doc: string): Promise<void> {
  const missing = crypto.randomUUID();
  expect(await bytes(await call(who, 'DELETE', `/api/docs/${doc}`)), 'trash').toEqual(await bytes(await call(who, 'DELETE', `/api/docs/${missing}`)));
  expect(await bytes(await call(who, 'POST', `/api/docs/${doc}/restore`)), 'restore').toEqual(await bytes(await call(who, 'POST', `/api/docs/${missing}/restore`)));
  expect(await bytes(await call(who, 'GET', `/api/trash/${doc}`)), 'trashed read').toEqual(await bytes(await call(who, 'GET', `/api/trash/${missing}`)));
}

describe('one rule: trash, restore and the trashed read need manage, as moves do', () => {
  it('a co-owner by an owner grant on a folder above the note trashes, reads, restores and moves it', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const inner = await insertFolder(d1.db, ada, folder);
    await insertGrant(d1.db, { folderId: folder }, ben, 'owner');
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    expect((await call(ben, 'PATCH', `/api/docs/${doc}`, { folderId: inner })).status, 'move').toBe(200);
    expect((await call(ben, 'DELETE', `/api/docs/${doc}`)).status, 'trash').toBe(200);
    expect((await call(ben, 'GET', `/api/trash/${doc}`)).status, 'trashed read').toBe(200);
    expect((await call(ben, 'POST', `/api/docs/${doc}/restore`)).status, 'restore').toBe(200);
    expect(await deletedAt(doc)).toBeNull();
  });

  it('a co-owner by an owner grant on the note itself does the same', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'owner');
    expect((await call(ben, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    expect((await call(ben, 'GET', `/api/trash/${doc}`)).status).toBe(200);
    expect((await call(ben, 'POST', `/api/docs/${doc}/restore`)).status).toBe(200);
  });

  it('an editor by a folder grant, an editor-link holder and the owner’s agent are refused a trash in words, as a move is', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: folder }, cy, 'editor');
    const token = await insertLink(d1.db, { folderId: folder }, 'editor');
    const agent = { key: await agentKey(d1.db, ada) };
    for (const [who, path] of [[cy, ''], [dee, `?share=${token}`], [agent, '']] as const) {
      await expectSentence(await call(who, 'DELETE', `/api/docs/${doc}${path}`), 403);
      await expectSentence(await call(who, 'PATCH', `/api/docs/${doc}${path}`, { folderId: ada.homeId }), 403);
    }
    expect(await deletedAt(doc)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('once it is in Trash, a re-trash, a restore or a read by anyone but a manager looks like a missing note and touches no DocDO', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { docId: doc }, ben, 'editor');
    await insertGrant(d1.db, { folderId: folder }, cy, 'viewer');
    const token = await insertLink(d1.db, { docId: doc }, 'editor');
    await insertGrant(d1.db, { docId: doc }, dee, 'viewer');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    calls.length = 0;
    for (const who of [ben, cy, { key: await agentKey(d1.db, ada) }, { share: token }, null] as Who[]) await looksMissing(who, doc);
    // A link presented with a grant adds nothing either.
    for (const verb of [['DELETE', ''], ['POST', '/restore']] as const) {
      expect((await call(dee, verb[0], `/api/docs/${doc}${verb[1]}?share=${token}`)).status).toBe(404);
    }
    expect(calls, 'no DocDO is woken for them').toEqual([]);
    expect(await deletedAt(doc)).not.toBeNull();
  });

  it('a share link never adds authority: a viewer holding an editor link is refused the trash, restore and read of a live or trashed note', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'viewer');
    const token = await insertLink(d1.db, { docId: doc }, 'editor');
    await expectSentence(await call(ben, 'DELETE', `/api/docs/${doc}?share=${token}`), 403);
    expect((await call(ben, 'POST', `/api/docs/${doc}/restore?share=${token}`)).status).toBe(404);
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    expect((await call(ben, 'GET', `/api/trash/${doc}?share=${token}`)).status).toBe(404);
    expect((await call(ben, 'POST', `/api/docs/${doc}/restore?share=${token}`)).status).toBe(404);
  });

  it('the trash tells only those who could see the note, by id, and afterwards they read nothing of it', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'viewer');
    const token = await insertLink(d1.db, { docId: doc }, 'editor');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    expect(published.get(ben.id)).toEqual([{ type: 'meta', docIds: [doc], folderIds: [] }]);
    expect(published.has(cy.id), 'a link holder is not told').toBe(false);
    const listing = (await (await call(ben, 'GET', `/api/workspace?ids=${doc}`)).json()) as { docs: unknown[] };
    expect(listing.docs).toEqual([]);
    await looksMissing(ben, doc);
    await looksMissing({ share: token }, doc);
  });
});

describe('the Trash view lists exactly the trashed notes the caller manages', () => {
  it('a co-owner of the vault sees its trashed notes; an editor of the vault does not', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const doc = await insertDoc(d1.db, ada, { folderId: vault });
    await insertGrant(d1.db, { folderId: vault }, ben, 'owner');
    await insertGrant(d1.db, { folderId: vault }, cy, 'editor');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    type Listing = { docs: { id: string; trashedAt?: number }[] };
    const bens = (await (await call(ben, 'GET', `/api/workspace?vault=${vault}`)).json()) as Listing;
    expect(bens.docs.find((row) => row.id === doc)).toMatchObject({ trashedAt: expect.any(Number) });
    const cys = (await (await call(cy, 'GET', `/api/workspace?vault=${vault}`)).json()) as Listing;
    expect(cys.docs.map((row) => row.id)).not.toContain(doc);
  });

  it('a co-owner of one note in a vault they cannot see finds it in Trash at their root, as a shared live note surfaces', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'owner');
    const editorOnly = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: editorOnly }, ben, 'editor');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    expect((await call(ada, 'DELETE', `/api/docs/${editorOnly}`)).status).toBe(200);
    const listing = (await (await call(ben, 'GET', '/api/workspace')).json()) as { docs: { id: string; trashedAt?: number; folderPath: string }[] };
    expect(listing.docs.find((row) => row.id === doc)).toMatchObject({ trashedAt: expect.any(Number), folderPath: 'Notes' });
    expect(listing.docs.map((row) => row.id)).not.toContain(editorOnly);
  });
});

describe('a restore that relocates the note is a move', () => {
  it('a co-owner of a trashed folder who cannot add notes at the vault’s root is refused in words, and the note stays in Trash', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: folder }, ben, 'owner');
    expect((await call(ada, 'DELETE', `/api/folders/${folder}`)).status).toBe(200);
    calls.length = 0;
    await expectSentence(await call(ben, 'POST', `/api/docs/${doc}/restore`), 403);
    expect(await deletedAt(doc)).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it('only narrows who can read it: the trashed folder’s grantees lose it, the vault’s keep it, and nobody gains it', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const folder = await insertFolder(d1.db, ada, vault);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: vault }, ben, 'owner');
    await insertGrant(d1.db, { folderId: folder }, cy, 'viewer');
    await insertGrant(d1.db, { folderId: vault }, dee, 'viewer');
    const people = [ada, ben, cy, dee];
    const readersBefore = (await Promise.all(people.map((who) => canRead(who, doc)))).map((ok, i) => (ok ? people[i].id : null)).filter(Boolean);
    expect((await call(ada, 'DELETE', `/api/folders/${folder}`)).status).toBe(200);
    const restored = await call(ben, 'POST', `/api/docs/${doc}/restore`);
    expect(restored.status, 'a vault co-owner may add notes at its root').toBe(200);
    expect(await restored.json()).toMatchObject({ doc: { folderId: vault }, role: 'owner' });
    const readersAfter = (await Promise.all(people.map((who) => canRead(who, doc)))).map((ok, i) => (ok ? people[i].id : null)).filter(Boolean);
    expect(readersAfter).toEqual([ada.id, ben.id, dee.id]);
    for (const id of readersAfter) expect(readersBefore).toContain(id);
  });
});

describe('a restore never leaves the note live under a trashed folder', () => {
  const trashFolder = (folder: string) => async () => expect((await call(ada, 'DELETE', `/api/folders/${folder}`)).status).toBe(200);

  it('when the note’s folder goes to Trash while the restore is under way, the note returns to the vault’s root', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const folder = await insertFolder(d1.db, ada, vault);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: vault }, ben, 'owner');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    before = { sql: /UPDATE "docs" SET deleted_at = NULL/i, run: trashFolder(folder) };
    const restored = await call(ben, 'POST', `/api/docs/${doc}/restore`);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ doc: { folderId: vault } });
    expect(await deletedAt(doc)).toBeNull();
  });

  it('a co-owner of just that folder is then refused in words, and the note stays in Trash', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: folder }, ben, 'owner');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    before = { sql: /UPDATE "docs" SET deleted_at = NULL/i, run: trashFolder(folder) };
    await expectSentence(await call(ben, 'POST', `/api/docs/${doc}/restore`), 403);
    expect(await deletedAt(doc)).not.toBeNull();
  });

  it('a relocating restore whose edit grant on the vault is removed before it commits is refused, and the note stays in Trash', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const folder = await insertFolder(d1.db, ada, vault);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: folder }, ben, 'owner');
    await insertGrant(d1.db, { folderId: vault }, ben, 'editor');
    expect((await call(ada, 'DELETE', `/api/folders/${folder}`)).status).toBe(200);
    before = { sql: /UPDATE "docs" SET deleted_at = NULL/i,
      run: () => d1.db.prepare('DELETE FROM folder_members WHERE folder_id = ? AND principal_id = ?').bind(vault, ben.id).run() };
    await expectSentence(await call(ben, 'POST', `/api/docs/${doc}/restore`), 403);
    expect(await deletedAt(doc)).not.toBeNull();
  });
});

describe('a revocation that lands while a trash or restore is under way wins', () => {
  it('a co-owner whose grant is removed before the trash commits trashes nothing, and the note reopens', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'owner');
    before = { sql: /^update "docs"/i, run: () => d1.db.prepare('DELETE FROM doc_members WHERE doc_id = ? AND principal_id = ?').bind(doc, ben.id).run() };
    const response = await bytes(await call(ben, 'DELETE', `/api/docs/${doc}`));
    expect(response).toEqual(await bytes(await call(ben, 'DELETE', `/api/docs/${crypto.randomUUID()}`)));
    expect(await deletedAt(doc)).toBeNull();
    expect(calls.at(-1), 'the hold is settled from the live row').toEqual(['settle', doc]);
  });

  it('a co-owner demoted to editor before the trash commits is refused in words', async () => {
    const doc = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: doc }, ben, 'owner');
    before = { sql: /^update "docs"/i, run: () => d1.db.prepare("UPDATE doc_members SET role = 'editor' WHERE doc_id = ? AND principal_id = ?").bind(doc, ben.id).run() };
    await expectSentence(await call(ben, 'DELETE', `/api/docs/${doc}`), 403);
    expect(await deletedAt(doc)).toBeNull();
  });

  it('a co-owner whose folder grant is removed before the restore commits restores nothing', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const doc = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: folder }, ben, 'owner');
    expect((await call(ada, 'DELETE', `/api/docs/${doc}`)).status).toBe(200);
    calls.length = 0;
    before = { sql: /^update "docs"/i, run: () => d1.db.prepare('DELETE FROM folder_members WHERE folder_id = ? AND principal_id = ?').bind(folder, ben.id).run() };
    const response = await bytes(await call(ben, 'POST', `/api/docs/${doc}/restore`));
    expect(response).toEqual(await bytes(await call(ben, 'POST', `/api/docs/${crypto.randomUUID()}/restore`)));
    expect(await deletedAt(doc)).not.toBeNull();
    expect(calls, 'the note never reopens').toEqual([]);
  });
});
