// Doc-socket admission (A§4.1 step 6): the verdict the Worker closes with after the upgrade, and the trusted
// headers it forwards. M0 knows owners only; grants and links arrive with the resolver's later rows (T1.1, M2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSE, decodePartyPrincipal, TRUSTED } from '@moss-multi/protocol/sync';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
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

const upgrade = (docId: string, headers: Record<string, string> = {}, query = '') =>
  new Request(`${BASE}/parties/doc-d-o/${docId}${query}`, { headers: { upgrade: 'websocket', ...headers } });

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
});
