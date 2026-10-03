// /api/docs. POST writes the D1 row in a folder the caller may edit, then DocDO.create seeds the doc (A§9 "+ Note").
// GET /api/docs/:id is the doc and the caller's role on it; /members is the members API (members.ts); GET
// /api/docs/:id/instance is the owner-only DO probe (A§19), which reads nothing from the doc. A missing doc and one the
// caller cannot open get the same 404 on every route (A§8).
import { and, eq, isNull } from 'drizzle-orm';
import { getServerByName } from 'partyserver';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess, resolveFolderAccess } from './access.ts';
import { handleMembers } from './members.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';
import { ensureDefaultVault } from './vaults.ts';

export type DocsEnv = AuthEnv & Pick<AppEnv, 'DocDO'>;

const DOC = /^\/api\/docs\/([^/]+)$/;
const MEMBERS = /^\/api\/docs\/([^/]+)\/members$/;
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

export function slug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/** `<stem>.md`, else `<stem>-2.md`, `<stem>-3.md`…: collisions get a suffix, never a 409 (A§5.1). */
export function availableFilename(stem: string, taken: Set<string>): string {
  if (!taken.has(`${stem}.md`)) return `${stem}.md`;
  for (let n = 2; ; n += 1) if (!taken.has(`${stem}-${n}.md`)) return `${stem}-${n}.md`;
}

async function insertDoc(db: Db, row: { folderId: string; ownerUserId: string; createdBy: string; title: string }): Promise<DocRecord> {
  const stem = slug(row.title) || 'untitled';
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
      filename: availableFilename(stem, new Set(live.map((d) => d.filename))),
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

async function createDoc(request: Request, env: DocsEnv): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  const userId = principal.type === 'agent' ? principal.ownerUserId : principal.id;
  const body = await readJsonObject(request);
  if (!body) return json({ error: 'bad-request' }, 400);
  const db = createDb(env.DB);
  const folderId = typeof body.folderId === 'string' ? body.folderId : await ensureDefaultVault(db, userId);
  // Editors create in a shared folder or vault; the vault's owner owns the doc and created_by records who made it.
  const folder = await resolveFolderAccess(db, principal, folderId);
  if (!folder || folder.deleted) return notFound();
  if (!roleAtLeast(folder.role, 'editor')) {
    return json({ error: 'forbidden', message: 'You can view this folder but not add notes to it.' }, 403, NO_STORE);
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const doc = await insertDoc(db, { folderId, ownerUserId: folder.ownerUserId, createdBy: principal.id, title });
  const stub = await getServerByName(env.DocDO, doc.id);
  await stub.create({ folderId, ownerId: folder.ownerUserId, ...(title ? { title } : {}) });
  return json({ doc, role: folder.role }, 201, NO_STORE);
}

/** The doc's listing fields and the caller's role, for a doc the workspace listing does not carry. */
async function readDoc(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const access = await resolveDocAccess(db, principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  const [doc] = await db
    .select({ id: docs.id, folderId: docs.folderId, title: docs.title, createdAt: docs.createdAt, updatedAt: docs.updatedAt })
    .from(docs)
    .where(eq(docs.id, docId))
    .limit(1);
  if (!doc) return notFound();
  return json({ doc, role: access.role }, 200, NO_STORE);
}

async function docInstance(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  const access = principal ? await resolveDocAccess(createDb(env.DB), principal, docId) : null;
  if (access?.role !== 'owner') return notFound();
  // A raw stub: probeInstance never runs onStart, so the probe cannot wake what it measures.
  const stub = env.DocDO.get(env.DocDO.idFromName(docId));
  return json(await stub.probeInstance(), 200, NO_STORE);
}

const only = (method: string, request: Request, run: () => Promise<Response>): Promise<Response> =>
  request.method === method ? run() : Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: method }));

export async function handleDocs(request: Request, env: DocsEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/docs') return only('POST', request, () => createDoc(request, env));
  const doc = DOC.exec(pathname);
  if (doc) return only('GET', request, () => readDoc(request, env, doc[1]));
  const members = MEMBERS.exec(pathname);
  if (members) return handleMembers(request, env, { type: 'doc', id: members[1] });
  const instance = INSTANCE.exec(pathname);
  if (instance) return only('GET', request, () => docInstance(request, env, instance[1]));
  return notFound();
}
