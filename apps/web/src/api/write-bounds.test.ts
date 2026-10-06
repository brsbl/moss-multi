// Routes that add rows per call are bounded per day (T3.S3b; A§18): folders and vaults per vault owner, agent keys per
// person, share links per target and feedback per person each refuse with 429 past their bound and write nothing.
// Notes are create-budget.harness.test.ts; invites (20 an hour per inviter) are invites.test.ts; media are
// media-admission.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_KEY_DAILY, FEEDBACK_DAILY, FOLDER_CREATE_DAILY, SHARE_LINK_DAILY } from '@moss-multi/protocol/limits';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, SECRET, signedUpUser, unmeteredPrincipals, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined, recheck: async () => ({ closed: 0 }) }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: unmeteredPrincipals as never };
}, 60_000);
afterAll(() => d1?.dispose());

const call = (user: TestUser, method: string, path: string, body: unknown) => handleApi(new Request(`${BASE}${path}`, {
  method, headers: { 'content-type': 'application/json', origin: BASE, cookie: user.cookie }, body: JSON.stringify(body),
}), env);

const count = async (sql: string, ...binds: unknown[]) => (await d1.db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;

/** Runs `sql` over `n(i)` for i from 1 to the first bind, so one statement writes that many numbered rows. */
const rowsToday = (sql: string, ...binds: unknown[]) => d1.db.prepare(`WITH RECURSIVE n(i) AS (
    SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1) ${sql}`).bind(...binds).run();

async function expectBounded(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(429);
  expect(((await response.json()) as { error: string }).error).toBe('rate-limited');
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
}

describe('daily write bounds', () => {
  it('folders and vaults: one owner’s vaults take FOLDER_CREATE_DAILY a day, whoever creates them', async () => {
    const ada = await signedUpUser(env, 'bounds-folders', 'Ada');
    // The Home vault counts; yesterday's folders don't.
    await rowsToday(`INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at)
      SELECT ?2 || i, ?3, ?3, 'old ' || i, 'folder', ?4, ?5 FROM n`, 5, `old-${ada.id}-`, ada.id, ada.homeId, Date.now() - 25 * 60 * 60 * 1000);
    await rowsToday(`INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at)
      SELECT ?2 || i, ?3, ?3, 'f ' || i, 'folder', ?4, ?5 FROM n`, FOLDER_CREATE_DAILY - 2, `f-${ada.id}-`, ada.id, ada.homeId, Date.now());
    expect((await call(ada, 'POST', '/api/folders', { parentId: ada.homeId, name: 'The last one' })).status).toBe(201);
    const before = await count('SELECT COUNT(*) AS n FROM folders WHERE owner_user_id = ?1', ada.id);
    await expectBounded(await call(ada, 'POST', '/api/folders', { parentId: ada.homeId, name: 'One too many' }));
    await expectBounded(await call(ada, 'POST', '/api/vaults', { name: 'Another vault' }));
    expect(await count('SELECT COUNT(*) AS n FROM folders WHERE owner_user_id = ?1', ada.id)).toBe(before);
  }, 60_000);

  it('agent keys: a person mints AGENT_KEY_DAILY a day, revoked ones included', async () => {
    const ben = await signedUpUser(env, 'bounds-agents', 'Ben');
    await rowsToday(`INSERT INTO agents (id, owner_user_id, name, key_hash, created_at, revoked_at)
      SELECT ?2 || i, ?3, 'Scribe', ?2 || i, ?4, ?4 FROM n`, AGENT_KEY_DAILY - 1, `agent-${ben.id}-`, ben.id, Date.now());
    expect((await call(ben, 'POST', '/api/agents', { name: 'Last' })).status).toBe(201);
    await expectBounded(await call(ben, 'POST', '/api/agents', { name: 'One too many' }));
    expect(await count('SELECT COUNT(*) AS n FROM agents WHERE owner_user_id = ?1', ben.id)).toBe(AGENT_KEY_DAILY);
  }, 60_000);

  it('share links: one target takes SHARE_LINK_DAILY a day, revoked ones included', async () => {
    const cy = await signedUpUser(env, 'bounds-links', 'Cy');
    const docId = await insertDoc(d1.db, cy);
    await rowsToday(`INSERT INTO share_links (token, target_type, target_id, role, created_by, created_at, revoked_at)
      SELECT ?2 || i, 'doc', ?3, 'viewer', ?4, ?5, ?5 FROM n`, SHARE_LINK_DAILY - 1, `link-${docId}-`, docId, cy.id, Date.now());
    expect((await call(cy, 'POST', `/api/docs/${docId}/links`, { role: 'viewer' })).status).toBe(201);
    await expectBounded(await call(cy, 'POST', `/api/docs/${docId}/links`, { role: 'editor' }));
    expect(await count("SELECT COUNT(*) AS n FROM share_links WHERE target_type = 'doc' AND target_id = ?1", docId)).toBe(SHARE_LINK_DAILY);
  }, 60_000);

  it('feedback: a person sends FEEDBACK_DAILY a day', async () => {
    const dee = await signedUpUser(env, 'bounds-feedback', 'Dee');
    await rowsToday(`INSERT INTO feedback (id, user_id, body, page, created_at) SELECT ?2 || i, ?3, 'hi', NULL, ?4 FROM n`,
      FEEDBACK_DAILY - 1, `fb-${dee.id}-`, dee.id, Date.now());
    expect((await call(dee, 'POST', '/api/feedback', { body: 'The last one' })).status).toBe(201);
    await expectBounded(await call(dee, 'POST', '/api/feedback', { body: 'One too many' }));
    expect(await count('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?1', dee.id)).toBe(FEEDBACK_DAILY);
  }, 60_000);
});
