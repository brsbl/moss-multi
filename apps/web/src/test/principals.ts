// Signed-up test users and doc rows over a migrated D1, for API and admission tests.
import { ensureDefaultVault } from '../api/vaults.ts';
import { handleAuthRoute } from '../auth/route.ts';
import { createDb } from '../db/client.ts';

export const BASE = 'http://127.0.0.1:8850';
export const SECRET = 'a'.repeat(64);

export interface AuthTestEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
  cookie: string;
  homeId: string;
}

let seq = 0;

export async function signedUpUser(env: AuthTestEnv, label: string, name = 'Ada'): Promise<TestUser> {
  seq += 1;
  const email = `mm-t07-${label}-${seq}-${Date.now()}@example.invalid`;
  const response = await handleAuthRoute(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': `198.51.100.${seq % 250}` },
      body: JSON.stringify({ email, password: 'correct horse battery', name }),
    }),
    env,
  );
  if (response.status !== 200) throw new Error(`sign-up ${response.status}: ${await response.text()}`);
  const { user } = (await response.json()) as { user: { id: string } };
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { id: user.id, name, email, cookie, homeId: await ensureDefaultVault(createDb(env.DB), user.id) };
}

/** A docs row as POST /api/docs writes it, straight into D1. */
export async function insertDoc(db: D1Database, owner: TestUser, options: { deleted?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare('INSERT INTO docs (id, owner_user_id, created_by, folder_id, title, filename, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner.id, owner.id, owner.homeId, '', `${id}.md`, now, now, options.deleted ? now : null)
    .run();
  return id;
}
