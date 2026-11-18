// Sharing with a person over REST (T1.1): GET /api/docs/:id says what the caller may do with a doc, the members API
// lets only the owner add a person by email at viewer, commenter or editor and shows emails to the owner alone, a
// folder or vault grant reaches every doc below it, and a missing doc and an inaccessible one get byte-identical
// 404s on every doc route (A§8 non-disclosure).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countingBinds, D1_MAX_PARAMS, migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser, unmeteredPrincipals } from '../test/principals.ts';
import { redeem } from '../test/invites.ts';
import { handleApi } from './router.ts';

const created: string[] = [];

/** A DocDO namespace: getServerByName's setName, then the RPCs these routes call. */
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    create: async () => {
      created.push(id.name);
    },
    probeInstance: async () => ({ instanceId: `instance-${id.name}`, constructedAt: 1 }),
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: unmeteredPrincipals as never };
  ada = await signedUpUser(env, 'members-ada', 'Ada');
  ben = await signedUpUser(env, 'members-ben', 'Ben');
  cy = await signedUpUser(env, 'members-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  created.length = 0;
});

const call = (method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  handleApi(
    new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );

const share = (cookie: string | null, docId: string, body: unknown) => call('POST', `/api/docs/${docId}/members`, cookie, body);
const shareFolder = (cookie: string | null, folderId: string, body: unknown) => call('POST', `/api/folders/${folderId}/members`, cookie, body);

interface Member { principalId: string; principalType: string; name: string; email?: string; role: string }

async function members(cookie: string, path: string): Promise<Member[]> {
  const response = await call('GET', path, cookie);
  expect(response.status, `GET ${path}`).toBe(200);
  return ((await response.json()) as { members: Member[] }).members;
}

async function roleOf(cookie: string, docId: string): Promise<string | null> {
  const response = await call('GET', `/api/docs/${docId}`, cookie);
  return response.status === 200 ? ((await response.json()) as { role: string }).role : null;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a client can tell two responses apart by: status, the headers that vary, and the body's digest. */
async function fingerprint(response: Response) {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    sha256: await sha256(await response.arrayBuffer()),
  };
}

describe('GET /api/docs/:id', () => {
  it("answers the owner with the doc and the owner's role", async () => {
    const docId = await insertDoc(d1.db, ada);
    const response = await call('GET', `/api/docs/${docId}`, ada.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { doc: Record<string, unknown>; role: string };
    expect(body.role).toBe('owner');
    expect(body.doc).toMatchObject({ id: docId, folderId: ada.homeId, title: '' });
  });

  it('answers a member at their role, and gets 401 with no credential', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    expect(await roleOf(ben.cookie, docId)).toBe('viewer');
    expect((await call('GET', `/api/docs/${docId}`, null)).status).toBe(401);
  });
});

describe('POST /api/docs/:id/members', () => {
  it('lets the owner share with a person by email, who then redeems the invite and opens the doc at that role', async () => {
    const docId = await insertDoc(d1.db, ada);
    const response = await share(ada.cookie, docId, { email: `  ${ben.email.toUpperCase()} `, role: 'editor' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ shared: { email: ben.email, role: 'editor' } });
    expect(await roleOf(ben.cookie, docId), 'nothing before redeeming (T2.8)').toBeNull();
    await redeem(env, ada, `/api/docs/${docId}`, ben);
    expect(await roleOf(ben.cookie, docId)).toBe('editor');
    expect(await roleOf(cy.cookie, docId), 'nobody else').toBeNull();
    const rows = await d1.db.prepare('SELECT principal_id, principal_type, role, added_by FROM doc_members WHERE doc_id = ?').bind(docId).all();
    expect(rows.results).toEqual([{ principal_id: ben.id, principal_type: 'user', role: 'editor', added_by: ada.id }]);
  });

  it('refuses a member who is not the owner (403) and a stranger (404), and writes nothing', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'editor');
    const byMember = await share(ben.cookie, docId, { email: cy.email, role: 'viewer' });
    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toMatchObject({ error: 'forbidden' });
    expect((await share(cy.cookie, docId, { email: cy.email, role: 'editor' })).status).toBe(404);
    expect((await share(null, docId, { email: cy.email, role: 'editor' })).status).toBe(401);
    expect(await roleOf(cy.cookie, docId)).toBeNull();
  });

  it('offers viewer, commenter, editor and owner only, and refuses anything else with 400', async () => {
    const docId = await insertDoc(d1.db, ada);
    for (const role of ['suggester', 'admin', '', null, undefined]) {
      expect((await share(ada.cookie, docId, { email: ben.email, role })).status, `role ${String(role)}`).toBe(400);
    }
    for (const email of ['', 'not-an-email', 42, null]) {
      expect((await share(ada.cookie, docId, { email, role: 'viewer' })).status, `email ${String(email)}`).toBe(400);
    }
    expect(await roleOf(ben.cookie, docId)).toBeNull();
  });

  it('answers an email with no account exactly as one with an account, and refuses the owner\'s own email', async () => {
    const docId = await insertDoc(d1.db, ada);
    const known = await share(ada.cookie, docId, { email: ben.email, role: 'viewer' });
    const unknown = await share(ada.cookie, docId, { email: 'Nobody-Here@example.invalid', role: 'viewer' });
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual({ shared: { email: 'nobody-here@example.invalid', role: 'viewer' } });
    expect(await known.json()).toEqual({ shared: { email: ben.email, role: 'viewer' } });
    const self = await share(ada.cookie, docId, { email: ada.email, role: 'viewer' });
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ error: 'already-owner' });
  });

  it('keeps a repeat share idempotent, raises a role, and refuses to lower one until live revocation lands (M2)', async () => {
    const docId = await insertDoc(d1.db, ada);
    expect((await share(ada.cookie, docId, { email: ben.email, role: 'commenter' })).status).toBe(201);
    expect((await share(ada.cookie, docId, { email: ben.email, role: 'commenter' })).status).toBe(200);
    expect((await share(ada.cookie, docId, { email: ben.email, role: 'editor' })).status).toBe(200);
    await redeem(env, ada, `/api/docs/${docId}`, ben);
    expect(await roleOf(ben.cookie, docId)).toBe('editor');
    // Redeemed, the email is a label again: a lower share is a new invite, and redeeming it lowers nothing.
    expect((await share(ada.cookie, docId, { email: ben.email, role: 'viewer' })).status).toBe(201);
    const lower = await share(ada.cookie, docId, { email: ben.email, role: 'commenter' });
    expect(lower.status, 'a raise of the open invite').toBe(200);
    const below = await share(ada.cookie, docId, { email: ben.email, role: 'viewer' });
    expect(below.status, 'a lowering of an open invite').toBe(409);
    expect(await below.json()).toMatchObject({ error: 'demotion-unavailable', message: expect.stringMatching(/\S/) });
    await redeem(env, ada, `/api/docs/${docId}`, ben);
    expect(await roleOf(ben.cookie, docId)).toBe('editor');
  });
});

