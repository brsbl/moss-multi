// Doc-socket admission (A§4.1 step 6): the verdict the Worker closes with after the upgrade, and the trusted
// headers it forwards, with the role the one resolver gives (A§8: ownership, grants, links as a ceiling).
// A browser always sends Origin on an upgrade, so requests carry the app's unless a test says otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSE, decodePartyPrincipal, TRUSTED } from '@moss-multi/protocol/sync';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import {
  agentKey, BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser,
} from '../test/principals.ts';
import { authenticateParty } from './party.ts';

let d1: TestD1;
let env: AuthTestEnv;
let ada: TestUser;
let ben: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE };
  ada = await signedUpUser(env, 'party-ada', 'Adá');
  ben = await signedUpUser(env, 'party-ben', 'Ben');
}, 60_000);
afterAll(() => d1?.dispose());

/** An upgrade with the app's Origin; a header set to undefined is left out. */
const upgrade = (docId: string, headers: Record<string, string | undefined> = {}, query = '') =>
  new Request(`${BASE}/parties/doc-d-o/${docId}${query}`, {
    headers: Object.entries({ upgrade: 'websocket', origin: BASE, ...headers }).filter((h): h is [string, string] => h[1] !== undefined),
  });

/** Same-site pages the cookie still rides to: another port on the app's host, and a sibling subdomain. */
const FOREIGN = ['http://127.0.0.1:8851', 'https://evil.example', 'null'];

describe('authenticateParty', () => {
  it("admits the owner as owner, with the principal and session the DO trusts", async () => {
    const docId = await insertDoc(d1.db, ada);
    const verdict = await authenticateParty(upgrade(docId, { cookie: ada.cookie }), docId, env);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(decodePartyPrincipal(verdict.headers[TRUSTED.principal])).toEqual({ id: ada.id, kind: 'user', name: 'Adá' });
    expect(verdict.headers[TRUSTED.role]).toBe('owner');
    expect(verdict.headers[TRUSTED.session]).toMatch(/\S/);
    expect(Object.values(verdict.headers).every((value) => /^[\x20-\x7e]*$/.test(value)), 'header values are ASCII').toBe(true);
  });

  it('closes 4404 for a doc that does not exist and for one the caller cannot open, alike', async () => {
    const docId = await insertDoc(d1.db, ada);
    expect(await authenticateParty(upgrade(docId, { cookie: ben.cookie }), docId, env)).toEqual({ ok: false, code: CLOSE.unavailable });
    const missing = crypto.randomUUID();
    expect(await authenticateParty(upgrade(missing, { cookie: ada.cookie }), missing, env)).toEqual({ ok: false, code: CLOSE.unavailable });
    expect(await authenticateParty(upgrade(docId, {}, '?share=forged-token'), docId, env)).toEqual({ ok: false, code: CLOSE.unavailable });
  });

  it('closes 4401 with no credential', async () => {
    const docId = await insertDoc(d1.db, ada);
    expect(await authenticateParty(upgrade(docId), docId, env)).toEqual({ ok: false, code: CLOSE.noPrincipal });
  });

  it('closes 4410 for a trashed doc its owner could open, and 4404 for anyone else', async () => {
    const docId = await insertDoc(d1.db, ada, { deleted: true });
    expect(await authenticateParty(upgrade(docId, { cookie: ada.cookie }), docId, env)).toEqual({ ok: false, code: CLOSE.deleted });
    expect(await authenticateParty(upgrade(docId, { cookie: ben.cookie }), docId, env)).toEqual({ ok: false, code: CLOSE.unavailable });
  });

  it('admits a person the doc or its vault is shared with at the granted role, which the DO enforces', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'editor');
    const verdict = await authenticateParty(upgrade(docId, { cookie: ben.cookie }), docId, env);
    expect(verdict.ok && decodePartyPrincipal(verdict.headers[TRUSTED.principal])?.id).toBe(ben.id);
    expect(verdict.ok && verdict.headers[TRUSTED.role]).toBe('editor');

    const viewed = await insertDoc(d1.db, ben);
    await insertGrant(d1.db, { folderId: ben.homeId }, ada, 'viewer');
    const viewer = await authenticateParty(upgrade(viewed, { cookie: ada.cookie }), viewed, env);
    expect(viewer.ok && viewer.headers[TRUSTED.role], 'a vault grant at viewer').toBe('viewer');
  });

  it('admits a live link at its ceiling: viewer with the token alone, the link role signed in', async () => {
    const docId = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId }, 'editor');
    const alone = await authenticateParty(upgrade(docId, {}, `?share=${token}`), docId, env);
    expect(alone.ok && decodePartyPrincipal(alone.headers[TRUSTED.principal])?.kind).toBe('anonymous');
    expect(alone.ok && alone.headers[TRUSTED.role]).toBe('viewer');
    expect(alone.ok && alone.headers[TRUSTED.share]).toBe(token);
    expect(alone.ok && alone.headers[TRUSTED.presence]).toBe('0');
    const signedIn = await authenticateParty(upgrade(docId, { cookie: ben.cookie }, `?share=${token}`), docId, env);
    expect(signedIn.ok && signedIn.headers[TRUSTED.role]).toBe('editor');
    expect(signedIn.ok && signedIn.headers[TRUSTED.presence]).toBe('0');
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    const granted = await authenticateParty(upgrade(docId, { cookie: ben.cookie }, `?share=${token}`), docId, env);
    expect(granted.ok && granted.headers[TRUSTED.presence]).toBe('1');
    const revoked = await insertLink(d1.db, { docId }, 'editor', { revoked: true });
    expect(await authenticateParty(upgrade(docId, {}, `?share=${revoked}`), docId, env)).toEqual({ ok: false, code: CLOSE.unavailable });
  });
});

