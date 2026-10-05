// Pull validation (A§8, T2.5): kicks are hints. Over the real DocDO and PrincipalDO in the Node harness, real D1 and
// the REST routes, with every kick dropped (or racing), a socket whose access a committed change lowered or removed is
// closed by its next frame, at its admission, or by the access tick, and no write it sends after the commit lands.
// Each case is a race from T2.5's three check rounds.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_TICK_MS, REST_WRITE_RATE } from '@moss-multi/protocol/limits';
import { CLOSE, TRUSTED } from '@moss-multi/protocol/sync';
import { liveCredentials } from '../../../../packages/sync/src/access-epoch.ts';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { PrincipalDO } from '../../../../packages/sync/src/principal-do.ts';
import { Backing, connect, openDoc, start, type Opened, type TestClient } from '../../../../packages/sync/test/harness/do-harness.ts';
import { FakeState, serverEnds, type FakeSocket } from '../../../../packages/sync/test/harness/workerd.ts';
import { handleAuthRoute } from '../auth/route.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type TestUser } from '../test/principals.ts';
import { authenticateParty } from '../worker/party.ts';
import { docAccessCheck } from '../worker/doc-access.ts';
import { handleApi } from './router.ts';

let d1: TestD1;

/** The real DocDO with the Worker's access check, reading D1 for liveness; no projections or sign-out registry. */
class PullDocDO extends DocDO {
  static override projectionTarget = () => null;
  static override registry = () => null;
  static override liveness = () => async (docId: string) => {
    const row = await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>();
    return !row || row.deleted_at !== null;
  };
  static override access = () => docAccessCheck({ DB: d1.db });
}

/** The real PrincipalDO reading D1 for its sockets' credentials; its sign-out rechecks are kicks, so they are dropped. */
class PullPrincipalDO extends PrincipalDO {
  static override credentials = () => (sessions: string[], agents: string[]) => liveCredentials(d1.db, sessions, agents);
  static override rechecker = () => async () => undefined;
}

/** When set, every kick a route sends a DocDO is dropped: the recheck answers without doing anything. */
let dropKicks = true;

function namespace<T extends object>(make: (name: string) => T) {
  const made = new Map<string, T>();
  const get = (name: string) => {
    let instance = made.get(name);
    if (!instance) made.set(name, (instance = make(name)));
    return instance;
  };
  return { get, made, idFromName: (name: string) => ({ name, toString: () => name }) };
}

