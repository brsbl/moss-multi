// GET /api/workspace (A§11): the caller's active vault and its live root docs, timestamps in epoch ms. T0.5a
// serves the default vault only; folders, surfaced shared items, trash and ?vault= follow (T0.5b, M1, M2).
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { docs, folders } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { ensureDefaultVault } from './vaults.ts';

const NO_STORE = { 'cache-control': 'no-store' };

export async function workspace(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type !== 'user') return json({ error: 'unauthenticated' }, 401, NO_STORE);
  const db = createDb(env.DB);
  const vaultId = await ensureDefaultVault(db, principal.id);
  const [vault] = await db.select({ id: folders.id, name: folders.name }).from(folders).where(eq(folders.id, vaultId)).limit(1);
  const rows = await db
    .select({ id: docs.id, title: docs.title, filename: docs.filename, createdAt: docs.createdAt, updatedAt: docs.updatedAt })
    .from(docs)
    .where(and(eq(docs.folderId, vaultId), isNull(docs.deletedAt)))
    .orderBy(desc(docs.updatedAt));
  // The default vault is the caller's own, so they own every doc in it; shared items surface here in T1.2.
  return json({ vault, docs: rows.map((row) => ({ ...row, role: 'owner' })) }, 200, NO_STORE);
}
