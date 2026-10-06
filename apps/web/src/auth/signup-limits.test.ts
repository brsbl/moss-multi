// Open sign-up is bounded in the Worker (T3.S3b; A§7, A§18): beyond better-auth's per-minute limit, sign-ups from one
// client address (an IPv6 /64 counts as one) per day are counted in D1 before better-auth runs, refused with 429 past
// it, and refused 503 when the count cannot be kept. The count is per address only, so filling one address never
// blocks another, and no shared bucket exists: an email domain is never limited, and a request with no client address
// is refused outside the loopback test-hook stack. Device-code requests, which each write a row, are limited per address.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { CLI_CLIENT_ID, DEVICE_CODE_LIMIT, SIGN_UP_ADDRESS_DAILY, SIGN_UP_LIMIT, SIGN_UP_PRUNE_BATCH } from './auth.ts';
import { handleAuthRoute } from './route.ts';

const BASE = 'http://127.0.0.1:8852';
const SECRET = 'c'.repeat(64);

let d1: TestD1;
let env: Parameters<typeof handleAuthRoute>[1];

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE };
}, 60_000);
afterAll(() => d1?.dispose());
afterEach(() => { vi.useRealTimers(); });

let seq = 0;
const run = Date.now().toString(36);

const signUp = (email: string, ip: string | null, target = env, base = BASE) => handleAuthRoute(new Request(`${base}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base, ...(ip === null ? {} : { 'cf-connecting-ip': ip }) },
  body: JSON.stringify({ email, password: 'correct horse battery', name: 'Ada' }),
}), target);

const accounts = async (like: string) =>
  (await d1.db.prepare('SELECT COUNT(*) AS n FROM user WHERE email LIKE ?1').bind(like).first<{ n: number }>())?.n ?? 0;

async function expectTooMany(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(429);
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
}

/** Spends one address's day: SIGN_UP_ADDRESS_DAILY sign-ups from `ips(i)`, paced under better-auth's minute limit. */
async function fillDay(label: string, ips: (i: number) => string, now: { t: number }): Promise<void> {
  for (let i = 0; i < SIGN_UP_ADDRESS_DAILY.max; i += 1) {
    if (i > 0 && i % SIGN_UP_LIMIT.max === 0) vi.setSystemTime((now.t += SIGN_UP_LIMIT.window * 1000 + 1));
    const made = await signUp(`mm-s3b-${label}-${run}-${i}@d${i}-${run}.example.invalid`, ips(i));
    expect(made.status, `sign-up ${i + 1}: ${await made.clone().text()}`).toBe(200);
  }
  vi.setSystemTime((now.t += SIGN_UP_LIMIT.window * 1000 + 1));
}

describe('sign-up limits', () => {
  it('refuses one address past its daily sign-ups, creating no account; another address is unaffected', { timeout: 180_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = { t: Date.now() };
    vi.setSystemTime(now.t);
    const ip = '203.0.113.20';
    await fillDay('addr', () => ip, now);
    await expectTooMany(await signUp(`mm-s3b-addr-${run}-over@over-${run}.example.invalid`, ip));
    expect(await accounts(`mm-s3b-addr-${run}-over@%`)).toBe(0);
    expect((await signUp(`mm-s3b-addr-${run}-else@else-${run}.example.invalid`, '203.0.113.21')).status, 'another address').toBe(200);
    vi.setSystemTime(now.t + SIGN_UP_ADDRESS_DAILY.window * 1000);
    expect((await signUp(`mm-s3b-addr-${run}-later@later-${run}.example.invalid`, ip)).status, 'a day later').toBe(200);
  });

  it('counts an IPv6 /64 as one address, and a neighbouring /64 separately', { timeout: 180_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = { t: Date.now() };
    vi.setSystemTime(now.t);
    await fillDay('v6', (i) => `2001:db8:5:6:${(i + 1).toString(16)}::${i + 7}`, now);
    await expectTooMany(await signUp(`mm-s3b-v6-${run}-over@over-${run}.example.invalid`, '2001:0db8:0005:0006:ffff:1:2:3'));
    expect(await accounts(`mm-s3b-v6-${run}-over@%`)).toBe(0);
    expect((await signUp(`mm-s3b-v6-${run}-next@next-${run}.example.invalid`, '2001:db8:5:7::1')).status, 'the next /64').toBe(200);
  });

  it('never limits an email domain: past fifty sign-ups to one domain from distinct addresses all succeed', { timeout: 180_000 }, async () => {
    const domain = `crowd-${run}.example.invalid`;
    for (let i = 0; i < 60; i += 1) {
      const made = await signUp(`mm-s3b-dom-${i}@${domain}`, `198.18.${Math.floor(i / 200)}.${(seq += 1) % 250}`);
      expect(made.status, `sign-up ${i + 1}: ${await made.clone().text()}`).toBe(200);
    }
  });

  it('refuses a sign-up with no client address in production, creating no account', { timeout: 60_000 }, async () => {
    const prod = 'https://moss.example.invalid';
    const production = { ...env, BETTER_AUTH_URL: prod };
    const missing = await signUp(`mm-s3b-noip-${run}@noip-${run}.example.invalid`, null, production, prod);
    expect(missing.status, await missing.clone().text()).toBe(403);
    expect(await accounts(`mm-s3b-noip-${run}@%`)).toBe(0);
    const blank = await signUp(`mm-s3b-blank-${run}@noip-${run}.example.invalid`, ' ', production, prod);
    expect(blank.status, await blank.clone().text()).toBe(403);
    // The same sign-up with an address goes through.
    const addressed = await signUp(`mm-s3b-withip-${run}@noip-${run}.example.invalid`, '203.0.113.50', production, prod);
    expect(addressed.status, await addressed.clone().text()).toBe(200);
  });

  it('exempts only a loopback request on the hook stack: the same stack reached at another host is still counted', { timeout: 60_000 }, async () => {
    const hooks = { ...env, MOSS_TEST_HOOKS: '1' };
    const local = await signUp(`mm-s3b-hook-${run}@hook-${run}.example.invalid`, null, hooks);
    expect(local.status, await local.clone().text()).toBe(200);
    const remote = handleAuthRoute(new Request('https://moss.example.invalid/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: `mm-s3b-hookx-${run}@hook-${run}.example.invalid`, password: 'correct horse battery', name: 'Ada' }),
    }), hooks);
    const refused = await remote;
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(await accounts(`mm-s3b-hookx-${run}@%`)).toBe(0);
  });

  it('prunes closed windows a bounded batch at a time', { timeout: 60_000 }, async () => {
    const stale = Date.now() - 3 * SIGN_UP_ADDRESS_DAILY.window * 1000;
    await d1.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
      INSERT INTO signup_limits (key, window_start, count) SELECT 'address:stale-' || ?2 || '-' || i, ?3, 1 FROM n`)
      .bind(SIGN_UP_PRUNE_BATCH * 3, run, stale).run();
    const staleRows = async () => (await d1.db.prepare('SELECT COUNT(*) AS n FROM signup_limits WHERE window_start = ?1')
      .bind(stale).first<{ n: number }>())?.n ?? 0;
    expect((await signUp(`mm-s3b-prune-${run}@prune-${run}.example.invalid`, '203.0.113.60')).status).toBe(200);
    expect(await staleRows()).toBe(SIGN_UP_PRUNE_BATCH * 2);
  });

  it('fails closed when the count cannot be kept', { timeout: 60_000 }, async () => {
    const broken = new Proxy(d1.db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/signup_limits/.test(sql)) throw new Error('D1 unavailable');
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const refused = await signUp(`mm-s3b-closed-${run}@closed-${run}.example.invalid`, '203.0.113.30', { ...env, DB: broken });
    expect(refused.status, await refused.clone().text()).toBe(503);
    expect(await accounts(`mm-s3b-closed-${run}@%`)).toBe(0);
  });

  it('refuses a device-code burst from one address', { timeout: 60_000 }, async () => {
    const ask = (ip: string) => handleAuthRoute(new Request(`${BASE}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ client_id: CLI_CLIENT_ID }),
    }), env);
    for (let i = 0; i < DEVICE_CODE_LIMIT.max; i += 1) expect((await ask('203.0.113.40')).status).toBe(200);
    expect((await ask('203.0.113.40')).status).toBe(429);
    expect((await ask('203.0.113.41')).status).toBe(200);
  });
});