const docs = namespace((name) => openDoc(new Backing(name), PullDocDO as never));
const docNs = {
  idFromName: docs.idFromName,
  get: (id: { name: string }) => new Proxy(docs.get(id.name).dobj, {
    get(target, prop) {
      if (prop === 'recheck' && dropKicks) return async () => ({ closed: 0 });
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }),
};
const principalBackings = new Map<string, Backing>();
const principals = namespace((name) => {
  let backing = principalBackings.get(name);
  if (!backing) principalBackings.set(name, (backing = new Backing(name)));
  return new PullPrincipalDO(new FakeState(backing) as never, {} as never);
});
const principalNs = {
  idFromName: principals.idFromName,
  get: (id: { name: string }) => new Proxy(principals.get(id.name), {
    get(target, prop) {
      // Sign-out's own kick is dropped too: Better Auth deletes the session either way.
      if (prop === 'endSession' && dropKicks) return async () => undefined;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }),
};

/** While set, runs once just before the first statement (or batch holding one) matching `sql`: a request landing then. */
let race: { sql: RegExp; run: () => Promise<unknown> } | null = null;
const REAL = Symbol('real');
const QUERY = Symbol('query');

function racingDb(db: D1Database): D1Database {
  const claim = async (query: string) => {
    const hook = race;
    if (!hook?.sql.test(query)) return;
    race = null;
    await hook.run();
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

let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: racingDb(d1.db), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: docNs as never, PrincipalDO: principalNs as never };
  ada = await signedUpUser(env, 'pull-ada', 'Ada');
  ben = await signedUpUser(env, 'pull-ben', 'Ben');
  cy = await signedUpUser(env, 'pull-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  dropKicks = true;
  race = null;
});

const call = (method: string, path: string, cookie: string | null, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

const upgrade = (docId: string, cookie: string | null, share?: string) =>
  new Request(`${BASE}/parties/doc-d-o/${docId}${share ? `?share=${share}` : ''}`, {
    headers: { upgrade: 'websocket', origin: BASE, ...(cookie ? { cookie } : {}) },
  });

/** The Worker's admission, then the socket at the DocDO with the trusted headers it set; says hello unless refused. */
async function join(docId: string, cookie: string | null, share?: string): Promise<{ opened: Opened; client: TestClient; headers: Record<string, string> }> {
  const verdict = await authenticateParty(upgrade(docId, cookie, share), docId, env);
  if (!verdict.ok) throw new Error(`admission refused ${verdict.code}`);
  const opened = await start(docs.get(docId));
  const client = await connect(opened, { headers: verdict.headers });
  if (!client.closed) await client.hello();
  return { opened, client, headers: verdict.headers };
}

const title = (opened: Opened) => opened.dobj.document.getText('title').toString();

/** The client writes `text` into the title and sends it, if its socket is still open. */
async function write(client: TestClient, text: string): Promise<void> {
  client.doc.getText('title').insert(client.doc.getText('title').length, text);
  await client.flush();
}

/** A write sent after the change committed never lands, and the socket is closed with `code`. */
async function refusedAfter(opened: Opened, client: TestClient, code: number, marker: string): Promise<void> {
  await write(client, marker);
  expect(client.closed?.code, 'the next frame closes the socket').toBe(code);
  expect(title(opened), 'the write sent after the change never lands').not.toContain(marker);
}

async function signIn(user: TestUser): Promise<string> {
  const response = await handleAuthRoute(new Request(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': '198.51.100.77' },
    body: JSON.stringify({ email: user.email, password: 'correct horse battery' }),
  }), env);
  if (response.status !== 200) throw new Error(`sign-in ${response.status}`);
  return response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function workspace(principalId: string, sessionId: string): Promise<FakeSocket> {
  const dobj = principals.get(principalId);
  await dobj.setName(principalId);
  await dobj.fetch(new Request('https://moss.invalid/api/workspace/ws', { headers: {
    upgrade: 'websocket', [TRUSTED.principal]: principalId, [TRUSTED.session]: sessionId,
  } }));
  return serverEnds.at(-1)!;
}

describe('a dropped kick is caught by the next frame @p:ppl-2', () => {
  it('a member removed through DELETE: their next frame closes 4403 and its write never lands', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'editor');
    const { opened, client } = await join(docId, ben.cookie);
    await write(client, 'before ');
    expect(title(opened)).toBe('before ');
    expect((await call('DELETE', `/api/docs/${docId}/members`, ada.cookie, { principalId: ben.id })).status).toBe(200);
    expect(client.closed, 'the kick was dropped').toBeNull();
    await refusedAfter(opened, client, CLOSE.revoked, 'after-removal');
  });

  it('a demotion through PATCH: the next frame closes 4403', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'editor');
    const { opened, client } = await join(docId, ben.cookie);
    expect((await call('PATCH', `/api/docs/${docId}/members`, ada.cookie, { principalId: ben.id, role: 'viewer' })).status).toBe(200);
    await refusedAfter(opened, client, CLOSE.revoked, 'after-demotion');
  });

  it('a lowering decided from a stale read (a racing raise) is still caught', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    expect((await call('PATCH', `/api/docs/${docId}/members`, ada.cookie, { principalId: ben.id, role: 'editor' })).status).toBe(200);
    const { opened, client } = await join(docId, ben.cookie);
    // The other PATCH read viewer and saw its change to commenter as a raise, so it never kicked.
    await d1.db.prepare("UPDATE doc_members SET role = 'commenter' WHERE doc_id = ? AND principal_id = ?").bind(docId, ben.id).run();
    await refusedAfter(opened, client, CLOSE.revoked, 'after-stale-raise');
  });

  it('a pending invite lowered and removed by email', async () => {
    const dee = await signedUpUser(env, 'pull-dee', 'Dee');
    const docId = await insertDoc(d1.db, ada);
    expect((await call('POST', `/api/docs/${docId}/members`, ada.cookie, { email: dee.email, role: 'editor' })).status).toBe(201);
    // The lowering lands while Dee's admission is under way, before it redeems the invite.
    race = { sql: /UPDATE invites SET accepted_at/i, run: () => call('PATCH', `/api/docs/${docId}/members`, ada.cookie, { email: dee.email, role: 'viewer' }) };
    const { opened, client, headers } = await join(docId, dee.cookie);
    expect(race, 'the lowering landed mid-admission').toBeNull();
    expect(headers[TRUSTED.role], 'the Worker resolved editor before the lowering').toBe('editor');
    expect(client.closed?.code, 'admission re-checks once the socket is registered').toBe(CLOSE.revoked);
    await refusedAfter(opened, client, CLOSE.revoked, 'after-email-lowering');

    const eli = await signedUpUser(env, 'pull-eli', 'Eli');
    const other = await insertDoc(d1.db, ada);
    expect((await call('POST', `/api/docs/${other}/members`, ada.cookie, { email: eli.email, role: 'editor' })).status).toBe(201);
    race = { sql: /UPDATE invites SET accepted_at/i, run: () => call('DELETE', `/api/docs/${other}/members`, ada.cookie, { email: eli.email }) };
    const second = await join(other, eli.cookie);
    expect(race).toBeNull();
    expect(second.client.closed?.code).toBe(CLOSE.revoked);
    await refusedAfter(second.opened, second.client, CLOSE.revoked, 'after-email-removal');
  });

  it('a link revoked during admission leaves no socket the revocation missed', async () => {
    const docId = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId }, 'editor');
    // The Worker resolved editor from the link; the revocation commits before the socket reaches the DocDO.
    const admitted = await authenticateParty(upgrade(docId, cy.cookie, token), docId, env);
    if (!admitted.ok) throw new Error('refused');
    expect(admitted.headers[TRUSTED.role]).toBe('editor');
    expect((await call('DELETE', `/api/docs/${docId}/links/${token}`, ada.cookie)).status).toBe(200);
    const opened = await start(docs.get(docId));
    const client = await connect(opened, { headers: admitted.headers });
    expect(client.closed?.code, 'admission re-checks once the socket is registered').toBe(CLOSE.revoked);
    await refusedAfter(opened, client, CLOSE.revoked, 'after-link-revoked');
  });

  it('a note moved out from under a folder grant, with the move’s kick dropped', async () => {
    const shared = await insertFolder(d1.db, ada, ada.homeId);
    const other = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId: shared });
    await insertGrant(d1.db, { folderId: shared }, ben, 'editor');
    const { opened, client } = await join(docId, ben.cookie);
    expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: other })).status).toBe(200);
    await refusedAfter(opened, client, CLOSE.revoked, 'after-move');
  });

  it('two racing moves: the socket the move in between let in is caught', async () => {
    const start1 = await insertFolder(d1.db, ada, ada.homeId);
    const between = await insertFolder(d1.db, ada, ada.homeId);
    const end = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId: start1 });
    await insertGrant(d1.db, { folderId: between }, ben, 'editor');
    await d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(between, docId).run();
    const { opened, client } = await join(docId, ben.cookie);
    // The other move read the note in `start1`, so its diff never names Ben.
    await d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(end, docId).run();
    await refusedAfter(opened, client, CLOSE.revoked, 'after-racing-move');
  });

  it('a move landing between a removal’s commit and its recipient query, with real kicks', async () => {
    dropKicks = false;
    const shared = await insertFolder(d1.db, ada, ada.homeId);
    const other = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId: shared });
    await insertGrant(d1.db, { folderId: shared }, ben, 'editor');
    const { opened, client } = await join(docId, ben.cookie);
    // The removal commits, then the note moves out before the removal asks which docs the folder reaches.
    race = { sql: /JOIN sub ON d\.folder_id = sub\.id/i, run: () => d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(other, docId).run() };
    expect((await call('DELETE', `/api/folders/${shared}/members`, ada.cookie, { principalId: ben.id })).status).toBe(200);
    expect(race).toBeNull();
    await refusedAfter(opened, client, CLOSE.revoked, 'after-unrecipiented-removal');
  });

  it('moving a note out of a linked folder and back reopens it to the link’s holder', async () => {
    dropKicks = false;
    const linked = await insertFolder(d1.db, ada, ada.homeId);
    const other = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId: linked });
    const token = await insertLink(d1.db, { folderId: linked }, 'editor');
    const first = await join(docId, cy.cookie, token);
    expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: other })).status).toBe(200);
    expect(first.client.closed?.code).toBe(CLOSE.revoked);
    expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: linked })).status).toBe(200);
    const again = await join(docId, cy.cookie, token);
    expect(again.client.closed, 'the link reaches the note again').toBeNull();
    await write(again.client, 'back-in');
    expect(title(again.opened)).toContain('back-in');
  });
});

