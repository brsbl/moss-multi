// Routes that add rows per call are bounded per day (T3.S3b; A§18), each charged to the acting person and never to a
// vault or target someone else can fill: folders and vaults, agent keys, share links and feedback each refuse that
// person with 429 past their bound and write nothing, while another person in the same vault or on the same target
// carries on. Notes are create-budget.harness.test.ts; invites (20 an hour per inviter) are invites.test.ts; media are
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

const grantEditor = (folderId: string, owner: TestUser, editor: TestUser) => d1.db.prepare(`INSERT INTO folder_members
  (folder_id, principal_id, principal_type, role, added_by, created_at) VALUES (?1, ?2, 'user', 'editor', ?3, ?4)`)
  .bind(folderId, editor.id, owner.id, Date.now()).run();

async function expectBounded(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(429);
  expect(((await response.json()) as { error: string }).error).toBe('rate-limited');
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
}

async function expectMade(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(201);
}

describe('daily write bounds, charged to the acting person', () => {
  it('folders and vaults: a collaborator who spends their day in an owner’s vault never blocks the owner', async () => {
    const ada = await signedUpUser(env, 'bounds-folders-owner', 'Ada');
    const bo = await signedUpUser(env, 'bounds-folders-editor', 'Bo');
    await grantEditor(ada.homeId, ada, bo);
    // Bo's folders in Ada's vault: yesterday's don't count, today's do.
    await rowsToday(`INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at)
      SELECT ?2 || i, ?3, ?4, 'old ' || i, 'folder', ?5, ?6 FROM n`, 5, `old-${bo.id}-`, ada.id, bo.id, ada.homeId, Date.now() - 25 * 60 * 60 * 1000);
    // Bo's own Home vault is one of today's.
    await rowsToday(`INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at)
      SELECT ?2 || i, ?3, ?4, 'f ' || i, 'folder', ?5, ?6 FROM n`, FOLDER_CREATE_DAILY - 2, `f-${bo.id}-`, ada.id, bo.id, ada.homeId, Date.now());
    await expectMade(await call(bo, 'POST', '/api/folders', { parentId: ada.homeId, name: 'The last one' }));
    const before = await count('SELECT COUNT(*) AS n FROM folders WHERE created_by = ?1', bo.id);
    await expectBounded(await call(bo, 'POST', '/api/folders', { parentId: ada.homeId, name: 'One too many' }));
    await expectBounded(await call(bo, 'POST', '/api/folders', { parentId: bo.homeId, name: 'In Bo’s own vault' }));
    await expectBounded(await call(bo, 'POST', '/api/vaults', { name: 'Another vault' }));
    expect(await count('SELECT COUNT(*) AS n FROM folders WHERE created_by = ?1', bo.id)).toBe(before);

    // Ada's vault holds Bo's thousand folders, and Ada still adds folders and vaults.
    await expectMade(await call(ada, 'POST', '/api/folders', { parentId: ada.homeId, name: 'Ada’s folder' }));
    await expectMade(await call(ada, 'POST', '/api/vaults', { name: 'Ada’s second vault' }));
  }, 60_000);

  it('agent keys: a person mints AGENT_KEY_DAILY a day, revoked ones included; another person is unaffected', async () => {
    const ben = await signedUpUser(env, 'bounds-agents', 'Ben');
    const cat = await signedUpUser(env, 'bounds-agents-other', 'Cat');
    await rowsToday(`INSERT INTO agents (id, owner_user_id, name, key_hash, created_at, revoked_at)
      SELECT ?2 || i, ?3, 'Scribe', ?2 || i, ?4, ?4 FROM n`, AGENT_KEY_DAILY - 1, `agent-${ben.id}-`, ben.id, Date.now());
    expect((await call(ben, 'POST', '/api/agents', { name: 'Last' })).status).toBe(201);
    await expectBounded(await call(ben, 'POST', '/api/agents', { name: 'One too many' }));
    expect(await count('SELECT COUNT(*) AS n FROM agents WHERE owner_user_id = ?1', ben.id)).toBe(AGENT_KEY_DAILY);
    expect((await call(cat, 'POST', '/api/agents', { name: 'Cat’s' })).status).toBe(201);
  }, 60_000);

  it('share links: a person makes SHARE_LINK_DAILY a day over all their targets; links others made never count', async () => {
    const cy = await signedUpUser(env, 'bounds-links', 'Cy');
    const dan = await signedUpUser(env, 'bounds-links-other', 'Dan');
    const first = await insertDoc(d1.db, cy);
    const second = await insertDoc(d1.db, cy);
    const dans = await insertDoc(d1.db, dan);
    // A day's links on Cy's note, made by someone who managed it before; they don't count against Cy.
    await rowsToday(`INSERT INTO share_links (token, target_type, target_id, role, created_by, created_at, revoked_at)
      SELECT ?2 || i, 'doc', ?3, 'viewer', ?4, ?5, ?5 FROM n`, SHARE_LINK_DAILY, `prior-${first}-`, first, dan.id, Date.now());
    await rowsToday(`INSERT INTO share_links (token, target_type, target_id, role, created_by, created_at, revoked_at)
      SELECT ?2 || i, 'doc', ?3, 'viewer', ?4, ?5, ?5 FROM n`, SHARE_LINK_DAILY - 2, `link-${first}-`, first, cy.id, Date.now());
    await expectMade(await call(cy, 'POST', `/api/docs/${first}/links`, { role: 'viewer' }));
    await expectMade(await call(cy, 'POST', `/api/docs/${second}/links`, { role: 'viewer' }));
    await expectBounded(await call(cy, 'POST', `/api/docs/${second}/links`, { role: 'editor' }));
    expect(await count('SELECT COUNT(*) AS n FROM share_links WHERE created_by = ?1', cy.id)).toBe(SHARE_LINK_DAILY);
    await expectMade(await call(dan, 'POST', `/api/docs/${dans}/links`, { role: 'viewer' }));
  }, 60_000);

  it('feedback: a person sends FEEDBACK_DAILY a day; another person is unaffected', async () => {
    const dee = await signedUpUser(env, 'bounds-feedback', 'Dee');
    const eve = await signedUpUser(env, 'bounds-feedback-other', 'Eve');
    await rowsToday(`INSERT INTO feedback (id, user_id, body, page, created_at) SELECT ?2 || i, ?3, 'hi', NULL, ?4 FROM n`,
      FEEDBACK_DAILY - 1, `fb-${dee.id}-`, dee.id, Date.now());
    expect((await call(dee, 'POST', '/api/feedback', { body: 'The last one' })).status).toBe(201);
    await expectBounded(await call(dee, 'POST', '/api/feedback', { body: 'One too many' }));
    expect(await count('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?1', dee.id)).toBe(FEEDBACK_DAILY);
    expect((await call(eve, 'POST', '/api/feedback', { body: 'Hello' })).status).toBe(201);
  }, 60_000);
});
