// /api/docs. POST writes the D1 row in a vault the caller owns, then DocDO.create seeds the doc (A§9 "+ Note") and
// projects any title, with the same filename rule (A§5.1).
// GET /api/docs/:id/instance is the owner-only DO probe (A§19); it reads nothing from the doc.
import { and, eq, isNull } from 'drizzle-orm';
import { getServerByName } from 'partyserver';
import { filenameFor } from '@moss-multi/core/filenames';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs, folders } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess } from './access.ts';
import { ensureDefaultVault } from './vaults.ts';

export type DocsEnv = AuthEnv & Pick<AppEnv, 'DocDO'>;

const NO_STORE = { 'cache-control': 'no-store' };
const notFound = () => json({ error: 'not-found' }, 404, NO_STORE);
const INSTANCE = /^\/api\/docs\/([^/]+)\/instance$/;
const FILENAME_ATTEMPTS = 5;

export interface DocRecord {
  id: string;
  folderId: string;
  title: string;
  filename: string;
  createdAt: number;
  updatedAt: number;
}

async function insertDoc(db: Db, row: { folderId: string; ownerUserId: string; createdBy: string; title: string }): Promise<DocRecord> {
  for (let attempt = 1; ; attempt += 1) {
    const live = await db
      .select({ filename: docs.filename })
      .from(docs)
      .where(and(eq(docs.folderId, row.folderId), isNull(docs.deletedAt)));
    const now = Date.now();
    const doc: DocRecord = {
      id: crypto.randomUUID(),
      folderId: row.folderId,
      title: row.title,
      filename: filenameFor(row.title, new Set(live.map((d) => d.filename))),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.insert(docs).values({ ...doc, ownerUserId: row.ownerUserId, createdBy: row.createdBy });
      return doc;
    } catch (error) {
      // A concurrent create took the name; the live-filename index refused this one.
      const unique = /UNIQUE/i.test(`${error} ${(error as { cause?: unknown }).cause ?? ''}`);
      if (!unique || attempt >= FILENAME_ATTEMPTS) throw error;
    }
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : {};
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function createDoc(request: Request, env: DocsEnv): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return json({ error: 'unauthenticated' }, 401, NO_STORE);
  const userId = principal.type === 'agent' ? principal.ownerUserId : principal.id;
  const body = await readBody(request);
  if (!body) return json({ error: 'bad-request' }, 400);
  const db = createDb(env.DB);
  const folderId = typeof body.folderId === 'string' ? body.folderId : await ensureDefaultVault(db, userId);
  const [folder] = await db
    .select({ ownerUserId: folders.ownerUserId })
    .from(folders)
    .where(and(eq(folders.id, folderId), isNull(folders.deletedAt)))
    .limit(1);
  // Until grants exist (T1.1), only a folder's owner creates in it.
  if (!folder || folder.ownerUserId !== userId) return notFound();
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const doc = await insertDoc(db, { folderId, ownerUserId: folder.ownerUserId, createdBy: principal.id, title });
  const stub = await getServerByName(env.DocDO, doc.id);
  await stub.create({ folderId, ownerId: folder.ownerUserId, ...(title ? { title } : {}) });
  return json({ doc }, 201, NO_STORE);
}

async function docInstance(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  const access = principal ? await resolveDocAccess(createDb(env.DB), principal, docId) : null;
  if (access?.role !== 'owner') return notFound();
  // A raw stub: probeInstance never runs onStart, so the probe cannot wake what it measures.
  const stub = env.DocDO.get(env.DocDO.idFromName(docId));
  return json(await stub.probeInstance(), 200, NO_STORE);
}

export async function handleDocs(request: Request, env: DocsEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/docs') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
    return createDoc(request, env);
  }
  const instance = INSTANCE.exec(pathname);
  if (instance) {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
    return docInstance(request, env, instance[1]);
  }
  return notFound();
}