describe('GET /api/docs/:id/members', () => {
  it('lists the owner first, then members; the owner sees emails and a member sees none', async () => {
    const docId = await insertDoc(d1.db, ada);
    await share(ada.cookie, docId, { email: ben.email, role: 'editor' });
    await share(ada.cookie, docId, { email: cy.email, role: 'viewer' });
    // A person shared with by email is listed by name once they redeem the invite (T2.8).
    await redeem(env, ada, `/api/docs/${docId}`, ben);
    await redeem(env, ada, `/api/docs/${docId}`, cy);
    expect([await roleOf(ben.cookie, docId), await roleOf(cy.cookie, docId)]).toEqual(['editor', 'viewer']);
    expect(await members(ada.cookie, `/api/docs/${docId}/members`)).toEqual([
      { principalId: ada.id, principalType: 'user', name: 'Ada', email: ada.email, role: 'owner' },
      { principalId: ben.id, principalType: 'user', name: 'Ben', email: ben.email, role: 'editor' },
      { principalId: cy.id, principalType: 'user', name: 'Cy', email: cy.email, role: 'viewer' },
    ]);
    const asMember = await call('GET', `/api/docs/${docId}/members`, ben.cookie);
    expect(asMember.status).toBe(200);
    const text = await asMember.text();
    expect(text, 'no email reaches a non-owner').not.toContain('@');
    expect((JSON.parse(text) as { members: Member[] }).members.map((m) => [m.name, m.role])).toEqual([['Ada', 'owner'], ['Ben', 'editor'], ['Cy', 'viewer']]);
  });

  it('lists 150 people and 150 agents in grant order', async () => {
    const docId = await insertDoc(d1.db, ada);
    const now = Date.now();
    const expected: [string, string][] = [[ada.id, 'owner']];
    for (let i = 0; i < 150; i++) {
      const id = crypto.randomUUID();
      await d1.db.prepare('INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, `P${i}`, `many-${id}@example.invalid`, now, now).run();
      await insertGrant(d1.db, { docId }, { id }, 'viewer');
      expected.push([id, 'viewer']);
      const agent = await insertAgent(d1.db, ada);
      await insertGrant(d1.db, { docId }, { id: agent.id, type: 'agent' }, 'editor');
      expected.push([agent.id, 'editor']);
    }
    expect((await members(ada.cookie, `/api/docs/${docId}/members`)).map((m) => [m.principalId, m.role])).toEqual(expected);
    const counted = countingBinds(d1.db);
    const response = await handleApi(new Request(`${BASE}/api/docs/${docId}/members`, { headers: { cookie: ada.cookie } }), { ...env, DB: counted.db });
    expect(response.status).toBe(200);
    expect(Math.max(...counted.binds), 'bound parameters per statement').toBeLessThanOrEqual(D1_MAX_PARAMS);
  }, 120_000);
});

describe('anonymous member-list privacy', () => {
  it.each(['doc', 'folder'] as const)('discloses no %s members to link-only visitors, while signed-in readers keep names without emails', async (kind) => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId });
    const target = kind === 'doc' ? { docId } : { folderId };
    const path = kind === 'doc' ? `/api/docs/${docId}/members` : `/api/folders/${folderId}/members`;
    await insertGrant(d1.db, target, ben, 'viewer');
    const token = await insertLink(d1.db, target, 'editor');
    const anonymous = await call('GET', `${path}?share=${token}`, null);
    expect(anonymous.status).toBe(404);
    expect(await anonymous.json()).toEqual({ error: 'not-found' });
    const reader = await members(ben.cookie, path);
    expect(reader.map(({ name }) => name)).toEqual(['Ada', 'Ben']);
    expect(reader.every((member) => member.email === undefined)).toBe(true);
    // The token is live and grants document access, even though identities stay private.
    expect((await call('GET', `/api/docs/${docId}?share=${token}`, null)).status).toBe(200);
  });
});

