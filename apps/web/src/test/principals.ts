// Signed-up test users and doc rows over a migrated D1, for API and admission tests.
import { ensureDefaultVault } from '../api/vaults.ts';
import { AGENT_KEY_PREFIX, sha256Hex } from '../auth/principal.ts';
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
  /** The session as a bearer token (better-auth's `set-auth-token`), as the CLI presents it. */
  token: string;
  homeId: string;
}

let seq = 0;

export async function signedUpUser(env: AuthTestEnv, label: string, name = 'Ada', address?: string): Promise<TestUser> {
  seq += 1;
  const email = address ?? `mm-t07-${label}-${seq}-${Date.now()}@example.invalid`;
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
  const token = response.headers.get('set-auth-token');
  if (!token) throw new Error('sign-up set no auth token');
  return { id: user.id, name, email, cookie, token, homeId: await ensureDefaultVault(createDb(env.DB), user.id) };
}

/** A live `mm_sk_` key for an agent acting for `owner`. */
export async function agentKey(db: D1Database, owner: TestUser): Promise<string> {
  return (await insertAgent(db, owner)).key;
}

/** An agent acting for `owner`: its id, which a grant can name, and its live key. */
export async function insertAgent(db: D1Database, owner: TestUser): Promise<{ id: string; key: string }> {
  const id = crypto.randomUUID();
  const key = `${AGENT_KEY_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`;
  await db
    .prepare('INSERT INTO agents (id, owner_user_id, name, key_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)')
    .bind(id, owner.id, 'Scribe', await sha256Hex(key), Date.now())
    .run();
  return { id, key };
}

/** A docs row as POST /api/docs writes it, straight into D1; in the owner's Home vault unless `folderId` says. */
export async function insertDoc(db: D1Database, owner: TestUser, options: { deleted?: boolean; folderId?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare('INSERT INTO docs (id, owner_user_id, created_by, folder_id, title, filename, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner.id, owner.id, options.folderId ?? owner.homeId, '', `${id}.md`, now, now, options.deleted ? now : null)
    .run();
  return id;
}

/** A folder under `parentId` (a vault when null), owned by `owner`. */
export async function insertFolder(db: D1Database, owner: TestUser, parentId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner.id, owner.id, `f-${id.slice(0, 8)}`, parentId === null ? 'vault' : 'folder', parentId, Date.now())
    .run();
  return id;
}

export type GrantTarget = { docId: string } | { folderId: string };

/** A grant row as the members API writes one. */
export async function insertGrant(db: D1Database, target: GrantTarget, principal: { id: string; type?: 'user' | 'agent' }, role: string): Promise<void> {
  const [table, column, targetId] = 'docId' in target ? ['doc_members', 'doc_id', target.docId] : ['folder_members', 'folder_id', target.folderId];
  await db
    .prepare(`INSERT INTO ${table} (${column}, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(targetId, principal.id, principal.type ?? 'user', role, 'test', Date.now())
    .run();
}

/** A share-link row (T2.4 creates them through the UI); returns its token. */
export async function insertLink(db: D1Database, target: GrantTarget, role: string, options: { revoked?: boolean } = {}): Promise<string> {
  const token = crypto.randomUUID().replaceAll('-', '');
  const [type, id] = 'docId' in target ? ['doc', target.docId] : ['folder', target.folderId];
  await db
    .prepare('INSERT INTO share_links (token, target_type, target_id, role, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(token, type, id, role, 'test', Date.now(), options.revoked ? Date.now() : null)
    .run();
  return token;
}
