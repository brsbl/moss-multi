// The one kick path over REST (T2.5; A§7, A§8): lowering or removing a member, revoking a link, moving a note or a
// folder out from under a grant or link, and signing out each reach every recipient DocDO through an awaited recheck
// before the call returns, and a DO that does not acknowledge fails the call with 503 so the owner can retry.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import {
  BASE, insertAgent, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser,
} from '../test/principals.ts';
import { TRUSTED } from '@moss-multi/protocol/sync';
import { handleAuthRoute } from '../auth/route.ts';
import { authenticateParty } from '../worker/party.ts';
import { handleApi } from './router.ts';

interface Recheck { principalIds?: string[]; tokens?: string[]; sessions?: string[]; everyone?: boolean; at?: number }

const rechecks: { docId: string; input: Recheck }[] = [];
const failing = new Set<string>();
const ended: { principalId: string; sessionId: string }[] = [];
let endFails = false;

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    recheck: async (input: Recheck) => {
      if (failing.has(id.name)) throw new Error('DocDO unavailable');
      rechecks.push({ docId: id.name, input });
      return { closed: 0 };
    },
  }),
};

const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    publish: async () => undefined,
    endSession: async (sessionId: string) => {
      if (endFails) throw new Error('PrincipalDO unavailable');
      ended.push({ principalId: id.name, sessionId });
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
  env = { DB: racingDb(d1.db), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'kick-ada', 'Ada');
  ben = await signedUpUser(env, 'kick-ben', 'Ben');
  cy = await signedUpUser(env, 'kick-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  rechecks.length = 0;
  failing.clear();
  ended.length = 0;
  endFails = false;
  race = null;
});

/** While set, runs once just before the first statement (or batch holding one) matching `sql`: a request landing then. */
let race: { sql: RegExp; run: () => Promise<unknown> } | null = null;
const REAL = Symbol('real');
const QUERY = Symbol('query');

/** D1 as the routes see it, with `race` run ahead of the statement it matches. */
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

