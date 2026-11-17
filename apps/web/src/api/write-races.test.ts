// Folder, note and link writes re-check what their reads decided inside the write itself (A§8): a revocation, a
// retitle or another trash that commits between a request's read and its write wins. Each race runs the other
// change just before the write's statement executes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { filenameFor } from '@moss-multi/core/filenames';
import { d1Projections } from '@moss-multi/sync/projections';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import {
  BASE, insertAgent, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser,
} from '../test/principals.ts';
import { handleApi } from './router.ts';

const settled: string[] = [];
const rechecked: string[] = [];

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    create: async () => undefined,
    trash: async () => undefined,
    settle: async () => { settled.push(id.name); return {}; },
    recheck: async () => { rechecked.push(id.name); return { closed: 0 }; },
  }),
};

const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined, publish: async () => undefined, takeCreateToken: async () => true }),
};

/** Each runs once, just before the first statement (or batch holding one) matching its `sql`: a change landing then. */
let races: { sql: RegExp; run: () => Promise<unknown> }[] = [];
const REAL = Symbol('real');
const QUERY = Symbol('query');

function racingDb(db: D1Database): D1Database {
  const claim = async (query: string) => {
    const i = races.findIndex((race) => race.sql.test(query));
    if (i < 0) return;
    const [race] = races.splice(i, 1);
    await race.run();
  };
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => new Proxy(statement, {
    get(target, prop) {
      if (prop === REAL) return target;
      if (prop === QUERY) return query;
      if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), query);
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop !== 'all' && prop !== 'raw' && prop !== 'first' && prop !== 'run') return value.bind(target);
      return async (...args: unknown[]) => {
        await claim(query);
        return value.apply(target, args);
      };
    },
  });
  type Wrapped = D1PreparedStatement & { [REAL]: D1PreparedStatement; [QUERY]: string };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (query: string) => wrap(target.prepare(query), query);
      if (prop === 'batch') {
        return async (statements: Wrapped[]) => {
          for (const statement of statements) await claim(statement[QUERY]);
          return target.batch(statements.map((statement) => statement[REAL]));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: racingDb(d1.db), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'races-ada', 'Ada');
  ben = await signedUpUser(env, 'races-ben', 'Ben');
  cy = await signedUpUser(env, 'races-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  races = [];
  settled.length = 0;
  rechecked.length = 0;
});

