// /api/docs. POST writes the D1 row in a folder the caller may edit, then DocDO.create seeds the doc (A§9 "+ Note").
// GET /api/docs/:id is the doc and the caller's role on it; /members is the members API (members.ts) and /links the
// share links (links.ts); GET /api/docs/:id/instance is the owner-only DO probe (A§19), which reads nothing from the
// doc. A missing doc and one the caller cannot open get the same 404 on every route (A§8).
import { eq } from 'drizzle-orm';
import { getServerByName } from 'partyserver';
import { MARKDOWN_CAP_BYTES } from '@moss-multi/protocol/limits';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess, resolveFolderAccess } from './access.ts';
import { handleLinks } from './links.ts';
import { handleMembers, type MembersEnv } from './members.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';
import { ensureDefaultVault } from './vaults.ts';

export type DocsEnv = AuthEnv & Pick<AppEnv, 'DocDO'> & MembersEnv;

const DOC = /^\/api\/docs\/([^/]+)$/;
const MEMBERS = /^\/api\/docs\/([^/]+)\/members$/;
const LINKS = /^\/api\/docs\/([^/]+)\/links(?:\/([^/]+))?$/;
const INSTANCE = /^\/api\/docs\/([^/]+)\/instance$/;

export interface DocRecord {
  id: string;
  folderId: string;
  title: string;
  filename: string;
  createdAt: number;
  updatedAt: number;
}

async function insertDoc(db: Db, row: { folderId: string; ownerUserId: string; createdBy: string; title: string }): Promise<DocRecord> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const doc = { id, folderId: row.folderId, title: '', filename: `pending-${id}.md`, createdAt: now, updatedAt: now };
  await db.insert(docs).values({ ...doc, ownerUserId: row.ownerUserId, createdBy: row.createdBy });
  return doc;
}

async function createDoc(request: Request, env: DocsEnv): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  const userId = principal.type === 'agent' ? principal.ownerUserId : principal.id;
  const body = await readJsonObject(request);
  if (!body) return json({ error: 'bad-request' }, 400);
  if ('markdown' in body && typeof body.markdown !== 'string') return json({ error: 'bad-request' }, 400, NO_STORE);
  if (typeof body.markdown === 'string' && new TextEncoder().encode(body.markdown).byteLength > MARKDOWN_CAP_BYTES) {
    return json({ error: 'doc-cap' }, 413, NO_STORE);
  }
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
  try {
    await stub.create({ folderId, ownerId: folder.ownerUserId, ...(title ? { title } : {}),
      ...(typeof body.markdown === 'string' ? { markdown: body.markdown } : {}) });
  } catch (error) {
    await db.delete(docs).where(eq(docs.id, doc.id));
    if (error instanceof Error && error.message === 'doc-cap') return json({ error: 'doc-cap' }, 413, NO_STORE);
    throw error;
  }
  const [projected] = await db.select({ id: docs.id, folderId: docs.folderId, title: docs.title, filename: docs.filename, createdAt: docs.createdAt, updatedAt: docs.updatedAt }).from(docs).where(eq(docs.id, doc.id));
  return json({ doc: projected, role: folder.role }, 201, NO_STORE);
}

/** Duplicate content at one server snapshot; grants stay on the source and folder access is inherited. */
async function duplicateDoc(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  const db = createDb(env.DB);
  const access = await resolveDocAccess(db, principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, 'editor')) return json({ error: 'forbidden' }, 403, NO_STORE);
  const [source] = await db.select({ folderId: docs.folderId }).from(docs).where(eq(docs.id, docId));
  if (!source) return notFound();
  const userId = principal.type === 'agent' ? principal.ownerUserId : principal.id;
  let folderId = source.folderId;
  let folder = await resolveFolderAccess(db, principal, folderId);
  // A direct document grant gives no right to create siblings in someone else's folder.
  if (!folder || folder.deleted || !roleAtLeast(folder.role, 'editor')) {
    folderId = await ensureDefaultVault(db, userId);
    folder = await resolveFolderAccess(db, principal, folderId);
  }
  if (!folder || folder.deleted || !roleAtLeast(folder.role, 'editor')) return notFound();
  const original = await getServerByName(env.DocDO, docId);
  const snapshot = await original.snapshotForDuplicate();
  const title = `${snapshot.title.trim() || 'Untitled'} copy`;
  const doc = await insertDoc(db, { folderId, ownerUserId: folder.ownerUserId, createdBy: principal.id, title });
  try {
    const target = await getServerByName(env.DocDO, doc.id);
    await target.createFromSnapshot({ folderId, ownerId: folder.ownerUserId, title }, snapshot.state);
  } catch (error) {
    await db.delete(docs).where(eq(docs.id, doc.id));
    if (error instanceof Error && error.message === 'doc-cap') return json({ error: 'doc-cap' }, 413, NO_STORE);
    throw error;
  }
  const [projected] = await db.select({ id: docs.id, folderId: docs.folderId, title: docs.title, filename: docs.filename, createdAt: docs.createdAt, updatedAt: docs.updatedAt }).from(docs).where(eq(docs.id, doc.id));
  return json({ doc: projected, role: folder.role }, 201, NO_STORE);
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

async function renameDoc(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, 'editor')) return json({ error: 'forbidden' }, 403, NO_STORE);
  const body = await readJsonObject(request);
  if (!body || typeof body.title !== 'string') return json({ error: 'bad-request' }, 400, NO_STORE);
  try {
    const stub = await getServerByName(env.DocDO, docId);
    await stub.renameTitle(body.title);
    return readDoc(request, env, docId);
  } catch {
    return json({ error: 'unavailable' }, 503, NO_STORE);
  }
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
  const duplicate = /^\/api\/docs\/([^/]+)\/duplicate$/.exec(pathname);
  if (duplicate) return only('POST', request, () => duplicateDoc(request, env, duplicate[1]));
  const doc = DOC.exec(pathname);
  if (doc) return request.method === 'PATCH' ? renameDoc(request, env, doc[1]) : only('GET', request, () => readDoc(request, env, doc[1]));
  const members = MEMBERS.exec(pathname);
  if (members) return handleMembers(request, env, { type: 'doc', id: members[1] });
  const links = LINKS.exec(pathname);
  if (links) return handleLinks(request, env, { type: 'doc', id: links[1] }, links[2] ?? null);
  const accessMatch = /^\/api\/docs\/([^/]+)\/access$/.exec(pathname);
  if (accessMatch) {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
    const principal = await resolvePrincipal(request, env);
    if (!principal) return json({ error: 'unauthenticated' }, 401, NO_STORE);
    const access = await resolveDocAccess(createDb(env.DB), principal, accessMatch[1], shareTokenOf(request));
    return access ? json({ role: access.role, deleted: access.deleted }, 200, NO_STORE) : notFound();
  }

  const instance = INSTANCE.exec(pathname);
  if (instance) return only('GET', request, () => docInstance(request, env, instance[1]));
  return notFound();
}