describe('the origin gate (A§18)', () => {
  const ownerOf = (verdict: Awaited<ReturnType<typeof authenticateParty>>) =>
    verdict.ok ? { id: decodePartyPrincipal(verdict.headers[TRUSTED.principal])?.id, role: verdict.headers[TRUSTED.role] } : verdict;

  it('closes 4401 for a cookie from another origin or with no Origin, whether or not the doc exists', async () => {
    const docId = await insertDoc(d1.db, ada);
    const missing = crypto.randomUUID();
    for (const origin of [...FOREIGN, undefined]) {
      expect(await authenticateParty(upgrade(docId, { cookie: ada.cookie, origin }), docId, env), `Origin ${origin}`).toEqual({ ok: false, code: CLOSE.noPrincipal });
      expect(await authenticateParty(upgrade(missing, { cookie: ada.cookie, origin }), missing, env), `Origin ${origin}, no doc`).toEqual({ ok: false, code: CLOSE.noPrincipal });
    }
  });

  it("admits a cookie from the app's origin", async () => {
    const docId = await insertDoc(d1.db, ada);
    expect(ownerOf(await authenticateParty(upgrade(docId, { cookie: ada.cookie }), docId, env))).toEqual({ id: ada.id, role: 'owner' });
  });

  it('admits a session bearer and an agent key from anywhere: neither rides along on its own', async () => {
    const docId = await insertDoc(d1.db, ada);
    const key = await agentKey(d1.db, ada);
    for (const origin of [undefined, ...FOREIGN]) {
      const bearer = await authenticateParty(upgrade(docId, { authorization: `Bearer ${ada.token}`, origin }), docId, env);
      expect(ownerOf(bearer), `session bearer, Origin ${origin}`).toEqual({ id: ada.id, role: 'owner' });
      const agent = await authenticateParty(upgrade(docId, { authorization: `Bearer ${key}`, origin }), docId, env);
      expect(agent.ok && agent.headers[TRUSTED.role], `agent key, Origin ${origin}: an agent acts at most as an editor`).toBe('editor');
    }
  });

  it('judges a cookie and a bearer by the bearer, and never falls back to the cookie', async () => {
    const docId = await insertDoc(d1.db, ben);
    const both = await authenticateParty(upgrade(docId, { cookie: ada.cookie, authorization: `Bearer ${ben.token}`, origin: FOREIGN[0] }), docId, env);
    expect(ownerOf(both)).toEqual({ id: ben.id, role: 'owner' });
    const adas = await insertDoc(d1.db, ada);
    for (const forged of ['forged.signature', 'forged']) {
      const verdict = await authenticateParty(upgrade(adas, { cookie: ada.cookie, authorization: `Bearer ${forged}`, origin: undefined }), adas, env);
      expect(verdict, `a failed bearer "${forged}" beside Ada's cookie`).toEqual({ ok: false, code: CLOSE.noPrincipal });
    }
  });

  it('lets a share token alone through: its verdict is the same from any origin', async () => {
    const docId = await insertDoc(d1.db, ada);
    const fromApp = await authenticateParty(upgrade(docId, {}, '?share=link-token'), docId, env);
    for (const origin of [...FOREIGN, undefined]) {
      expect(await authenticateParty(upgrade(docId, { origin }, '?share=link-token'), docId, env), `Origin ${origin}`).toEqual(fromApp);
    }
    // No link has this token, so it opens nothing; the gate never turns it into 4401.
    expect(fromApp).toEqual({ ok: false, code: CLOSE.unavailable });
  });
});

describe('opening a shared note', () => {
  it("redeems the grantee's pending email share on the note or a folder above it, and nobody else's", async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId });
    const other = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { folderId }, ben, 'viewer');
    const invite = (token: string, type: string, id: string) => d1.db.prepare(`INSERT INTO invites (token, email, target_type, target_id, role, invited_by, created_at)
      VALUES (?, ?, ?, ?, 'viewer', ?, ?)`).bind(token, ben.email, type, id, ada.id, Date.now()).run();
    await invite('t-folder', 'folder', folderId);
    await invite('t-other', 'doc', other);
    const accepted = async (token: string) => (await d1.db.prepare('SELECT accepted_by FROM invites WHERE token = ?').bind(token).first<{ accepted_by: string | null }>())?.accepted_by;
    expect((await authenticateParty(upgrade(docId, { cookie: ada.cookie }), docId, env)).ok).toBe(true);
    expect(await accepted('t-folder'), 'the owner opening it redeems nothing').toBeNull();
    expect((await authenticateParty(upgrade(docId, { cookie: ben.cookie }), docId, env)).ok).toBe(true);
    expect(await accepted('t-folder')).toBe(ben.id);
    expect(await accepted('t-other'), 'a share Ben has not opened, and holds no grant for, waits').toBeNull();
  });
});