describe('a session ended by any path @p:ppl-2', () => {
  it('Better Auth’s revoke-other-sessions ends the other session’s doc and workspace sockets', async () => {
    const fay = await signedUpUser(env, 'pull-fay', 'Fay');
    const docId = await insertDoc(d1.db, fay);
    const other = await signIn(fay);
    const { opened, client, headers } = await join(docId, other);
    const channel = await workspace(fay.id, headers[TRUSTED.session]);
    expect(channel.closed).toBeNull();
    const revoked = await handleAuthRoute(new Request(`${BASE}/api/auth/revoke-other-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: fay.cookie }, body: '{}',
    }), env);
    expect(revoked.status).toBe(200);
    await refusedAfter(opened, client, CLOSE.sessionEnded, 'after-revoke-other');
    await principals.get(fay.id).publish({ type: 'meta', docIds: [docId], folderIds: [] });
    expect(channel.closed?.code, 'the next event closes the workspace socket').toBe(CLOSE.sessionEnded);
    expect(channel.sent.filter((frame) => typeof frame === 'string' && frame.includes('"meta"')), 'no event reaches it').toEqual([]);
  });

  it('a sign-out whose endSession is dropped, and a workspace socket that arrives after it', async () => {
    const gus = await signedUpUser(env, 'pull-gus', 'Gus');
    const docId = await insertDoc(d1.db, gus);
    const other = await signIn(gus);
    const { opened, client, headers } = await join(docId, other);
    const sessionId = headers[TRUSTED.session];
    const channel = await workspace(gus.id, sessionId);
    const out = await handleAuthRoute(new Request(`${BASE}/api/auth/sign-out`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: other }, body: '{}',
    }), env);
    expect(out.status).toBe(200);
    await refusedAfter(opened, client, CLOSE.sessionEnded, 'after-sign-out');
    await principals.get(gus.id).webSocketMessage(channel as never, 'ping');
    expect(channel.closed?.code, 'its next ping closes the workspace socket').toBe(CLOSE.sessionEnded);
    const late = await workspace(gus.id, sessionId);
    expect(late.closed?.code, 'a workspace socket resolved before the sign-out and arriving after it').toBe(CLOSE.sessionEnded);
  });
});

describe('sockets that send nothing @p:ppl-2', () => {
  it('a reader whose access is removed closes within one tick, and hears nothing a writer sends after the removal', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    const owner = await join(docId, ada.cookie);
    const reader = await join(docId, ben.cookie);
    expect(owner.opened.backing.alarm, 'a tick is due within ACCESS_TICK_MS of the last frame').not.toBeNull();
    expect(owner.opened.backing.alarm!).toBeLessThanOrEqual(Date.now() + ACCESS_TICK_MS);
    await d1.db.prepare('DELETE FROM doc_members WHERE doc_id = ? AND principal_id = ?').bind(docId, ben.id).run();
    await write(owner.client, 'secret-after-removal');
    expect(reader.client.closed?.code, 'the writer’s frame validates every socket first').toBe(CLOSE.revoked);
    await reader.client.pump();
    expect(reader.client.doc.getText('title').toString()).not.toContain('secret-after-removal');

    const quiet = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: quiet }, ben, 'viewer');
    const idle = await join(quiet, ben.cookie);
    await d1.db.prepare('DELETE FROM doc_members WHERE doc_id = ? AND principal_id = ?').bind(quiet, ben.id).run();
    expect(idle.client.closed).toBeNull();
    await idle.opened.dobj.alarm();
    expect(idle.client.closed?.code, 'the tick closes it').toBe(CLOSE.revoked);
  });
});

describe('a manager being removed cannot act on the access they are losing @p:ppl-2', () => {
  it('a co-owner demoted while creating a link creates none', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, cy, 'owner');
    race = { sql: /INSERT INTO share_links/i, run: () => d1.db.prepare("UPDATE doc_members SET role = 'viewer' WHERE doc_id = ? AND principal_id = ?").bind(docId, cy.id).run() };
    const response = await call('POST', `/api/docs/${docId}/links`, cy.cookie, { role: 'editor' });
    expect(race).toBeNull();
    expect([403, 404]).toContain(response.status);
    const links = await d1.db.prepare("SELECT count(*) AS n FROM share_links WHERE target_type = 'doc' AND target_id = ?").bind(docId).first<{ n: number }>();
    expect(links?.n).toBe(0);
  });

  it('a co-owner removed while creating a folder link creates none', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    await insertGrant(d1.db, { folderId: folder }, cy, 'owner');
    race = { sql: /INSERT INTO share_links/i, run: () => d1.db.prepare('DELETE FROM folder_members WHERE folder_id = ? AND principal_id = ?').bind(folder, cy.id).run() };
    const response = await call('POST', `/api/folders/${folder}/links`, cy.cookie, { role: 'editor' });
    expect(race).toBeNull();
    expect([403, 404]).toContain(response.status);
    const links = await d1.db.prepare("SELECT count(*) AS n FROM share_links WHERE target_type = 'folder' AND target_id = ?").bind(folder).first<{ n: number }>();
    expect(links?.n).toBe(0);
  });

  it('a co-owner demoted while moving a note or a folder moves nothing', async () => {
    const shared = await insertFolder(d1.db, ada, ada.homeId);
    const other = await insertFolder(d1.db, ada, ada.homeId);
    await insertGrant(d1.db, { folderId: ada.homeId }, cy, 'owner');
    const docId = await insertDoc(d1.db, ada, { folderId: shared });
    const demote = () => d1.db.prepare("UPDATE folder_members SET role = 'editor' WHERE folder_id = ? AND principal_id = ?").bind(ada.homeId, cy.id).run();
    race = { sql: /UPDATE docs SET folder_id/i, run: demote };
    const note = await call('PATCH', `/api/docs/${docId}`, cy.cookie, { folderId: other });
    expect(race).toBeNull();
    expect(note.status).toBe(403);
    expect((await d1.db.prepare('SELECT folder_id FROM docs WHERE id = ?').bind(docId).first<{ folder_id: string }>())?.folder_id).toBe(shared);

    await d1.db.prepare("UPDATE folder_members SET role = 'owner' WHERE folder_id = ? AND principal_id = ?").bind(ada.homeId, cy.id).run();
    race = { sql: /UPDATE folders SET name = coalesce/i, run: demote };
    const folder = await call('PATCH', `/api/folders/${shared}`, cy.cookie, { parentId: other });
    expect(race).toBeNull();
    expect(folder.status).toBe(403);
    expect((await d1.db.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(shared).first<{ parent_id: string }>())?.parent_id).toBe(ada.homeId);

    await d1.db.prepare("UPDATE folder_members SET role = 'owner' WHERE folder_id = ? AND principal_id = ?").bind(ada.homeId, cy.id).run();
    race = { sql: /UPDATE folders SET deleted_at/i, run: demote };
    const trash = await call('DELETE', `/api/folders/${shared}`, cy.cookie);
    expect(race).toBeNull();
    expect(trash.status).toBe(403);
    expect((await d1.db.prepare('SELECT deleted_at FROM folders WHERE id = ?').bind(shared).first<{ deleted_at: number | null }>())?.deleted_at).toBeNull();
  });
});

describe('the REST write window survives a wake @p:tech-8', () => {
  it('the 61st rename in a minute is refused 429 after the PrincipalDO is evicted', async () => {
    const docId = await insertDoc(d1.db, ada);
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) {
      expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { title: `Rename ${i}` })).status).toBe(200);
    }
    // Evicted: a fresh instance over the same storage.
    principals.made.delete(ada.id);
    expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { title: 'One too many' })).status).toBe(429);
    expect(title(docs.get(docId))).toBe(`Rename ${REST_WRITE_RATE.max - 1}`);
  });
});