describe.each(['query', 'header'] as const)('signed-in link-only member privacy (%s token)', (transport) => {
  it.each([
    ['doc', 'doc'],
    ['folder', 'doc'],
    ['folder', 'folder'],
  ] as const)('a viewer %s link cannot disclose %s members', async (linkKind, memberKind) => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId });
    const target = memberKind === 'doc' ? { docId } : { folderId };
    await insertGrant(d1.db, target, ben, 'viewer');
    const token = await insertLink(d1.db, linkKind === 'doc' ? { docId } : { folderId }, 'viewer');
    const path = memberKind === 'doc' ? `/api/docs/${docId}/members` : `/api/folders/${folderId}/members`;
    const withLink = (method: string, url: string, cookie: string | null, body?: unknown) =>
      call(method, `${url}${transport === 'query' ? `?share=${token}` : ''}`, cookie, body,
        transport === 'header' ? { 'x-moss-share': token } : {});

    // The credential really grants content access to the signed-in stranger.
    expect((await withLink('GET', `/api/docs/${docId}`, cy.cookie)).status).toBe(200);
    const denied = await withLink('GET', path, cy.cookie);
    expect(denied.status).toBe(404);
    const missing = path.replace(memberKind === 'doc' ? docId : folderId, crypto.randomUUID());
    expect(await fingerprint(denied)).toEqual(await fingerprint(await withLink('GET', missing, cy.cookie)));
    expect(await fingerprint(await withLink('GET', path, null))).toEqual(await fingerprint(await call('GET', path, cy.cookie)));

    const reader = await withLink('GET', path, ben.cookie);
    expect(reader.status).toBe(200);
    expect(await reader.json()).toEqual({ members: [
      { principalId: ada.id, principalType: 'user', name: 'Ada', role: 'owner' },
      { principalId: ben.id, principalType: 'user', name: 'Ben', role: 'viewer' },
    ] });
    const owner = await withLink('GET', path, ada.cookie);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ members: [
      { principalId: ada.id, principalType: 'user', name: 'Ada', email: ada.email, role: 'owner' },
      { principalId: ben.id, principalType: 'user', name: 'Ben', email: ben.email, role: 'viewer' },
    ], invites: [] });
    const grant = { email: cy.email, role: 'editor' };
    expect((await withLink('POST', path, cy.cookie, grant)).status).toBe(404);
    expect((await withLink('POST', path, ben.cookie, grant)).status).toBe(403);
    expect((await call('GET', path, cy.cookie)).status).toBe(404);
  });
});

