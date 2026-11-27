// The CLI's device flow (A§7, A§17; RFC 8628) through /api/auth: opening /device with the code claims it for the
// signed-in person, only that person can approve or deny it, a decided code cannot be decided again, and one approved
// code yields exactly one session, however often or concurrently it is redeemed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleApi } from '../api/router.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { CLI_CLIENT_ID } from './auth.ts';
import { handleAuthRoute } from './route.ts';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: {} as never, PrincipalDO: {} as never };
  ada = await signedUpUser(env, 'device-ada', 'Ada');
  ben = await signedUpUser(env, 'device-ben', 'Ben');
}, 60_000);
afterAll(() => d1?.dispose());

/** A terminal's request: JSON, no Origin, no cookie. */
const terminal = (path: string, body: unknown) => handleAuthRoute(new Request(`${BASE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), env);

/** A browser's request as `user`, from the app's origin. */
const browser = (user: TestUser, method: 'GET' | 'POST', path: string, body?: unknown) => handleAuthRoute(new Request(`${BASE}${path}`, {
  method,
  headers: { 'content-type': 'application/json', origin: BASE, cookie: user.cookie },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env);

async function newCode(): Promise<{ device_code: string; user_code: string; verification_uri: string }> {
  const response = await terminal('/api/auth/device/code', { client_id: CLI_CLIENT_ID });
  expect(response.status).toBe(200);
  return (await response.json()) as { device_code: string; user_code: string; verification_uri: string };
}

const row = (userCode: string) => d1.db.prepare('SELECT status, user_id FROM device_code WHERE user_code = ?')
  .bind(userCode.replace(/-/g, '')).first<{ status: string; user_id: string | null }>();

/** One token poll; the polling interval is cleared first so a test need not wait 5 s between polls. */
async function poll(deviceCode: string): Promise<Response> {
  await d1.db.prepare('UPDATE device_code SET last_polled_at = NULL WHERE device_code = ?').bind(deviceCode).run();
  return terminal('/api/auth/device/token', { grant_type: GRANT_TYPE, device_code: deviceCode, client_id: CLI_CLIENT_ID });
}

const claim = (user: TestUser, userCode: string) => browser(user, 'GET', `/api/auth/device?user_code=${encodeURIComponent(userCode)}`);

describe('the device flow', () => {
  it('points the terminal at /device and refuses an unknown client', async () => {
    const code = await newCode();
    expect(new URL(code.verification_uri, BASE).pathname).toBe('/device');
    expect((await terminal('/api/auth/device/code', { client_id: 'someone-else' })).status).toBe(400);
  });

  it('claims the code for the person who opens it, and not for a second person', async () => {
    const code = await newCode();
    expect(await row(code.user_code)).toEqual({ status: 'pending', user_id: null });
    const opened = await claim(ada, code.user_code);
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ status: 'pending' });
    expect(await row(code.user_code)).toEqual({ status: 'pending', user_id: ada.id });
    expect((await claim(ben, code.user_code)).status).toBe(200);
    expect((await row(code.user_code))?.user_id).toBe(ada.id);
  });

  it('refuses approval by anyone but the claimant, and until it is claimed', async () => {
    const code = await newCode();
    expect((await browser(ada, 'POST', '/api/auth/device/approve', { userCode: code.user_code })).status).toBe(400);
    await claim(ada, code.user_code);
    expect((await browser(ben, 'POST', '/api/auth/device/approve', { userCode: code.user_code })).status).toBe(403);
    expect((await browser(ben, 'POST', '/api/auth/device/deny', { userCode: code.user_code })).status).toBe(403);
    expect((await row(code.user_code))?.status).toBe('pending');
    expect((await poll(code.device_code)).status).toBe(400);
  });

  it('signs the terminal in as the approver', async () => {
    const code = await newCode();
    await claim(ada, code.user_code);
    const pending = await poll(code.device_code);
    expect(await pending.json()).toMatchObject({ error: 'authorization_pending' });
    expect((await browser(ada, 'POST', '/api/auth/device/approve', { userCode: code.user_code })).status).toBe(200);
    const token = await poll(code.device_code);
    expect(token.status).toBe(200);
    const { access_token } = (await token.json()) as { access_token: string };
    const me = await handleApi(new Request(`${BASE}/api/me`, { headers: { authorization: `Bearer ${access_token}` } }), env);
    expect(await me.json()).toMatchObject({ principal: { type: 'user', id: ada.id } });
  });

  it('keeps a denial: approving afterwards is refused, and the terminal gets access_denied once', async () => {
    const code = await newCode();
    await claim(ada, code.user_code);
    expect((await browser(ada, 'POST', '/api/auth/device/deny', { userCode: code.user_code })).status).toBe(200);
    expect((await browser(ada, 'POST', '/api/auth/device/approve', { userCode: code.user_code })).status).toBe(400);
    expect((await row(code.user_code))?.status).toBe('denied');
    const denied = await poll(code.device_code);
    expect(await denied.json()).toMatchObject({ error: 'access_denied' });
    const again = await poll(code.device_code);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('yields one session per approved code: a replay and concurrent redemptions get none', async () => {
    const code = await newCode();
    await claim(ada, code.user_code);
    await browser(ada, 'POST', '/api/auth/device/approve', { userCode: code.user_code });
    const before = await d1.db.prepare('SELECT count(*) AS n FROM session WHERE user_id = ?').bind(ada.id).first<{ n: number }>();
    const raced = await Promise.all([1, 2, 3].map(() => terminal('/api/auth/device/token', {
      grant_type: GRANT_TYPE, device_code: code.device_code, client_id: CLI_CLIENT_ID,
    })));
    expect(raced.filter((response) => response.status === 200)).toHaveLength(1);
    expect((await poll(code.device_code)).status).toBe(400);
    const after = await d1.db.prepare('SELECT count(*) AS n FROM session WHERE user_id = ?').bind(ada.id).first<{ n: number }>();
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
  });
});
