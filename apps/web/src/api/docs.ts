// /api/docs. POST writes the D1 row in a folder the caller may edit, then DocDO.create seeds the doc (A§9 "+ Note").
// GET /api/docs/:id is the doc and the caller's role on it; DELETE and POST /restore are trash.ts; /members is the
// members API (members.ts) and /links the share links (links.ts); GET /api/docs/:id/instance is the owner-only DO probe
// (A§19), which reads nothing from the doc; GET /api/docs/:id/content is the doc's markdown export. A missing doc and
// one the caller cannot open get the same 404 on every route (A§8).
import { eq } from 'drizzle-orm';
import { getServerByName } from 'partyserver';
import { MARKDOWN_CAP_BYTES, REST_WRITE_RATE } from '@moss-multi/protocol/limits';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess, resolveFolderAccess } from './access.ts';
import { admitDuplicateMedia, copyMedia } from './assets.ts';
import { folderNotFound, liveIn, moveDoc, upFrom, vaultOf } from './folders.ts';
import { handleLinks } from './links.ts';
import { acceptShares, handleMembers, type MembersEnv } from './members.ts';
import { restoreDoc, trashDoc } from './trash.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';
import { ensureDefaultVault } from './vaults.ts';

export type DocsEnv = AuthEnv & Pick<AppEnv, 'DocDO' | 'PrincipalDO'> & MembersEnv & Partial<Pick<AppEnv, 'ASSETS'>>;

const DOC = /^\/api\/docs\/([^/]+)$/;
const MEMBERS = /^\/api\/docs\/([^/]+)\/members$/;
const LINKS = /^\/api\/docs\/([^/]+)\/links(?:\/([^/]+))?$/;
const INSTANCE = /^\/api\/docs\/([^/]+)\/instance$/;
const CONTENT = /^\/api\/docs\/([^/]+)\/content$/;

export interface DocRecord {
  id: string;
  folderId: string;
  title: string;
  filename: string;
  createdAt: number;
  updatedAt: number;
}

/** Inserts the row only while its folder is still live in its vault (a trash may be under way); null when it isn't. */
async function insertDoc(env: DocsEnv, db: Db, row: { folderId: string; ownerUserId: string; createdBy: string }): Promise<DocRecord | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const doc = { id, folderId: row.folderId, title: '', filename: `pending-${id}.md`, createdAt: now, updatedAt: now };
  const vault = await vaultOf(db, row.folderId);
  const inserted = await env.DB.prepare(`WITH RECURSIVE ${upFrom(1)}
    INSERT INTO docs (id, owner_user_id, created_by, folder_id, title, filename, created_at, updated_at)
    SELECT ?2, ?3, ?4, ?1, '', ?5, ?6, ?6 WHERE ${liveIn(7)}`)
    .bind(row.folderId, id, row.ownerUserId, row.createdBy, doc.filename, now, vault).run();
  return (inserted.meta?.changes ?? 0) > 0 ? doc : null;
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
  const folder = await resolveFolderAccess(db, principal, folderId, shareTokenOf(request));
  if (!folder || folder.deleted) return notFound();
  if (!roleAtLeast(folder.role, 'editor')) {
    return json({ error: 'forbidden', message: 'You can view this folder but not add notes to it.' }, 403, NO_STORE);
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const doc = await insertDoc(env, db, { folderId, ownerUserId: folder.ownerUserId, createdBy: principal.id });
  if (!doc) return folderNotFound();
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
  let folder = await resolveFolderAccess(db, principal, folderId, shareTokenOf(request));
  // A direct document grant gives no right to create siblings in someone else's folder.
  if (!folder || folder.deleted || !roleAtLeast(folder.role, 'editor')) {
    folderId = await ensureDefaultVault(db, userId);
    folder = await resolveFolderAccess(db, principal, folderId);
  }
  if (!folder || folder.deleted || !roleAtLeast(folder.role, 'editor')) return notFound();
  // The copy's media enter the target vault through the same admission as an upload (A§16).
  const refused = await admitDuplicateMedia(request, env, principal, docId, folderId);
  if (refused) return refused;
  const original = await getServerByName(env.DocDO, docId);
  const snapshot = await original.snapshotForDuplicate();
  const title = `${snapshot.title.trim() || 'Untitled'} copy`;
  const doc = await insertDoc(env, db, { folderId, ownerUserId: folder.ownerUserId, createdBy: principal.id });
  if (!doc) return folderNotFound();
  try {
    // The copy's media are the source's own record, so it shows the same files wherever it lands (A§16).
    await copyMedia(env.DB, docId, doc.id);
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
  await acceptShares(env.DB, principal, docId, access);
  return json({ doc, role: access.role }, 200, NO_STORE);
}

/** PATCH /api/docs/:id: `{title}` renames through the DocDO; `{folderId}` moves the note (folders.ts). */
async function patchDoc(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (body && 'folderId' in body && !('title' in body)) return moveDoc(request, env, docId, body.folderId);
  return renameDoc(request, env, docId, body);
}

async function renameDoc(request: Request, env: DocsEnv, docId: string, body: Record<string, unknown> | null): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, 'editor')) return json({ error: 'forbidden' }, 403, NO_STORE);
  if (!body || typeof body.title !== 'string') return json({ error: 'bad-request' }, 400, NO_STORE);
  try {
    // Per identity, not per doc: a rename diffs caller text, so one principal cannot spread a flood across docs.
    const principalDO = await getServerByName(env.PrincipalDO, principal.id);
    if (!(await principalDO.takeWriteToken())) {
      return json({ error: 'rate-limited' }, 429, { ...NO_STORE, 'retry-after': String(REST_WRITE_RATE.windowMs / 1000) });
    }
    const stub = await getServerByName(env.DocDO, docId);
    await stub.renameTitle(body.title);
    return readDoc(request, env, docId);
  } catch {
    return json({ error: 'unavailable' }, 503, NO_STORE);
  }
}

/** GET /api/docs/:id/content: the doc as a `.md` file through the one converter (A§12), for any reader (T3.7). */
async function readContent(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  const markdown = await (await getServerByName(env.DocDO, docId)).exportMarkdown();
  return new Response(markdown, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', ...NO_STORE } });
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
  const restore = /^\/api\/docs\/([^/]+)\/restore$/.exec(pathname);
  if (restore) return only('POST', request, () => restoreDoc(request, env, restore[1]));
  const doc = DOC.exec(pathname);
  if (doc) {
    if (request.method === 'PATCH') return patchDoc(request, env, doc[1]);
    if (request.method === 'DELETE') return trashDoc(request, env, doc[1]);
    return request.method === 'GET' ? readDoc(request, env, doc[1]) : json({ error: 'method-not-allowed' }, 405, { allow: 'GET, PATCH, DELETE' });
  }
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
  const content = CONTENT.exec(pathname);
  if (content) return only('GET', request, () => readContent(request, env, content[1]));
  const instance = INSTANCE.exec(pathname);
  if (instance) return only('GET', request, () => docInstance(request, env, instance[1]));
  return notFound();
}