const call = (method: string, path: string, cookie: string | null, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

const roleOf = async (table: 'doc_members' | 'folder_members', column: 'doc_id' | 'folder_id', target: string, principalId: string) =>
  (await d1.db.prepare(`SELECT role FROM ${table} WHERE ${column} = ? AND principal_id = ?`).bind(target, principalId).first<{ role: string }>())?.role ?? null;

const kicked = (docId: string) => rechecks.filter((r) => r.docId === docId);

describe('members: lowering and removing access kicks @p:ppl-2', () => {
  it('lowers a member through PATCH and rechecks the doc for them and their agents before answering', async () => {
    const fay = await signedUpUser(env, 'kick-fay', 'Fay');
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, fay, 'editor');
    const agent = await insertAgent(d1.db, fay);
    const before = Date.now();
    const response = await call('PATCH', `/api/docs/${docId}/members`, ada.cookie, { principalId: fay.id, role: 'viewer' });
    expect(response.status).toBe(200);
    expect(await roleOf('doc_members', 'doc_id', docId, fay.id)).toBe('viewer');
    expect(kicked(docId)).toHaveLength(1);
    expect([...(kicked(docId)[0].input.principalIds ?? [])].sort()).toEqual([agent.id, fay.id].sort());
    expect(kicked(docId)[0].input.at).toBeGreaterThanOrEqual(before);
  });

  it('a raise kicks nobody: a promotion takes effect on reload', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    const response = await call('PATCH', `/api/docs/${docId}/members`, ada.cookie, { principalId: ben.id, role: 'editor' });
    expect(response.status).toBe(200);
    expect(await roleOf('doc_members', 'doc_id', docId, ben.id)).toBe('editor');
    expect(rechecks).toEqual([]);
  });

  it('removes a member through DELETE and rechecks the doc', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'editor');
    const response = await call('DELETE', `/api/docs/${docId}/members`, ada.cookie, { principalId: ben.id });
    expect(response.status).toBe(200);
    expect(await roleOf('doc_members', 'doc_id', docId, ben.id)).toBeNull();
    expect(kicked(docId).map((r) => r.input.principalIds)).toEqual([[ben.id]]);
  });

  it('a folder or vault change reaches every live doc in the subtree and nothing else', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const sub = await insertFolder(d1.db, ada, folder);
    const inFolder = await insertDoc(d1.db, ada, { folderId: folder });
    const inSub = await insertDoc(d1.db, ada, { folderId: sub });
    const trashed = await insertDoc(d1.db, ada, { folderId: sub, deleted: true });
    const outside = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { folderId: folder }, ben, 'editor');
    const response = await call('DELETE', `/api/folders/${folder}/members`, ada.cookie, { principalId: ben.id });
    expect(response.status).toBe(200);
    expect(rechecks.map((r) => r.docId).sort()).toEqual([inFolder, inSub].sort());
    expect(kicked(trashed)).toEqual([]);
    expect(kicked(outside)).toEqual([]);

    await insertGrant(d1.db, { folderId: ada.homeId }, cy, 'editor');
    rechecks.length = 0;
    expect((await call('PATCH', `/api/folders/${ada.homeId}/members`, ada.cookie, { principalId: cy.id, role: 'commenter' })).status).toBe(200);
    expect(rechecks.map((r) => r.docId)).toEqual(expect.arrayContaining([inFolder, inSub, outside]));
  });

  it('only the owner changes or removes access; others are refused and nobody is kicked', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'editor');
    await insertGrant(d1.db, { docId }, cy, 'editor');
    expect((await call('PATCH', `/api/docs/${docId}/members`, ben.cookie, { principalId: cy.id, role: 'viewer' })).status).toBe(403);
    expect((await call('DELETE', `/api/docs/${docId}/members`, ben.cookie, { principalId: cy.id })).status).toBe(403);
    expect((await call('DELETE', `/api/docs/${docId}/members`, null, { principalId: cy.id })).status).toBe(401);
    expect(await roleOf('doc_members', 'doc_id', docId, cy.id)).toBe('editor');
    expect(rechecks).toEqual([]);
  });

  it('the vault owner is never a member to lower or remove', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'owner');
    expect((await call('DELETE', `/api/docs/${docId}/members`, ben.cookie, { principalId: ada.id })).status).toBe(404);
    expect((await call('PATCH', `/api/docs/${docId}/members`, ben.cookie, { principalId: ada.id, role: 'viewer' })).status).toBe(404);
  });

  it('answers 503 when a DocDO does not acknowledge, and a retry kicks again', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'editor');
    failing.add(docId);
    const failed = await call('DELETE', `/api/docs/${docId}/members`, ada.cookie, { principalId: ben.id });
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as { message?: string }).message).toMatch(/try again/i);
    failing.clear();
    const retried = await call('DELETE', `/api/docs/${docId}/members`, ada.cookie, { principalId: ben.id });
    expect(retried.status).toBe(200);
    expect(kicked(docId).map((r) => r.input.principalIds)).toEqual([[ben.id]]);
  });

  it('changes and removes a pending invite by email, answering alike for a known and an unknown address', async () => {
    const docId = await insertDoc(d1.db, ada);
    const unknown = `nobody-${Date.now()}@example.invalid`;
    for (const email of [cy.email, unknown]) {
      expect((await call('POST', `/api/docs/${docId}/members`, ada.cookie, { email, role: 'editor' })).status).toBe(201);
    }
    const answers: [number, string][] = [];
    for (const email of [cy.email, unknown]) {
      const lowered = await call('PATCH', `/api/docs/${docId}/members`, ada.cookie, { email, role: 'viewer' });
      answers.push([lowered.status, await lowered.text()]);
    }
    expect(answers[0][0]).toBe(200);
    expect(answers[1]).toEqual([answers[0][0], answers[0][1].replace(cy.email, unknown)]);
    expect(await roleOf('doc_members', 'doc_id', docId, cy.id)).toBe('viewer');
    const listed = (await (await call('GET', `/api/docs/${docId}/members`, ada.cookie)).json()) as { invites: { email: string; role: string }[] };
    expect(listed.invites).toEqual([{ email: cy.email, role: 'viewer' }, { email: unknown, role: 'viewer' }]);

    for (const email of [cy.email, unknown]) {
      expect((await call('DELETE', `/api/docs/${docId}/members`, ada.cookie, { email })).status).toBe(200);
    }
    expect(await roleOf('doc_members', 'doc_id', docId, cy.id)).toBeNull();
    const after = (await (await call('GET', `/api/docs/${docId}/members`, ada.cookie)).json()) as { invites: unknown[] };
    expect(after.invites).toEqual([]);
  });
});