describe('folder and vault grants', () => {
  it("lets the vault's owner share it; the grant reaches its docs, and only an editor creates in it", async () => {
    const docId = await insertDoc(d1.db, ada);
    expect((await shareFolder(ada.cookie, ada.homeId, { email: ben.email, role: 'viewer' })).status).toBe(201);
    expect((await shareFolder(ada.cookie, ada.homeId, { email: cy.email, role: 'editor' })).status).toBe(201);
    await redeem(env, ada, `/api/folders/${ada.homeId}`, ben);
    await redeem(env, ada, `/api/folders/${ada.homeId}`, cy);
    expect(await roleOf(ben.cookie, docId)).toBe('viewer');
    expect((await shareFolder(ben.cookie, ada.homeId, { email: cy.email, role: 'viewer' })).status, 'a member shares nothing').toBe(403);
    expect(await roleOf(cy.cookie, docId)).toBe('editor');
    expect((await members(ada.cookie, `/api/folders/${ada.homeId}/members`)).map((m) => [m.name, m.role])).toEqual([['Ada', 'owner'], ['Ben', 'viewer'], ['Cy', 'editor']]);

    // A viewer's write over REST: a note in the vault is refused and nothing is written.
    const byViewer = await call('POST', '/api/docs', ben.cookie, { folderId: ada.homeId });
    expect(byViewer.status).toBe(403);
    expect(created).toEqual([]);
    const byEditor = await call('POST', '/api/docs', cy.cookie, { folderId: ada.homeId });
    expect(byEditor.status).toBe(201);
    const { doc } = (await byEditor.json()) as { doc: { id: string } };
    const row = await d1.db.prepare('SELECT owner_user_id, created_by FROM docs WHERE id = ?').bind(doc.id).first();
    expect(row, "the vault's owner owns it; the editor created it").toEqual({ owner_user_id: ada.id, created_by: cy.id });
    expect(created).toEqual([doc.id]);
  });
});

