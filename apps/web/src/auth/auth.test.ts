import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleApi } from '../api/router.ts';
import { ensureDefaultVault } from '../api/vaults.ts';
import { createDb } from '../db/client.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { SIGN_IN_LIMIT } from './auth.ts';
import { AGENT_KEY_PREFIX, resolvePrincipal, sha256Hex } from './principal.ts';
import { handleAuthRoute } from './route.ts';

const BASE = 'http://127.0.0.1:8850';
const SECRET = 'a'.repeat(64);
const PASSWORD = 'correct horse battery';

let d1: TestD1;
let env: Parameters<typeof handleApi>[1] & { MOSS_TEST_HOOKS?: string };

beforeAll(async () => {
  d1 = await migratedD1();
  // /api/me never reaches a DO.
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: {} as never };
}, 60_000);
afterAll(() => d1?.dispose());

let seq = 0;
const email = (label: string) => `mm-t04-${label}-${(seq += 1)}@example.invalid`;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${BASE}${path}`, { headers });

/** The `name=value` pairs of a response's cookies, as a browser would send them back. */
const cookieOf = (response: Response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

// Each sign-up comes from its own address, so these tests never meet the sign-up limit.
async function signUp(address: string, headers: Record<string, string> = { origin: BASE }) {
  const request = post('/api/auth/sign-up/email', { email: address, password: PASSWORD, name: 'Ada' }, {
    'cf-connecting-ip': `198.51.100.${(seq += 1) % 250}`,
    ...headers,
  });
  return handleAuthRoute(request, env);
}

async function signedUp(label: string) {
  const address = email(label);
  const response = await signUp(address);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  return { email: address, id: body.user.id, cookie: cookieOf(response) };
}

async function vaultsOf(userId: string) {
  const { results } = await d1.db
    .prepare("SELECT id, name, parent_id FROM folders WHERE owner_user_id = ? AND kind = 'vault'")
    .bind(userId)
    .all<{ id: string; name: string; parent_id: string | null }>();
  return results;
}

describe('sign-up', () => {
  it('gets 403 without an Origin header and creates nothing', async () => {
    const address = email('no-origin');
    const response = await signUp(address, {});
    expect(response.status).toBe(403);
    const row = await d1.db.prepare('SELECT id FROM user WHERE email = ?').bind(address).first();
    expect(row).toBeNull();
  });

  it('gets 403 from a foreign Origin', async () => {
    const response = await signUp(email('foreign'), { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('gets a session with a same-origin Origin header', { timeout: 30_000 }, async () => {
    const ada = await signedUp('session');
    expect(ada.cookie).toMatch(/session_token=/);
    const me = await handleApi(get('/api/me', { cookie: ada.cookie }), env);
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(await me.json()).toEqual({ principal: { type: 'user', id: ada.id, name: 'Ada', email: ada.email } });
  });
});

describe('the Home vault', () => {
  it('is created exactly once', { timeout: 30_000 }, async () => {
    const ada = await signedUp('home');
    const [home, ...extra] = await vaultsOf(ada.id);
    expect(extra).toEqual([]);
    expect(home).toMatchObject({ name: 'Home', parent_id: null });
    const pref = await d1.db.prepare('SELECT default_vault_id AS id FROM user_prefs WHERE user_id = ?').bind(ada.id).first<{ id: string }>();
    expect(pref?.id).toBe(home.id);

    const db = createDb(d1.db);
    const again = await Promise.all([ensureDefaultVault(db, ada.id), ensureDefaultVault(db, ada.id), ensureDefaultVault(db, ada.id)]);
    expect(again).toEqual([home.id, home.id, home.id]);

    const duplicate = await signUp(ada.email);
    expect(duplicate.status).toBe(422);
    expect(await vaultsOf(ada.id)).toHaveLength(1);
  });

  it('is created when concurrent first calls race', async () => {
    const t = Date.now();
    await d1.db
      .prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .bind('race-user', 'Ben', email('race'), t, t)
      .run();
    const db = createDb(d1.db);
    const ids = await Promise.all(Array.from({ length: 4 }, () => ensureDefaultVault(db, 'race-user')));
    expect(new Set(ids).size).toBe(1);
    expect(await vaultsOf('race-user')).toHaveLength(1);
  });
});

describe('rate limits', () => {
  const signIn = (ip: string, hooks = false) =>
    handleAuthRoute(
      post('/api/auth/sign-in/email', { email: 'nobody@example.invalid', password: 'wrong password!' }, {
        origin: BASE,
        'cf-connecting-ip': ip,
      }),
      hooks ? { ...env, MOSS_TEST_HOOKS: '1' } : env,
    );

  it('with production limits, repeated sign-ins from one cf-connecting-ip get 429', { timeout: 60_000 }, async () => {
    const statuses: number[] = [];
    for (let i = 0; i < SIGN_IN_LIMIT.max; i += 1) statuses.push((await signIn('203.0.113.7')).status);
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect((await signIn('203.0.113.7')).status).toBe(429);
    expect((await signIn('203.0.113.8')).status).toBe(401);
  });

  it('only the loopback test-hook stack raises them', { timeout: 60_000 }, async () => {
    for (let i = 0; i <= SIGN_IN_LIMIT.max + 2; i += 1) expect((await signIn('203.0.113.9', true)).status).toBe(401);
  });
});

describe('principal resolution', () => {
  async function agentKey(ownerId: string, revoked = false) {
    const key = `${AGENT_KEY_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`;
    await d1.db
      .prepare('INSERT INTO agents (id, owner_user_id, name, key_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), ownerId, 'Scribe', await sha256Hex(key), Date.now(), revoked ? Date.now() : null)
      .run();
    return key;
  }

  it('resolves an agent key to the agent acting for its owner', { timeout: 30_000 }, async () => {
    const ada = await signedUp('agent-owner');
    const key = await agentKey(ada.id);
    const me = await handleApi(get('/api/me', { authorization: `Bearer ${key}` }), env);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ principal: { type: 'agent', name: 'Scribe', ownerUserId: ada.id } });
  });

  it('refuses a revoked agent key without falling back to the cookie', { timeout: 30_000 }, async () => {
    const ada = await signedUp('revoked');
    const key = await agentKey(ada.id, true);
    const me = await handleApi(get('/api/me', { authorization: `Bearer ${key}`, cookie: ada.cookie }), env);
    expect(me.status).toBe(401);
  });

  it('resolves a session bearer token like a cookie', { timeout: 30_000 }, async () => {
    const address = email('bearer');
    const response = await signUp(address);
    const token = response.headers.get('set-auth-token');
    expect(token).toBeTruthy();
    const me = await handleApi(get('/api/me', { authorization: `Bearer ${token}` }), env);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ principal: { type: 'user', email: address } });
  });

  it('makes a share token alone an anonymous principal, which /api/me does not count as signed in', async () => {
    const principal = await resolvePrincipal(get('/api/docs/d1?share=tok123'), env);
    expect(principal).toEqual({ type: 'anonymous', id: 'anonymous', name: 'Anonymous', shareToken: 'tok123' });
    expect(await resolvePrincipal(get('/api/docs/d1', { 'x-moss-share': 'tok456' }), env)).toMatchObject({ shareToken: 'tok456' });
    expect((await handleApi(get('/api/me?share=tok123'), env)).status).toBe(401);
  });

  it('answers /api/me with 401 without credentials and 405 for POST', async () => {
    const anonymous = await handleApi(get('/api/me'), env);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('content-type')).toMatch(/^application\/json/);
    expect((await handleApi(post('/api/me', {}, { origin: BASE }), env)).status).toBe(405);
  });
});