describe('a change of access rests on the caller still managing the target, in the same statement @p:ppl-2', () => {
  it('a co-owner demoted while their PATCH is in flight cannot restore their own owner role', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, cy, 'owner');
    race = { sql: /UPDATE doc_members SET role/i, run: () => d1.db.prepare("UPDATE doc_members SET role = 'editor' WHERE doc_id = ? AND principal_id = ?").bind(docId, cy.id).run() };
    const response = await call('PATCH', `/api/docs/${docId}/members`, cy.cookie, { principalId: cy.id, role: 'owner' });
    expect(race, 'the demotion landed before the write').toBeNull();
    expect(response.status).toBe(403);
    expect(await roleOf('doc_members', 'doc_id', docId, cy.id)).toBe('editor');
  });

  it('a co-owner whose folder grant is removed mid-request changes and removes nobody', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    await insertGrant(d1.db, { folderId: folder }, cy, 'owner');
    await insertGrant(d1.db, { folderId: folder }, ben, 'editor');
    const demote = () => d1.db.prepare('DELETE FROM folder_members WHERE folder_id = ? AND principal_id = ?').bind(folder, cy.id).run();
    race = { sql: /DELETE FROM folder_members/i, run: demote };
    const removal = await call('DELETE', `/api/folders/${folder}/members`, cy.cookie, { principalId: ben.id });
    expect(race).toBeNull();
    // Cy still sees the vault through an earlier test's grant, so the refusal is 403 here and 404 without access.
    expect([403, 404]).toContain(removal.status);
    expect(await roleOf('folder_members', 'folder_id', folder, ben.id)).toBe('editor');
  });
});

describe('a lowering decided from a stale read still kicks @p:ppl-2', () => {
  it('a PATCH that read viewer, landing after another raised to editor, lowers editor to commenter and kicks', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    race = { sql: /UPDATE doc_members SET role/i, run: () => d1.db.prepare("UPDATE doc_members SET role = 'editor' WHERE doc_id = ? AND principal_id = ?").bind(docId, ben.id).run() };
    const response = await call('PATCH', `/api/docs/${docId}/members`, ada.cookie, { principalId: ben.id, role: 'commenter' });
    expect(race).toBeNull();
    expect(response.status).toBe(200);
    expect(await roleOf('doc_members', 'doc_id', docId, ben.id)).toBe('commenter');
    expect(kicked(docId).flatMap((r) => r.input.principalIds ?? [])).toContain(ben.id);
  });
});

describe('pending invites: a removal by email whose kick failed can be retried @p:ppl-2', () => {
  it('kicks again on the retry and answers alike for a known and an unknown address', async () => {
    const ida = await signedUpUser(env, 'kick-ida', 'Ida');
    const unknown = `nobody-retry-${Date.now()}@example.invalid`;
    const docId = await insertDoc(d1.db, ada);
    const answers: [number, string][] = [];
    for (const email of [ida.email, unknown]) {
      expect((await call('POST', `/api/docs/${docId}/members`, ada.cookie, { email, role: 'editor' })).status).toBe(201);
      failing.add(docId);
      expect((await call('DELETE', `/api/docs/${docId}/members`, ada.cookie, { email })).status).toBe(503);
      failing.clear();
      rechecks.length = 0;
      const retried = await call('DELETE', `/api/docs/${docId}/members`, ada.cookie, { email });
      answers.push([retried.status, (await retried.text()).replace(email, '<email>')]);
      expect(kicked(docId), `the retry for ${email === unknown ? 'the unknown' : 'the known'} email kicks`).toHaveLength(1);
      if (email === ida.email) expect(kicked(docId)[0].input.principalIds).toContain(ida.id);
    }
    expect(answers[0][0]).toBe(200);
    expect(answers[1]).toEqual(answers[0]);
  });
});

