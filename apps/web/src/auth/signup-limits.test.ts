// Open sign-up is bounded in the Worker (T3.S3b; A§7, A§18): beyond better-auth's per-minute limit, sign-ups from one
// client address per day and to one email domain per hour are counted in D1 before better-auth runs, refused with 429
// past either, and refused 503 when the count cannot be kept. Device-code requests, which each write a row, are limited
// per address too.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { CLI_CLIENT_ID, DEVICE_CODE_LIMIT, SIGN_UP_ADDRESS_DAILY, SIGN_UP_DOMAIN_HOURLY, SIGN_UP_LIMIT } from './auth.ts';
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

const signUp = (email: string, ip: string, target = env) => handleAuthRoute(new Request(`${BASE}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': ip },
  body: JSON.stringify({ email, password: 'correct horse battery', name: 'Ada' }),
}), target);

const accounts = async (like: string) =>
  (await d1.db.prepare('SELECT COUNT(*) AS n FROM user WHERE email LIKE ?1').bind(like).first<{ n: number }>())?.n ?? 0;

async function expectTooMany(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(429);
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
}

describe('sign-up limits', () => {
  it('refuses one address past its daily sign-ups, creating no account', { timeout: 180_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.now();
    vi.setSystemTime(now);
    const ip = '203.0.113.20';
    for (let i = 0; i < SIGN_UP_ADDRESS_DAILY.max; i += 1) {
      // Paced under better-auth's minute limit, so only the daily count can refuse.
      if (i > 0 && i % SIGN_UP_LIMIT.max === 0) vi.setSystemTime((now += SIGN_UP_LIMIT.window * 1000 + 1));
      const made = await signUp(`mm-s3b-addr-${run}-${i}@d${i}-${run}.example.invalid`, ip);
      expect(made.status, `sign-up ${i + 1}: ${await made.clone().text()}`).toBe(200);
    }
    vi.setSystemTime((now += SIGN_UP_LIMIT.window * 1000 + 1));
    await expectTooMany(await signUp(`mm-s3b-addr-${run}-over@over-${run}.example.invalid`, ip));
    expect(await accounts(`mm-s3b-addr-${run}-over@%`)).toBe(0);
    expect((await signUp(`mm-s3b-addr-${run}-else@else-${run}.example.invalid`, '203.0.113.21')).status, 'another address').toBe(200);
    vi.setSystemTime(now + SIGN_UP_ADDRESS_DAILY.window * 1000);
    expect((await signUp(`mm-s3b-addr-${run}-later@later-${run}.example.invalid`, ip)).status, 'a day later').toBe(200);
  });

  it('refuses one email domain past its hourly sign-ups across addresses, creating no account', { timeout: 180_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    vi.setSystemTime(start);
    const domain = `burst-${run}.example.invalid`;
    for (let i = 0; i < SIGN_UP_DOMAIN_HOURLY.max; i += 1) {
      const made = await signUp(`mm-s3b-dom-${i}@${domain}`, `198.18.${Math.floor(i / 200)}.${(seq += 1) % 250}`);
      expect(made.status, `sign-up ${i + 1}: ${await made.clone().text()}`).toBe(200);
    }
    await expectTooMany(await signUp(`mm-s3b-dom-over@${domain.toUpperCase()}`, '198.18.9.1'));
    expect(await accounts(`mm-s3b-dom-over@%`)).toBe(0);
    expect((await signUp(`mm-s3b-dom-other@other-${run}.example.invalid`, '198.18.9.2')).status, 'another domain').toBe(200);
    vi.setSystemTime(start + SIGN_UP_DOMAIN_HOURLY.window * 1000 + 1_000);
    expect((await signUp(`mm-s3b-dom-later@${domain}`, '198.18.9.3')).status, 'an hour later').toBe(200);
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
