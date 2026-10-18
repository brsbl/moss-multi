// The pilot deployment's sign-up allowlist (T8.P1): with MOSS_SIGN_UP=allowlist, only the emails in
// MOSS_ALLOWED_EMAILS may create an account. Everyone else is refused 403 SIGN_UP_NOT_ALLOWED before better-auth runs,
// and better-auth's own user-create hook refuses them too, so no other path (OAuth, a direct API call) creates one.
// With the variable unset, sign-up stays open (staging and local stacks).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { createAuth } from './auth.ts';
import { handleAuthRoute } from './route.ts';

const BASE = 'http://127.0.0.1:8853';
const SECRET = 'a'.repeat(64);
const PASSWORD = 'correct horse battery';

let d1: TestD1;
type Env = Parameters<typeof handleAuthRoute>[1];
let open: Env;
let pilot: Env;

beforeAll(async () => {
  d1 = await migratedD1();
  open = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE };
  pilot = { ...open, MOSS_SIGN_UP: 'allowlist', MOSS_ALLOWED_EMAILS: ' Pilot-Ada@Example.invalid,\npilot-bo@example.invalid ; ' };
}, 60_000);
afterAll(() => d1?.dispose());

const run = Date.now().toString(36);
let ip = 0;

const signUp = (email: unknown, env: Env) => handleAuthRoute(new Request(`${BASE}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': `198.51.100.${(ip += 1)}` },
  body: JSON.stringify({ email, password: PASSWORD, name: 'Ada' }),
}), env);

const accounts = async (email: string) =>
  (await d1.db.prepare('SELECT COUNT(*) AS n FROM user WHERE lower(email) = lower(?1)').bind(email).first<{ n: number }>())?.n ?? 0;

async function expectNotAllowed(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(403);
  const body = await response.json() as { code?: string; message?: string };
  expect(body.code).toBe('SIGN_UP_NOT_ALLOWED');
  expect(body.message).toMatch(/invited/);
}

describe('the sign-up allowlist', () => {
  it('lets an allowlisted email sign up, whatever its case and the list separators', async () => {
    const made = await signUp('pilot-ada@example.invalid', pilot);
    expect(made.status, await made.clone().text()).toBe(200);
    expect(await accounts('pilot-ada@example.invalid')).toBe(1);
    expect((await signUp('PILOT-BO@example.invalid', pilot)).status).toBe(200);
  });

  it('refuses every other email with a clear message and creates no account', async () => {
    const email = `pilot-eve-${run}@example.invalid`;
    await expectNotAllowed(await signUp(email, pilot));
    expect(await accounts(email)).toBe(0);
    // A near miss is not a match.
    await expectNotAllowed(await signUp('pilot-ada@example.invalid.evil.test', pilot));
    await expectNotAllowed(await signUp('x-pilot-ada@example.invalid', pilot));
  });

  it('refuses a sign-up with no usable email', async () => {
    await expectNotAllowed(await signUp(undefined, pilot));
    await expectNotAllowed(await signUp(['pilot-ada@example.invalid'], pilot));
  });

  it('refuses everyone when the allowlist is required but empty or missing', async () => {
    const email = 'pilot-ada-2@example.invalid';
    await expectNotAllowed(await signUp(email, { ...pilot, MOSS_ALLOWED_EMAILS: '' }));
    await expectNotAllowed(await signUp(email, { ...pilot, MOSS_ALLOWED_EMAILS: undefined }));
    await expectNotAllowed(await signUp(email, { ...pilot, MOSS_ALLOWED_EMAILS: ' , ;\n' }));
    expect(await accounts(email)).toBe(0);
  });

  it('leaves sign-up open when no allowlist is configured', async () => {
    const email = `open-${run}@example.invalid`;
    expect((await signUp(email, open)).status).toBe(200);
    expect(await accounts(email)).toBe(1);
  });

  it('keeps sign-in working for an allowlisted account', async () => {
    const signedIn = await handleAuthRoute(new Request(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': '198.51.100.250' },
      body: JSON.stringify({ email: 'pilot-ada@example.invalid', password: PASSWORD }),
    }), pilot);
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  });

  it('refuses a user created past the route too: better-auth creates no account for an email off the list', async () => {
    const email = `pilot-direct-${run}@example.invalid`;
    await expect(createAuth(pilot).api.signUpEmail({ body: { email, password: PASSWORD, name: 'Eve' } })).rejects.toBeTruthy();
    expect(await accounts(email)).toBe(0);
  });
});