describe('pending invites: lowering or removing one by email kicks whoever it already granted @p:ppl-2', () => {
  it('kicks the person on a lowering and on a removal, as the member path does', async () => {
    const hal = await signedUpUser(env, 'kick-hal', 'Hal');
    const docId = await insertDoc(d1.db, ada);
    expect((await call('POST', `/api/docs/${docId}/members`, ada.cookie, { email: hal.email, role: 'editor' })).status).toBe(201);
    rechecks.length = 0;
    expect((await call('PATCH', `/api/docs/${docId}/members`, ada.cookie, { email: hal.email, role: 'viewer' })).status).toBe(200);
    expect(kicked(docId).flatMap((r) => r.input.principalIds ?? [])).toContain(hal.id);
    rechecks.length = 0;
    expect((await call('DELETE', `/api/docs/${docId}/members`, ada.cookie, { email: hal.email })).status).toBe(200);
    expect(kicked(docId).flatMap((r) => r.input.principalIds ?? [])).toContain(hal.id);
  });
});

describe('links: revoking one kicks every connection that presented it @p:ppl-2', () => {
  it('rechecks the linked doc for the token', async () => {
    const docId = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId }, 'editor');
    expect((await call('DELETE', `/api/docs/${docId}/links/${token}`, ada.cookie)).status).toBe(200);
    expect(kicked(docId).map((r) => r.input.tokens)).toEqual([[token]]);
  });

  it('a folder link reaches every live doc below it, and a retry after a 503 kicks again', async () => {
    const folder = await insertFolder(d1.db, ada, ada.homeId);
    const sub = await insertFolder(d1.db, ada, folder);
    const top = await insertDoc(d1.db, ada, { folderId: folder });
    const deep = await insertDoc(d1.db, ada, { folderId: sub });
    const token = await insertLink(d1.db, { folderId: folder }, 'viewer');
    failing.add(deep);
    expect((await call('DELETE', `/api/folders/${folder}/links/${token}`, ada.cookie)).status).toBe(503);
    failing.clear();
    rechecks.length = 0;
    expect((await call('DELETE', `/api/folders/${folder}/links/${token}`, ada.cookie)).status).toBe(200);
    expect(rechecks.map((r) => r.docId).sort()).toEqual([top, deep].sort());
    expect(rechecks.every((r) => r.input.tokens?.[0] === token)).toBe(true);
    expect((await call('DELETE', `/api/folders/${folder}/links/forged`, ada.cookie)).status).toBe(404);
  });
});