describe('non-disclosure: a missing doc and an inaccessible one answer alike', () => {
  it('gives byte-identical 404s on every doc route, the owner a 200, and wakes no DocDO', async () => {
    // Someone with no grant anywhere: Cy holds a grant on Ada's Home vault by now.
    const dee = await signedUpUser(env, 'members-dee', 'Dee');
    const docId = await insertDoc(d1.db, ada);
    const trashed = await insertDoc(d1.db, ada, { deleted: true });
    const missing = crypto.randomUUID();
    const routes: [string, string, unknown?][] = [
      ['GET', ''],
      ['GET', '/members'],
      ['POST', '/members', { email: cy.email, role: 'viewer' }],
      ['GET', '/instance'],
    ];
    for (const [method, suffix, body] of routes) {
      const denied = await fingerprint(await call(method, `/api/docs/${docId}${suffix}`, dee.cookie, body));
      const absent = await fingerprint(await call(method, `/api/docs/${missing}${suffix}`, dee.cookie, body));
      const gone = await fingerprint(await call(method, `/api/docs/${trashed}${suffix}`, dee.cookie, body));
      expect(denied.status, `${method} ${suffix || '/'}`).toBe(404);
      expect(denied, `${method} ${suffix || '/'}: inaccessible vs missing`).toEqual(absent);
      expect(gone, `${method} ${suffix || '/'}: someone else's trashed doc vs missing`).toEqual(absent);
    }
    // The positive control: the same routes answer the owner.
    expect((await call('GET', `/api/docs/${docId}`, ada.cookie)).status).toBe(200);
    expect((await call('GET', `/api/docs/${docId}/members`, ada.cookie)).status).toBe(200);
    expect(await roleOf(dee.cookie, docId)).toBeNull();
    expect(created).toEqual([]);
  });
});

describe('the mention roster: GET /api/docs/:id/members?scope=effective @p:ppl-3', () => {
  /** A person with an account and no access anywhere yet. */
  const person = async (name: string) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    await d1.db.prepare('INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, `mm-t4b1-${name}-${id}@example.invalid`, now, now).run();
    return id;
  };
  const roster = async (cookie: string, docId: string) =>
    (await members(cookie, `/api/docs/${docId}/members?scope=effective`)).map((m) => [m.principalId, m.role]);

  it('unions the owner, direct grants and every ancestor folder grant, each person once; a move out of a folder drops its grants', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const folder = await insertFolder(d1.db, ada, vault);
    const elsewhere = await insertFolder(d1.db, ada, vault);
    const docId = await insertDoc(d1.db, ada, { folderId: folder });
    const [direct, inFolder, inVault, everywhere] = [await person('Direct'), await person('Folder'), await person('Vault'), await person('Many')];
    await insertGrant(d1.db, { docId }, { id: direct }, 'commenter');
    await insertGrant(d1.db, { docId }, { id: everywhere }, 'viewer');
    await insertGrant(d1.db, { folderId: folder }, { id: inFolder }, 'viewer');
    await insertGrant(d1.db, { folderId: folder }, { id: everywhere }, 'editor');
    await insertGrant(d1.db, { folderId: vault }, { id: inVault }, 'commenter');
    await insertGrant(d1.db, { folderId: vault }, { id: everywhere }, 'viewer');
    await insertGrant(d1.db, { docId }, { id: ben.id }, 'viewer');
    expect(await roster(ben.cookie, docId)).toEqual([
      [ada.id, 'owner'], [direct, 'commenter'], [everywhere, 'editor'], [ben.id, 'viewer'], [inFolder, 'viewer'], [inVault, 'commenter'],
    ]);
    expect((await members(ben.cookie, `/api/docs/${docId}/members`)).map((m) => m.principalId), 'the direct-grant list is unchanged')
      .toEqual([ada.id, direct, everywhere, ben.id]);
    await d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(elsewhere, docId).run();
    expect(await roster(ben.cookie, docId)).toEqual([
      [ada.id, 'owner'], [direct, 'commenter'], [everywhere, 'viewer'], [ben.id, 'viewer'], [inVault, 'commenter'],
    ]);
  });

  it('a link-only reader, signed in or not, gets nothing', async () => {
    const vault = await insertFolder(d1.db, ada, null);
    const docId = await insertDoc(d1.db, ada, { folderId: vault });
    await insertGrant(d1.db, { docId }, { id: ben.id }, 'viewer');
    const token = await insertLink(d1.db, { docId }, 'commenter');
    expect((await call('GET', `/api/docs/${docId}?share=${token}`, cy.cookie)).status, 'the link opens the note').toBe(200);
    for (const cookie of [cy.cookie, null]) {
      const response = await call('GET', `/api/docs/${docId}/members?scope=effective`, cookie, undefined, { 'x-moss-share': token });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(ben.id);
    }
  });
});
