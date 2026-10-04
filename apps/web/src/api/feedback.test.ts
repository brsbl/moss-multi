// POST /api/feedback: moss's Feedback dialog is not a dead affordance (A§6), and it writes only for a signed-in
// caller from the app's own origin.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleAuthRoute } from '../auth/route.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { handleApi } from './router.ts';

const BASE = 'http://127.0.0.1:8851';
const SECRET = 'b'.repeat(64);

let d1: TestD1;
let env: Parameters<typeof handleApi>[1];
let cookie: string;

beforeAll(async () => {
  d1 = await migratedD1();
  // /api/feedback never reaches a DO.
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: {} as never, PrincipalDO: {} as never };
  const response = await handleAuthRoute(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': '198.51.100.7' },
      body: JSON.stringify({ email: 'mm-t05b-feedback@example.invalid', password: 'correct horse battery', name: 'Ada' }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}, 60_000);
afterAll(() => d1?.dispose());

const send = (body: unknown, headers: Record<string, string>) =>
  handleApi(
    new Request(`${BASE}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    env,
  );

const rows = async () =>
  (await d1.db.prepare('SELECT body, page FROM feedback ORDER BY created_at').all<{ body: string; page: string | null }>()).results;

describe('POST /api/feedback', () => {
  it('stores what the dialog sends', async () => {
    const response = await send({ body: '  The sidebar is lovely  ', email: 'ada@example.invalid', page: '/d/abc' }, { origin: BASE, cookie });
    expect(response.status).toBe(201);
    expect(await rows()).toEqual([{ body: 'The sidebar is lovely\n\nReply to: ada@example.invalid', page: '/d/abc' }]);
  });

  it('refuses a caller without a session, a foreign origin and an empty body, and writes nothing', async () => {
    const before = (await rows()).length;
    expect((await send({ body: 'hi' }, { origin: BASE })).status).toBe(401);
    expect((await send({ body: 'hi' }, { origin: 'https://evil.example', cookie })).status).toBe(403);
    expect((await send({ body: 'hi' }, { cookie })).status).toBe(403);
    expect((await send({ body: '   ' }, { origin: BASE, cookie })).status).toBe(400);
    expect((await handleApi(new Request(`${BASE}/api/feedback`), env)).status).toBe(405);
    expect((await rows()).length).toBe(before);
  });
});