describe('moves: losing a grant or link through a move kicks @p:ppl-2', () => {
  it('a note moved out of a shared folder kicks the folder grantee and the folder link, not the owner', async () => {
    const shared = await insertFolder(d1.db, ada, ada.homeId);
    const other = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId: shared });
    await insertGrant(d1.db, { folderId: shared }, ben, 'editor');
    const token = await insertLink(d1.db, { folderId: shared }, 'viewer');
    const response = await call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: other });
    expect(response.status).toBe(200);
    const inputs = kicked(docId).map((r) => r.input);
    expect(inputs.flatMap((i) => i.principalIds ?? [])).toEqual([ben.id]);
    expect(inputs.flatMap((i) => i.tokens ?? [])).toEqual([token]);
  });

  it('a retried note move whose kick failed kicks again instead of answering a silent 200', async () => {
    const shared = await insertFolder(d1.db, ada, ada.homeId);
    const other = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId: shared });
    await insertGrant(d1.db, { folderId: shared }, ben, 'editor');
    failing.add(docId);
    expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: other })).status).toBe(503);
    failing.clear();
    expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: other })).status).toBe(200);
    const retry = kicked(docId).map((r) => r.input);
    expect(retry.some((input) => input.everyone === true || input.principalIds?.includes(ben.id))).toBe(true);
  });

  it('a retried folder move whose kick failed kicks again', async () => {
    const shared = await insertFolder(d1.db, ada, ada.homeId);
    const moving = await insertFolder(d1.db, ada, shared);
    const docId = await insertDoc(d1.db, ada, { folderId: moving });
    await insertGrant(d1.db, { folderId: shared }, ben, 'editor');
    failing.add(docId);
    expect((await call('PATCH', `/api/folders/${moving}`, ada.cookie, { parentId: ada.homeId })).status).toBe(503);
    failing.clear();
    expect((await call('PATCH', `/api/folders/${moving}`, ada.cookie, { parentId: ada.homeId })).status).toBe(200);
    const retry = kicked(docId).map((r) => r.input);
    expect(retry.some((input) => input.everyone === true || input.principalIds?.includes(ben.id))).toBe(true);
  });

  it('a note moved by two racing requests kicks whoever the one in between let in', async () => {
    const start = await insertFolder(d1.db, ada, ada.homeId);
    const between = await insertFolder(d1.db, ada, ada.homeId);
    const end = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId: start });
    await insertGrant(d1.db, { folderId: between }, ben, 'editor');
    const token = await insertLink(d1.db, { folderId: between }, 'editor');
    race = { sql: /UPDATE docs SET folder_id/i, run: () => d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(between, docId).run() };
    expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: end })).status).toBe(200);
    expect(race).toBeNull();
    const inputs = kicked(docId).map((r) => r.input);
    expect(inputs.some((i) => i.everyone === true || i.principalIds?.includes(ben.id)), 'the grantee on the folder in between').toBe(true);
    expect(inputs.some((i) => i.everyone === true || i.tokens?.includes(token)), 'the link on the folder in between').toBe(true);
  });

  it('a folder moved by two racing requests kicks whoever the one in between let in', async () => {
    const between = await insertFolder(d1.db, ada, ada.homeId);
    const end = await insertFolder(d1.db, ada, ada.homeId);
    const moving = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId: moving });
    await insertGrant(d1.db, { folderId: between }, ben, 'editor');
    race = { sql: /UPDATE folders SET name = coalesce/i, run: () => d1.db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').bind(between, moving).run() };
    expect((await call('PATCH', `/api/folders/${moving}`, ada.cookie, { parentId: end })).status).toBe(200);
    expect(race).toBeNull();
    expect(kicked(docId).some((r) => r.input.everyone === true || r.input.principalIds?.includes(ben.id))).toBe(true);
  });

  it('a folder moved out from under a grant kicks its docs for that grantee', async () => {
    const shared = await insertFolder(d1.db, ada, ada.homeId);
    const moving = await insertFolder(d1.db, ada, shared);
    const docId = await insertDoc(d1.db, ada, { folderId: moving });
    const gus = await signedUpUser(env, 'kick-gus', 'Gus');
    await insertGrant(d1.db, { folderId: shared }, gus, 'viewer');
    expect((await call('PATCH', `/api/folders/${moving}`, ada.cookie, { parentId: ada.homeId })).status).toBe(200);
    expect(kicked(docId).flatMap((r) => r.input.principalIds ?? [])).toEqual([gus.id]);
  });
});