type Who = TestUser | { key: string };
const call = (who: Who, method: string, path: string, body?: unknown, share?: string) => {
  const headers: Record<string, string> = { origin: BASE, 'content-type': 'application/json' };
  if ('cookie' in who) headers.cookie = who.cookie;
  else headers.authorization = `Bearer ${who.key}`;
  if (share) headers['x-moss-share'] = share;
  return handleApi(new Request(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
};
const run = (sql: string, ...args: unknown[]) => () => d1.db.prepare(sql).bind(...args).run();
const ungrant = (folder: string, who: TestUser) => run('DELETE FROM folder_members WHERE folder_id = ? AND principal_id = ?', folder, who.id);
const revokeLink = (token: string) => run('UPDATE share_links SET revoked_at = ? WHERE token = ?', Date.now(), token);
const revokeAgent = (id: string) => run('UPDATE agents SET revoked_at = ? WHERE id = ?', Date.now(), id);
const folderRow = (id: string) => d1.db.prepare('SELECT * FROM folders WHERE id = ?').bind(id).first<Record<string, unknown>>();
const childNamed = async (parent: string, name: string) =>
  (await d1.db.prepare('SELECT count(*) AS n FROM folders WHERE parent_id = ? AND name = ?').bind(parent, name).first<{ n: number }>())?.n ?? 0;
const docsIn = async (folder: string) =>
  (await d1.db.prepare('SELECT count(*) AS n FROM docs WHERE folder_id = ?').bind(folder).first<{ n: number }>())?.n ?? 0;

const CREATE_FOLDER = /INSERT INTO folders/i;
const RENAME_FOLDER = /update "?folders"? set "?name"?/i;
const INSERT_DOC = /INSERT INTO docs/i;
const REVOKE_LINK = /update "?share_links"? set "?revoked_at"?/i;

describe('a folder create, folder rename or note insert loses to a revocation that commits first', () => {
  it('a direct editor grant removed before the folder insert writes nothing; with it kept, the folder is made', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    await insertGrant(d1.db, { folderId: vault }, ben, 'editor');
    expect((await call(ben, 'POST', '/api/folders', { parentId: vault, name: 'Kept' })).status).toBe(201);
    races = [{ sql: CREATE_FOLDER, run: ungrant(vault, ben) }];
    const response = await call(ben, 'POST', '/api/folders', { parentId: vault, name: 'Raced' });
    expect(await childNamed(vault, 'Raced')).toBe(0);
    expect(response.status).toBe(404);
  });

  it('an editor link revoked before the folder insert writes nothing; with it live, the folder is made', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const shared = await insertFolder(d1.db, ada, vault);
    const token = await insertLink(d1.db, { folderId: shared }, 'editor');
    expect((await call(cy, 'POST', '/api/folders', { parentId: shared, name: 'Kept' }, token)).status).toBe(201);
    races = [{ sql: CREATE_FOLDER, run: revokeLink(token) }];
    await call(cy, 'POST', '/api/folders', { parentId: shared, name: 'Raced' }, token);
    expect(await childNamed(shared, 'Raced')).toBe(0);
  });

  it('an agent key revoked before the folder insert writes nothing; the owner’s live agent makes one', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const agent = await insertAgent(d1.db, ada);
    expect((await call({ key: agent.key }, 'POST', '/api/folders', { parentId: vault, name: 'Kept' })).status).toBe(201);
    races = [{ sql: CREATE_FOLDER, run: revokeAgent(agent.id) }];
    const response = await call({ key: agent.key }, 'POST', '/api/folders', { parentId: vault, name: 'Raced' });
    expect(await childNamed(vault, 'Raced')).toBe(0);
    expect(response.status).toBe(401);
  });

  it('an inherited grant removed before the rename leaves the name; with it kept, the rename lands', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const parent = await insertFolder(d1.db, ada, vault);
    const folder = await insertFolder(d1.db, ada, parent);
    await insertGrant(d1.db, { folderId: vault }, ben, 'editor');
    expect((await call(ben, 'PATCH', `/api/folders/${folder}`, { name: 'Kept' })).status).toBe(200);
    races = [{ sql: RENAME_FOLDER, run: ungrant(vault, ben) }];
    const response = await call(ben, 'PATCH', `/api/folders/${folder}`, { name: 'Raced' });
    expect((await folderRow(folder))?.name).toBe('Kept');
    expect(response.status).toBe(404);
  });

  it('an editor link revoked before the rename leaves the name', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const folder = await insertFolder(d1.db, ada, vault);
    const token = await insertLink(d1.db, { folderId: folder }, 'editor');
    races = [{ sql: RENAME_FOLDER, run: revokeLink(token) }];
    await call(cy, 'PATCH', `/api/folders/${folder}`, { name: 'Raced' }, token);
    expect((await folderRow(folder))?.name).not.toBe('Raced');
  });

  it('a grant removed before the note insert writes no row; with it kept, the note is made', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const folder = await insertFolder(d1.db, ada, vault);
    await insertGrant(d1.db, { folderId: vault }, ben, 'editor');
    expect((await call(ben, 'POST', '/api/docs', { folderId: folder })).status).toBe(201);
    races = [{ sql: INSERT_DOC, run: ungrant(vault, ben) }];
    const response = await call(ben, 'POST', '/api/docs', { folderId: folder });
    expect(await docsIn(folder)).toBe(1);
    expect(response.status).toBe(404);
  });

  it('an agent key revoked before the note insert writes no row; the owner’s live agent makes one', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const agent = await insertAgent(d1.db, ada);
    expect((await call({ key: agent.key }, 'POST', '/api/docs', { folderId: vault })).status).toBe(201);
    races = [{ sql: INSERT_DOC, run: revokeAgent(agent.id) }];
    const response = await call({ key: agent.key }, 'POST', '/api/docs', { folderId: vault });
    expect(await docsIn(vault)).toBe(1);
    expect(response.status).toBe(401);
  });
});

describe('a link revoke loses to a demotion that commits first', () => {
  it('a co-owner demoted before the revoke leaves the link live and is refused', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const folder = await insertFolder(d1.db, ada, vault);
    await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: vault }, ben, 'owner');
    const token = await insertLink(d1.db, { folderId: folder }, 'editor');
    races = [{ sql: REVOKE_LINK, run: run("UPDATE folder_members SET role = 'editor' WHERE folder_id = ? AND principal_id = ?", vault, ben.id) }];
    const response = await call(ben, 'DELETE', `/api/folders/${folder}/links/${token}`);
    const link = await d1.db.prepare('SELECT revoked_at FROM share_links WHERE token = ?').bind(token).first<{ revoked_at: number | null }>();
    expect(link?.revoked_at).toBeNull();
    expect(response.status).toBe(403);
    expect(rechecked).toEqual([]);
  });

  it('the owner’s retry of an already revoked link kicks again', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const doc = await insertDoc(d1.db, ada, { folderId: vault });
    const token = await insertLink(d1.db, { folderId: vault }, 'viewer', { revoked: true });
    expect((await call(ada, 'DELETE', `/api/folders/${vault}/links/${token}`)).status).toBe(200);
    expect(rechecked).toEqual([doc]);
  });
});

