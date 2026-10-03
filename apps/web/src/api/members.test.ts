// Sharing with a person over REST (T1.1): GET /api/docs/:id says what the caller may do with a doc, the members API
// lets only the owner add a person by email at viewer, commenter or editor and shows emails to the owner alone, a
// folder or vault grant reaches every doc below it, and a missing doc and an inaccessible one get byte-identical
// 404s on every doc route (A§8 non-disclosure).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
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
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never };
  ada = await signedUpUser(env, 'members-ada', 'Ada');
  ben = await signedUpUser(env, 'members-ben', 'Ben');
  cy = await signedUpUser(env, 'members-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  created.length = 0;
});

const call = (method: string, path: string, cookie: string | null, body?: unknown) =>
  handleApi(
    new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
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
  it('lets the owner share with a person by email, who then opens the doc at that role', async () => {
    const docId = await insertDoc(d1.db, ada);
    const response = await share(ada.cookie, docId, { email: `  ${ben.email.toUpperCase()} `, role: 'editor' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ member: { principalId: ben.id, principalType: 'user', name: 'Ben', email: ben.email, role: 'editor' } });
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

  it('offers viewer, commenter and editor only, and refuses anything else with 400', async () => {
    const docId = await insertDoc(d1.db, ada);
    for (const role of ['owner', 'suggester', 'admin', '', null, undefined]) {
      expect((await share(ada.cookie, docId, { email: ben.email, role })).status, `role ${String(role)}`).toBe(400);
    }
    for (const email of ['', 'not-an-email', 42, null]) {
      expect((await share(ada.cookie, docId, { email, role: 'viewer' })).status, `email ${String(email)}`).toBe(400);
    }
    expect(await roleOf(ben.cookie, docId)).toBeNull();
  });

  it('says plainly when no account has the email, or the email is the owner\'s own', async () => {
    const docId = await insertDoc(d1.db, ada);
    const unknown = await share(ada.cookie, docId, { email: 'nobody-here@example.invalid', role: 'viewer' });
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ error: 'no-account', message: expect.stringMatching(/\S/) });
    const self = await share(ada.cookie, docId, { email: ada.email, role: 'viewer' });
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ error: 'already-owner' });
  });

  it('keeps a repeat share idempotent, raises a role, and refuses to lower one until live revocation lands (M2)', async () => {
    const docId = await insertDoc(d1.db, ada);
    expect((await share(ada.cookie, docId, { email: ben.email, role: 'commenter' })).status).toBe(201);
    expect((await share(ada.cookie, docId, { email: ben.email, role: 'commenter' })).status).toBe(200);
    expect((await share(ada.cookie, docId, { email: ben.email, role: 'editor' })).status).toBe(200);
    expect(await roleOf(ben.cookie, docId)).toBe('editor');
    const lower = await share(ada.cookie, docId, { email: ben.email, role: 'viewer' });
    expect(lower.status).toBe(409);
    expect(await lower.json()).toMatchObject({ error: 'demotion-unavailable', message: expect.stringMatching(/\S/) });
    expect(await roleOf(ben.cookie, docId)).toBe('editor');
  });
});

describe('GET /api/docs/:id/members', () => {
  it('lists the owner first, then members; the owner sees emails and a member sees none', async () => {
    const docId = await insertDoc(d1.db, ada);
    await share(ada.cookie, docId, { email: ben.email, role: 'editor' });
    await share(ada.cookie, docId, { email: cy.email, role: 'viewer' });
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

describe('folder and vault grants', () => {
  it("lets the vault's owner share it; the grant reaches its docs, and only an editor creates in it", async () => {
    const docId = await insertDoc(d1.db, ada);
    expect((await shareFolder(ada.cookie, ada.homeId, { email: ben.email, role: 'viewer' })).status).toBe(201);
    expect((await shareFolder(ada.cookie, ada.homeId, { email: cy.email, role: 'editor' })).status).toBe(201);
    expect(await roleOf(ben.cookie, docId)).toBe('viewer');
    expect((await shareFolder(ben.cookie, ada.homeId, { email: cy.email, role: 'viewer' })).status, 'a member shares nothing').toBe(403);
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