describe('sign-out ends the session everywhere @p:ppl-2', () => {
  const signOut = (cookie: string) => handleAuthRoute(new Request(`${BASE}/api/auth/sign-out`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{}',
  }), env);

  it('awaits PrincipalDO.endSession for the session before answering', async () => {
    const dee = await signedUpUser(env, 'kick-dee', 'Dee');
    const session = (await (await call('GET', '/api/me', dee.cookie)).json()) as { principal: { id: string } };
    expect(session.principal.id).toBe(dee.id);
    const response = await signOut(dee.cookie);
    expect(response.status).toBe(200);
    expect(ended).toHaveLength(1);
    expect(ended[0].principalId).toBe(dee.id);
    expect(ended[0].sessionId).toMatch(/\S/);
    expect((await call('GET', '/api/me', dee.cookie)).status).toBe(401);
  });

  it('keeps the session when the PrincipalDO cannot end it, so the person can try again', async () => {
    const eve = await signedUpUser(env, 'kick-eve', 'Eve');
    endFails = true;
    expect((await signOut(eve.cookie)).status).toBe(503);
    expect((await call('GET', '/api/me', eve.cookie)).status).toBe(200);
    endFails = false;
    expect((await signOut(eve.cookie)).status).toBe(200);
    expect((await call('GET', '/api/me', eve.cookie)).status).toBe(401);
  });
});

describe('admission stamps what a recheck fences on @p:ppl-2', () => {
  const upgrade = (docId: string, cookie: string | null, share?: string) =>
    new Request(`${BASE}/parties/doc-d-o/${docId}${share ? `?share=${share}` : ''}`, {
      headers: { upgrade: 'websocket', origin: BASE, ...(cookie ? { cookie } : {}) },
    });

  it('stamps when the role was resolved, taken before the resolver reads D1', async () => {
    const docId = await insertDoc(d1.db, ada);
    const before = Date.now();
    const verdict = await authenticateParty(upgrade(docId, ada.cookie), docId, env);
    if (!verdict.ok) throw new Error('refused');
    const at = Number(verdict.headers[TRUSTED.resolvedAt]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('attaches the link to a socket whose role came from it, even when the link is revoked mid-admission', async () => {
    const docId = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId }, 'editor');
    const racing = afterFirstLinkRead(d1.db, async () => {
      await d1.db.prepare('UPDATE share_links SET revoked_at = ? WHERE token = ?').bind(Date.now(), token).run();
    });
    const verdict = await authenticateParty(upgrade(docId, cy.cookie, token), docId, { ...env, DB: racing });
    if (!verdict.ok) throw new Error('refused');
    expect(verdict.headers[TRUSTED.role]).toBe('editor');
    expect(verdict.headers[TRUSTED.share]).toBe(token);
  });

  it('forwards a share token only while its link is live, so a grantee is not kicked forever by a dead link', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    const live = await insertLink(d1.db, { docId }, 'editor');
    const dead = await insertLink(d1.db, { docId }, 'editor', { revoked: true });
    const withLive = await authenticateParty(upgrade(docId, ben.cookie, live), docId, env);
    const withDead = await authenticateParty(upgrade(docId, ben.cookie, dead), docId, env);
    if (!withLive.ok || !withDead.ok) throw new Error('refused');
    expect(withLive.headers[TRUSTED.share]).toBe(live);
    expect(withDead.headers[TRUSTED.share]).toBeUndefined();
    expect(withDead.headers[TRUSTED.role]).toBe('viewer');
  });
});

/** `db`, running `then` once right after the first statement that reads share_links answers (a revocation racing it). */
function afterFirstLinkRead(db: D1Database, then: () => Promise<void>): D1Database {
  let fired = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
      if (typeof value !== 'function') return value;
      if (prop !== 'all' && prop !== 'raw' && prop !== 'first' && prop !== 'run') return value.bind(target);
      return async (...args: unknown[]) => {
        const result: unknown = await value.apply(target, args);
        if (!fired) {
          fired = true;
          await then();
        }
        return result;
      };
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'prepare') return (query: string) => (/share_links/.test(query) ? wrap(target.prepare(query)) : target.prepare(query));
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