describe('a note move never undoes a retitle that lands between its read and its write', () => {
  const title = (doc: string, to: string) => () => d1Projections(d1.db).title(doc, to);
  const docRow = (id: string) => d1.db.prepare('SELECT folder_id, filename FROM docs WHERE id = ?').bind(id).first<{ folder_id: string; filename: string }>();
  const named = async (owner: TestUser, folderId: string, name: string) => {
    const doc = await insertDoc(d1.db, owner, { folderId });
    await d1.db.prepare('UPDATE docs SET title = ?, filename = ? WHERE id = ?').bind(name, filenameFor(name, new Set()), doc).run();
    return doc;
  };

  it('the projection’s filename survives the move', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const from = await insertFolder(d1.db, ada, vault);
    const to = await insertFolder(d1.db, ada, vault);
    const doc = await named(ada, from, 'Old');
    races = [{ sql: /UPDATE docs SET folder_id/i, run: title(doc, 'Fresh') }];
    expect((await call(ada, 'PATCH', `/api/docs/${doc}`, { folderId: to })).status).toBe(200);
    expect(await docRow(doc)).toEqual({ folder_id: to, filename: filenameFor('Fresh', new Set()) });
  });

  it('stepping aside from a name the destination holds, the new filename comes from the current title and is unique', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const from = await insertFolder(d1.db, ada, vault);
    const to = await insertFolder(d1.db, ada, vault);
    await named(ada, to, 'Old');
    await named(ada, to, 'Fresh');
    const doc = await named(ada, from, 'Old');
    races = [{ sql: /UPDATE docs SET folder_id/i, run: title(doc, 'Fresh') }];
    expect((await call(ada, 'PATCH', `/api/docs/${doc}`, { folderId: to })).status).toBe(200);
    const taken = new Set([filenameFor('Old', new Set()), filenameFor('Fresh', new Set())]);
    expect(await docRow(doc)).toEqual({ folder_id: to, filename: filenameFor('Fresh', taken) });
  });
});

describe('two vault trashes racing never take the last live vault', () => {
  it('of an owner’s two vaults, both trashed at once, exactly one goes and the other stays with its notes open', async () => {
    const dee = await signedUpUser(env, 'races-dee', 'Dee');
    const second = await insertFolder(d1.db, dee, null);
    const notes = { [dee.homeId]: await insertDoc(d1.db, dee, { folderId: dee.homeId }), [second]: await insertDoc(d1.db, dee, { folderId: second }) };
    // Both requests pass their live-vault count before either writes.
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((resolve) => { open = resolve; });
    const gate = async () => {
      arrived += 1;
      if (arrived === 2) open();
      await both;
    };
    races = [{ sql: /UPDATE folders SET deleted_at/i, run: gate }, { sql: /UPDATE folders SET deleted_at/i, run: gate }];
    const responses = await Promise.all([call(dee, 'DELETE', `/api/vaults/${dee.homeId}`), call(dee, 'DELETE', `/api/vaults/${second}`)]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = responses.find((response) => response.status === 409)!;
    expect(((await refused.json()) as { error: string }).error).toBe('last-vault');
    const kept = responses[0].status === 409 ? dee.homeId : second;
    expect((await folderRow(kept))?.deleted_at).toBeNull();
    const note = await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(notes[kept]).first<{ deleted_at: number | null }>();
    expect(note?.deleted_at).toBeNull();
    expect(settled, 'the kept vault’s note reopens').toContain(notes[kept]);
    const live = await d1.db.prepare("SELECT count(*) AS n FROM folders WHERE owner_user_id = ? AND kind = 'vault' AND deleted_at IS NULL").bind(dee.id).first<{ n: number }>();
    expect(live?.n).toBe(1);
  });
});

describe('a folder rename through a link never reveals the folder above the link', () => {
  it('the link’s own folder comes back without its parent; a folder inside the link and an owner’s rename keep theirs', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const parent = await insertFolder(d1.db, ada, vault);
    const root = await insertFolder(d1.db, ada, parent);
    const inside = await insertFolder(d1.db, ada, root);
    const token = await insertLink(d1.db, { folderId: root }, 'editor');
    type Body = { folder: { id: string; name: string; parentId?: string } };
    const renamedRoot = await call(cy, 'PATCH', `/api/folders/${root}`, { name: 'Linked' }, token);
    expect(renamedRoot.status).toBe(200);
    const rootBody = (await renamedRoot.json()) as Body;
    expect(rootBody.folder).toMatchObject({ id: root, name: 'Linked' });
    expect(rootBody.folder).not.toHaveProperty('parentId');
    const renamedInside = (await (await call(cy, 'PATCH', `/api/folders/${inside}`, { name: 'Within' }, token)).json()) as Body;
    expect(renamedInside.folder.parentId).toBe(root);
    const byOwner = (await (await call(ada, 'PATCH', `/api/folders/${root}`, { name: 'Owned' })).json()) as Body;
    expect(byOwner.folder.parentId).toBe(parent);
  });
});
