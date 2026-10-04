// /api/folders: GET /api/folders/:id is a folder or vault and the caller's role on it (the `/f/$folderId` landing,
// A§4.2), which a folder link opens; /members and /links are the sharing APIs. POST /api/folders creates a folder under
// one the caller can edit; T2.2 owns the rest of the folders API (rename, move, trash). A missing folder and one the
// caller cannot open get the same 404 (A§8).
import { eq } from 'drizzle-orm';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { folders } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { resolveFolderAccess } from './access.ts';
import { handleLinks } from './links.ts';
import { handleMembers, type MembersEnv } from './members.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

const FOLDER = /^\/api\/folders\/([^/]+)$/;
const MEMBERS = /^\/api\/folders\/([^/]+)\/members$/;
const LINKS = /^\/api\/folders\/([^/]+)\/links(?:\/([^/]+))?$/;
const NAME_MAX = 255;

/** The vault at the top of a folder's chain. */
async function vaultOf(db: ReturnType<typeof createDb>, folderId: string): Promise<string> {
  let id = folderId;
  for (let depth = 0; depth < 32; depth += 1) {
    const [row] = await db.select({ parentId: folders.parentId }).from(folders).where(eq(folders.id, id)).limit(1);
    if (!row?.parentId) return id;
    id = row.parentId;
  }
  return id;
}

async function readFolder(request: Request, env: MembersEnv, folderId: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const access = await resolveFolderAccess(db, principal, folderId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  // A link holder sees the folder it was handed, never the vault around it.
  const folder = { id: folderId, name: access.name, kind: access.kind, ...(access.linkOnly ? {} : { vaultId: await vaultOf(db, folderId) }) };
  return json({ folder, role: access.role }, 200, NO_STORE);
}

async function createFolder(request: Request, env: MembersEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  const body = await readJsonObject(request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!body || !name || name.length > NAME_MAX || name.includes('/') || typeof body.parentId !== 'string') {
    return json({ error: 'bad-request', message: 'Name the folder (no "/").' }, 400, NO_STORE);
  }
  const db = createDb(env.DB);
  const parent = await resolveFolderAccess(db, principal, body.parentId);
  if (!parent || parent.deleted) return notFound();
  if (!roleAtLeast(parent.role, 'editor')) {
    return json({ error: 'forbidden', message: 'You can view this folder but not add folders to it.' }, 403, NO_STORE);
  }
  const folder = { id: crypto.randomUUID(), name, parentId: body.parentId };
  try {
    // The vault's owner owns the folder; created_by records who made it (A§8).
    await db.insert(folders).values({ ...folder, ownerUserId: parent.ownerUserId, createdBy: principal.id, kind: 'folder', createdAt: Date.now() });
  } catch (error) {
    if (`${String(error)} ${String((error as { cause?: unknown }).cause)}`.includes('UNIQUE')) return json({ error: 'name-taken', message: 'A folder with that name is already here.' }, 409, NO_STORE);
    throw error;
  }
  return json({ folder }, 201, NO_STORE);
}

/** `/api/folders` and everything under it. */
export function handleFolders(request: Request, env: MembersEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/folders') return createFolder(request, env);
  const folder = FOLDER.exec(pathname);
  if (folder) return readFolder(request, env, folder[1]);
  const members = MEMBERS.exec(pathname);
  if (members) return handleMembers(request, env, { type: 'folder', id: members[1] });
  const links = LINKS.exec(pathname);
  if (links) return handleLinks(request, env, { type: 'folder', id: links[1] }, links[2] ?? null);
  return Promise.resolve(json({ error: 'not-found' }, 404));
}
