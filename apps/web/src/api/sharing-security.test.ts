// T2.4s, the security follow-up to full sharing: (a) a share by email does the same database work and answers alike
// whether or not the email has an account, so neither timing nor the owner's member list says which; (b) a granted
// owner (a co-owner) can neither lower, remove nor replace the vault's owner, and owner access never comes from a
// share link or an agent key; (c) concurrent shares of one person settle on the highest role, in one invite and one
// grant row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import {
  agentKey, BASE, insertAgent, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser,
} from '../test/principals.ts';
import { handleApi } from './router.ts';

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined, create: async () => undefined }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  // No PrincipalDO: nothing here renames a doc (its only required use), and nothing is published.
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: undefined as never };
  ada = await signedUpUser(env, 't24s-ada', 'Ada');
  ben = await signedUpUser(env, 't24s-ben', 'Ben');
  cy = await signedUpUser(env, 't24s-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());

const request = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const call = (method: string, path: string, cookie: string | null, body?: unknown, over = env) =>
  handleApi(request(method, path, cookie ? { cookie } : {}, body), over);
const asAgent = (method: string, path: string, key: string, body?: unknown) =>
  handleApi(request(method, path, { authorization: `Bearer ${key}` }, body), env);

async function roleOf(headers: Record<string, string>, docId: string, token?: string): Promise<string | null> {
  const response = await handleApi(request('GET', `/api/docs/${docId}${token ? `?share=${token}` : ''}`, headers), env);
  return response.status === 200 ? ((await response.json()) as { role: string }).role : null;
}

const unknownEmail = (label: string) => `mm-t24s-${label}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;

/** The D1 work one request does, in order: each statement's SQL (values aside) and each batch's size. */
function recording(db: D1Database, log: string[]): D1Database {
  return {
    prepare: (query: string) => {
      log.push(query.replace(/\s+/g, ' ').trim());
      return db.prepare(query);
    },
    batch: (statements: D1PreparedStatement[]) => {
      log.push(`batch of ${statements.length}`);
      return db.batch(statements);
    },
    exec: (query: string) => db.exec(query),
    dump: () => db.dump(),
    withSession: (constraint?: string) => db.withSession(constraint as never),
  } as unknown as D1Database;
}

/** A share's answer and the D1 work behind it. */
async function traced(docId: string, email: string, role: string) {
  const log: string[] = [];
  const response = await call('POST', `/api/docs/${docId}/members`, ada.cookie, { email, role }, { ...env, DB: recording(d1.db, log) });
  return { status: response.status, body: (await response.text()).replaceAll(email, '<email>'), log };
}

describe('(a) no account enumeration beyond the rate limit', () => {
  it('does the same database work for a known and an unknown email, at every step of a share', async () => {
    const known = await insertDoc(d1.db, ada);
    const unknown = await insertDoc(d1.db, ada);
    const ghost = unknownEmail('trace');
    // A first share, a repeat, a raise and a refused lowering: the grant path and the invite path alike.
    for (const role of ['commenter', 'commenter', 'editor', 'viewer']) {
      const a = await traced(known, ben.email, role);
      const b = await traced(unknown, ghost, role);
      expect(b.status, role).toBe(a.status);
      expect(b.body, role).toBe(a.body);
      expect(b.log, `${role}: the statements an unknown email runs`).toEqual(a.log);
    }
    expect(await roleOf({ cookie: ben.cookie }, known), 'the known account is granted all the same').toBe('editor');
  });

  it("shows the owner the same member list after sharing with a known or an unknown email", async () => {
    const known = await insertDoc(d1.db, ada);
    const unknown = await insertDoc(d1.db, ada);
    const ghost = unknownEmail('list');
    expect((await call('POST', `/api/docs/${known}/members`, ada.cookie, { email: cy.email, role: 'editor' })).status).toBe(201);
    expect((await call('POST', `/api/docs/${unknown}/members`, ada.cookie, { email: ghost, role: 'editor' })).status).toBe(201);
    const listed = async (docId: string, email: string) =>
      (await (await call('GET', `/api/docs/${docId}/members`, ada.cookie)).text()).replaceAll(email, '<email>');
    expect(await listed(unknown, ghost)).toBe(await listed(known, cy.email));
  });
});

describe('(b) the vault owner stays the owner', () => {
  // About 30 requests, each resolving access over D1.
  it("lets a co-owner neither lower nor remove the vault's owner, nor take the vault", async () => {
    // Its own co-owner: a grant on Ada's Home reaches every note of Ada's the later tests make.
    const co = await signedUpUser(env, 't24s-co', 'Co');
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId });
    await insertGrant(d1.db, { folderId: ada.homeId }, co, 'owner');
    expect(await roleOf({ cookie: co.cookie }, docId), 'Co co-owns the vault').toBe('owner');

    for (const [type, id] of [['folders', ada.homeId], ['folders', folderId], ['docs', docId]] as const) {
      const path = `/api/${type}/${id}/members`;
      for (const email of [ada.email, ada.email.toUpperCase(), ` ${ada.email} `]) {
        const lowered = await call('POST', path, co.cookie, { email, role: 'viewer' });
        expect(lowered.status, `${type} ${email}`).toBe(409);
        expect(await lowered.json()).toMatchObject({ error: 'already-owner' });
      }
      // T2.5 added changing and removing access: the vault owner is neither an invite nor a member to name.
      for (const method of ['DELETE', 'PATCH']) {
        for (const who of [{ email: ada.email }, { principalId: ada.id }]) {
          expect((await call(method, path, co.cookie, { ...who, role: 'viewer' })).status, `${method} ${path} ${JSON.stringify(who)}`).toBe(404);
        }
      }
      expect((await call('PUT', path, co.cookie, { email: ada.email, role: 'viewer' })).status, `PUT ${path}`).toBe(405);
    }
    const written = await d1.db.prepare(`SELECT
        (SELECT count(*) FROM invites WHERE lower(email) = lower(?1)) AS invites,
        (SELECT count(*) FROM doc_members WHERE principal_id = ?2) + (SELECT count(*) FROM folder_members WHERE principal_id = ?2) AS grants`)
      .bind(ada.email, ada.id).first();
    expect(written, 'nothing names the vault owner as a member').toEqual({ invites: 0, grants: 0 });

    // What a co-owner makes and shares stays in the vault owner's hands.
    const created = await call('POST', '/api/docs', co.cookie, { folderId });
    expect(created.status).toBe(201);
    const { id: newDoc } = ((await created.json()) as { doc: { id: string } }).doc;
    expect((await call('POST', `/api/docs/${newDoc}/members`, co.cookie, { email: ben.email, role: 'owner' })).status).toBe(201);
    const owners = await d1.db.prepare('SELECT owner_user_id AS owner FROM docs WHERE id IN (?1, ?2) UNION SELECT owner_user_id FROM folders WHERE id IN (?3, ?4)')
      .bind(docId, newDoc, folderId, ada.homeId).all();
    expect(owners.results, 'ownership never moves').toEqual([{ owner: ada.id }]);
    for (const docOf of [docId, newDoc]) expect(await roleOf({ cookie: ada.cookie }, docOf), 'Ada still owns it').toBe('owner');
    const list = (await (await call('GET', `/api/docs/${newDoc}/members`, ada.cookie)).json()) as { members: { principalId: string; role: string }[] };
    expect(list.members[0], 'the vault owner heads the list').toEqual(expect.objectContaining({ principalId: ada.id, role: 'owner' }));

    // Even a grant row naming the vault owner at a lower role (none can be written) lowers nothing.
    await insertGrant(d1.db, { docId }, ada, 'viewer');
    expect(await roleOf({ cookie: ada.cookie }, docId)).toBe('owner');
  }, 30_000);

  it('never gives owner access through a share link, even one a row says is an owner link', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId });
    const docLink = await insertLink(d1.db, { docId }, 'owner');
    const folderLink = await insertLink(d1.db, { folderId }, 'owner');
    for (const token of [docLink, folderLink]) {
      expect(await roleOf({ cookie: ben.cookie }, docId, token), 'signed in: editor at most').toBe('editor');
      expect(await roleOf({}, docId, token), 'signed out: viewer').toBe('viewer');
      for (const [path, body] of [[`/api/docs/${docId}/members`, { email: cy.email, role: 'viewer' }], [`/api/docs/${docId}/links`, { role: 'viewer' }]] as const) {
        const response = await handleApi(request('POST', `${path}?share=${token}`, { cookie: ben.cookie }, body), env);
        expect(response.status, `${path} with a link`).toBe(404);
      }
      const moved = await handleApi(request('PATCH', `/api/docs/${docId}?share=${token}`, { cookie: ben.cookie }, { folderId: ada.homeId }), env);
      expect(moved.status, 'a move with a link').toBe(403);
    }
    expect(await roleOf({ cookie: cy.cookie }, docId), 'nothing was shared').toBeNull();
  });

  it("never gives owner access through an agent key: an agent acts at most as an editor", async () => {
    const docId = await insertDoc(d1.db, ada);
    const key = await agentKey(d1.db, ada);
    expect(await roleOf({ authorization: `Bearer ${key}` }, docId), "Ada's agent on Ada's note").toBe('editor');
    expect((await asAgent('POST', `/api/docs/${docId}/members`, key, { email: cy.email, role: 'owner' })).status, 'share').toBe(403);
    expect((await asAgent('POST', `/api/docs/${docId}/links`, key, { role: 'editor' })).status, 'link').toBe(403);
    expect((await asAgent('GET', `/api/docs/${docId}/links`, key)).status, 'list links').toBe(403);
    const membersSeen = await (await asAgent('GET', `/api/docs/${docId}/members`, key)).text();
    expect(membersSeen, 'no emails').not.toContain('@');
    expect((await asAgent('PATCH', `/api/docs/${docId}`, key, { folderId: await insertFolder(d1.db, ada, ada.homeId) })).status, 'move').toBe(403);
    expect(await roleOf({ cookie: cy.cookie }, docId), 'nothing was shared').toBeNull();

    // A grant to an agent at owner, from its own user or anyone, stops at editor too.
    const bens = await insertAgent(d1.db, ben);
    await insertGrant(d1.db, { docId }, { id: bens.id, type: 'agent' }, 'owner');
    await insertGrant(d1.db, { docId }, ben, 'owner');
    expect(await roleOf({ cookie: ben.cookie }, docId), 'Ben co-owns it').toBe('owner');
    expect(await roleOf({ authorization: `Bearer ${bens.key}` }, docId), "Ben's agent").toBe('editor');
    expect((await asAgent('POST', `/api/docs/${docId}/members`, bens.key, { email: cy.email, role: 'viewer' })).status).toBe(403);
  });
});

describe('(c) grant raises are atomic', () => {
  it('settles concurrent shares of one person at every role on the highest, in one invite and one grant', async () => {
    const owner = await signedUpUser(env, 't24s-raises', 'Raises');
    const roles = ['viewer', 'commenter', 'editor', 'owner'];
    for (let round = 0; round < 4; round += 1) {
      const docId = await insertDoc(d1.db, owner);
      // Every order of arrival: rotate which role goes first.
      const order = [...roles.slice(round), ...roles.slice(0, round)];
      const statuses = await Promise.all(order.map((role) =>
        call('POST', `/api/docs/${docId}/members`, owner.cookie, { email: cy.email, role }).then((r) => [role, r.status] as const)));
      expect(new Map(statuses).get('owner'), `round ${round}: the owner share is taken`).toBeLessThan(300);
      for (const [role, status] of statuses) expect([200, 201, 409], `${role} answered ${status}`).toContain(status);
      const rows = await d1.db.prepare(`SELECT
          (SELECT group_concat(role) FROM invites WHERE target_id = ?1 AND accepted_at IS NULL) AS invites,
          (SELECT group_concat(role) FROM doc_members WHERE doc_id = ?1) AS grants`).bind(docId).first();
      expect(rows, `round ${round}`).toEqual({ invites: 'owner', grants: 'owner' });
      expect(await roleOf({ cookie: cy.cookie }, docId)).toBe('owner');
    }
  }, 60_000);

  it('never lowers a member when raises and lowerings of their role land at once', async () => {
    const owner = await signedUpUser(env, 't24s-mixed', 'Mixed');
    for (let round = 0; round < 4; round += 1) {
      const docId = await insertDoc(d1.db, owner);
      expect((await call('POST', `/api/docs/${docId}/members`, owner.cookie, { email: cy.email, role: 'commenter' })).status).toBe(201);
      await roleOf({ cookie: cy.cookie }, docId); // Cy opens it, so the share is no longer pending.
      const statuses = await Promise.all(['viewer', 'editor', 'viewer', 'commenter'].map((role) =>
        call('POST', `/api/docs/${docId}/members`, owner.cookie, { email: cy.email, role }).then((r) => r.status)));
      // A lowering is refused; the repeat at commenter is refused only if the raise landed first.
      expect([statuses[0], statuses[1], statuses[2]], `round ${round}`).toEqual([409, 200, 409]);
      expect([200, 409], `round ${round}`).toContain(statuses[3]);
      const grants = await d1.db.prepare('SELECT role FROM doc_members WHERE doc_id = ?1').bind(docId).all();
      expect(grants.results, `round ${round}`).toEqual([{ role: 'editor' }]);
    }
  }, 60_000);
});
