// The folders API (T2.2; A§6, A§8, A§9 folders). POST /api/folders creates, PATCH /api/folders/:id renames or moves
// within the vault, DELETE /api/folders/:id sends the subtree to Trash as one batch, and moveDoc moves a note
// between folders (PATCH /api/docs/:id {folderId}). Editors create and rename; the vault's owner owns what an
// editor creates (created_by records who). Access inherits through the folder chain, so a move is a sharing decision:
// only the owner (A§8 manage) moves, on ownership alone, never on a grant or a share link; only the owner trashes. Every refusal carries a sentence, because moss
// shows the message it gets. Writes that depend on the tree re-check it in the same statement, so concurrent moves
// can't build a cycle or leave something live under a trashed folder. A moved or trashed folder changes who can open
// its docs; the live kick for that is T2.5's one path. GET /api/folders/:id is a folder or vault and the caller's
// role on it (the `/f/$folderId` landing, T2.4), which a folder link opens; /members and /links are the sharing APIs.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getServerByName } from 'partyserver';
import { filenameFor } from '@moss-multi/core/filenames';
import { can, roleAtLeast } from '@moss-multi/protocol/roles';
import { collectRecipients, publishRecipients, type FanoutEnv, type Recipients } from '@moss-multi/sync/fanout';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf, type Principal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs, folders } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { folderChain, MAX_FOLDER_DEPTH, resolveDocAccess, resolveFolderAccess, type FolderAccess } from './access.ts';
import { handleLinks } from './links.ts';
import { handleMembers } from './members.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

export type FoldersEnv = AuthEnv & Pick<AppEnv, 'DocDO'> & Partial<Pick<AppEnv, 'PrincipalDO'>>;

export const FOLDER_NAME_MAX = 100;

const refuse = (status: number, error: string, message: string) => json({ error, message }, status, NO_STORE);

/** One answer for a missing, inaccessible or trashed folder, so none of them can be told apart. */
export const folderNotFound = () =>
  refuse(404, 'not-found', 'That folder is no longer available, or you don’t have access to it.');

const isUnique = (error: unknown) => /UNIQUE/i.test(`${error} ${(error as { cause?: unknown })?.cause ?? ''}`);

/** The trimmed name, or the sentence that says what is wrong with it. */
function folderName(value: unknown): { name: string } | { problem: string } {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { problem: 'Give the folder a name.' };
  if (name.length > FOLDER_NAME_MAX) return { problem: `Folder names can be at most ${FOLDER_NAME_MAX} characters.` };
  // moss identifies folders by path, so a separator or a control character would break the id↔path map.
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) return { problem: 'Folder names can’t contain “/” or “\\”.' };
  return { name };
}

/** A move changes who can open what, so it needs the manage capability (A§8). */
const ownerMoves = (what: 'folders' | 'notes') => refuse(403, 'forbidden', `Only the vault’s owner can move ${what}, because a move changes who can open them.`);

const exists = (name: string) => refuse(409, 'folder-exists', `A folder named “${name}” already exists here.`);
const tooDeep = () => refuse(409, 'too-deep', `Folders can be nested at most ${MAX_FOLDER_DEPTH - 1} deep.`);

/** A committed change is never failed by its notification (T2.1). */
async function notify(env: FoldersEnv, recipients: Recipients): Promise<void> {
  if (!env.PrincipalDO || recipients.size === 0) return;
  try {
    await publishRecipients({ DB: env.DB, PrincipalDO: env.PrincipalDO } as FanoutEnv, recipients);
  } catch (error) {
    console.error('workspace folder notification failed', error);
  }
}

/**
 * A CTE `up` over folder `?{p}` and its ancestors. Writes that need a live destination in one vault condition on
 * it in the same statement, so two requests that both read the old tree can't both commit (no cycle, no depth
 * overrun, nothing live under a trashed parent).
 */
export const upFrom = (p: number) => `up(id, parent_id, deleted_at, kind, depth) AS (
    SELECT id, parent_id, deleted_at, kind, 1 FROM folders WHERE id = ?${p}
    UNION ALL SELECT f.id, f.parent_id, f.deleted_at, f.kind, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id
      WHERE up.depth < ${MAX_FOLDER_DEPTH}
  )`;
/** `up` is live throughout and ends at vault `?{vault}`. */
export const liveIn = (vault: number) =>
  `NOT EXISTS (SELECT 1 FROM up WHERE deleted_at IS NOT NULL) AND EXISTS (SELECT 1 FROM up WHERE id = ?${vault} AND kind = 'vault')`;

const changed = (result: D1Result) => (result.meta?.changes ?? 0) > 0;

/** The vault a folder is in (the last of its chain). */
export const vaultOf = async (db: Db, folderId: string) => (await folderChain(db, folderId)).at(-1);

/** The live folders under `id`, `id` first, each with its depth below `id` (1 for `id`). */
async function subtree(db: D1Database, id: string): Promise<{ id: string; depth: number }[]> {
  const rows = await db.prepare(`WITH RECURSIVE sub(id, depth) AS (
    SELECT id, 1 FROM folders WHERE id = ?1
    UNION ALL SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id
      WHERE f.deleted_at IS NULL AND s.depth <= ?2
  ) SELECT id, depth FROM sub`).bind(id, MAX_FOLDER_DEPTH).all<{ id: string; depth: number }>();
  return rows.results;
}

async function signedIn(request: Request, env: AuthEnv): Promise<Principal | null> {
  const principal = await resolvePrincipal(request, env);
  return principal && principal.type !== 'anonymous' ? principal : null;
}

async function liveFolder(db: Db, principal: Principal, id: unknown): Promise<FolderAccess | null> {
  if (typeof id !== 'string' || !id) return null;
  const access = await resolveFolderAccess(db, principal, id);
  return access && !access.deleted ? access : null;
}

const folderRecord = async (db: Db, id: string) => {
  const [row] = await db.select({ id: folders.id, name: folders.name, parentId: folders.parentId, createdAt: folders.createdAt })
    .from(folders).where(eq(folders.id, id)).limit(1);
  return row;
};

async function createFolder(request: Request, env: FoldersEnv): Promise<Response> {
  const principal = await signedIn(request, env);
  if (!principal) return unauthenticated();
  const body = await readJsonObject(request);
  if (!body) return refuse(400, 'bad-request', 'The request body must be a JSON object.');
  const db = createDb(env.DB);
  const parent = await liveFolder(db, principal, body.parentId);
  if (!parent) return folderNotFound();
  if (!roleAtLeast(parent.role, 'editor')) return refuse(403, 'forbidden', 'You can view this folder but not add folders to it.');
  const named = folderName(body.name);
  if ('problem' in named) return refuse(400, 'bad-name', named.problem);
  const chain = await folderChain(db, body.parentId as string);
  if (chain.length >= MAX_FOLDER_DEPTH) return tooDeep();
  const id = crypto.randomUUID();
  try {
    const inserted = await env.DB.prepare(`WITH RECURSIVE ${upFrom(1)}
      INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at)
      SELECT ?2, ?3, ?4, ?5, 'folder', ?1, ?6
      WHERE ${liveIn(7)} AND (SELECT count(*) FROM up) < ${MAX_FOLDER_DEPTH}`)
      .bind(body.parentId, id, parent.ownerUserId, principal.id, named.name, Date.now(), chain.at(-1)).run();
    // The parent was trashed or nested deeper in the meantime.
    if (!changed(inserted)) return (await liveFolder(db, principal, body.parentId)) ? tooDeep() : folderNotFound();
  } catch (error) {
    if (isUnique(error)) return exists(named.name);
    throw error;
  }
  await notify(env, await collectRecipients(env.DB, { folderIds: [id] }));
  return json({ folder: await folderRecord(db, id), role: parent.role }, 201, NO_STORE);
}

async function updateFolder(request: Request, env: FoldersEnv, id: string): Promise<Response> {
  const principal = await signedIn(request, env);
  if (!principal) return unauthenticated();
  const body = await readJsonObject(request);
  if (!body || (!('name' in body) && !('parentId' in body))) return refuse(400, 'bad-request', 'Send a new name or a new parent folder.');
  const db = createDb(env.DB);
  const folder = await liveFolder(db, principal, id);
  if (!folder) return folderNotFound();
  if (folder.kind === 'vault') return refuse(409, 'vault', 'This is a vault, not a folder, so it can’t be renamed or moved here.');
  if (!roleAtLeast(folder.role, 'editor')) return refuse(403, 'forbidden', 'You can view this folder but not change it.');
  const [current] = await db.select({ name: folders.name, parentId: folders.parentId }).from(folders).where(eq(folders.id, id));
  let name = current.name;
  if ('name' in body) {
    const named = folderName(body.name);
    if ('problem' in named) return refuse(400, 'bad-name', named.problem);
    name = named.name;
  }
  let parentId = current.parentId as string;
  let vault: string | undefined;
  const recipients: Recipients = new Map();
  if ('parentId' in body && body.parentId !== current.parentId) {
    if (!can(folder.role, 'manage')) return ownerMoves('folders');
    const target = await liveFolder(db, principal, body.parentId);
    if (!target) return folderNotFound();
    if (!roleAtLeast(target.role, 'editor')) return refuse(403, 'forbidden', 'You can view that folder but not move folders into it.');
    vault = await vaultOf(db, id);
    if (target.ownerUserId !== folder.ownerUserId || (await vaultOf(db, body.parentId as string)) !== vault) {
      return refuse(409, 'other-vault', 'Folders can only move within their own vault.');
    }
    const moved = await subtree(env.DB, id);
    if (moved.some((row) => row.id === body.parentId)) return refuse(409, 'cycle', 'A folder can’t move inside itself.');
    const height = Math.max(...moved.map((row) => row.depth));
    if ((await folderChain(db, body.parentId as string)).length + height > MAX_FOLDER_DEPTH) return tooDeep();
    parentId = body.parentId as string;
    // Whoever loses sight of the subtree hears about it too.
    await collectRecipients(env.DB, { folderIds: moved.map((row) => row.id) }, recipients);
  }
  const moving = parentId !== current.parentId;
  // Only a sent name is written, so a move can't undo a rename that lands between its read and its write.
  const newName = 'name' in body ? name : null;
  try {
    if (!moving) {
      if (newName !== null) await db.update(folders).set({ name: newName }).where(and(eq(folders.id, id), isNull(folders.deletedAt)));
    } else {
      // The target's live ancestry, the cycle check and the depth bound hold at the moment of the write.
      const updated = await env.DB.prepare(`WITH RECURSIVE ${upFrom(1)},
        sub(id, depth) AS (
          SELECT id, 1 FROM folders WHERE id = ?2
          UNION ALL SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id
            WHERE f.deleted_at IS NULL AND s.depth <= ${MAX_FOLDER_DEPTH}
        )
        UPDATE folders SET name = coalesce(?3, name), parent_id = ?1
        WHERE id = ?2 AND deleted_at IS NULL AND ${liveIn(4)}
          AND NOT EXISTS (SELECT 1 FROM up WHERE id = ?2)
          AND (SELECT count(*) FROM up) + (SELECT max(depth) FROM sub) <= ${MAX_FOLDER_DEPTH}`)
        .bind(parentId, id, newName, vault).run();
      if (!changed(updated)) return refuseStaleMove(db, principal, id, parentId);
    }
  } catch (error) {
    if (isUnique(error)) return exists(name);
    throw error;
  }
  const touched = moving ? (await subtree(env.DB, id)).map((row) => row.id) : [id];
  await notify(env, await collectRecipients(env.DB, { folderIds: touched }, recipients));
  return json({ folder: await folderRecord(db, id) }, 200, NO_STORE);
}

/** Why a move whose checks passed changed nothing: the tree moved under it between the read and the write. */
async function refuseStaleMove(db: Db, principal: Principal, id: string, parentId: string): Promise<Response> {
  if (!(await liveFolder(db, principal, id)) || !(await liveFolder(db, principal, parentId))) return folderNotFound();
  if ((await folderChain(db, parentId)).includes(id)) return refuse(409, 'cycle', 'A folder can’t move inside itself.');
  return tooDeep();
}

/** Closes every doc of a trash batch on its DocDO (A§5.1 trash); false when one did not answer. */
async function closeDocs(env: FoldersEnv, docIds: string[]): Promise<boolean> {
  const results = await Promise.allSettled(docIds.map(async (docId) => (await getServerByName(env.DocDO, docId)).trash()));
  const failed = results.filter((result) => result.status === 'rejected');
  for (const failure of failed) console.error('DocDO trash failed', (failure as PromiseRejectedResult).reason);
  return failed.length === 0;
}

async function trashFolder(request: Request, env: FoldersEnv, id: string): Promise<Response> {
  const principal = await signedIn(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const folder = await resolveFolderAccess(db, principal, id);
  if (!folder) return folderNotFound();
  if (folder.kind === 'vault') return refuse(409, 'vault', 'A vault can’t be moved to Trash from here.');
  const [row] = await db.select({ batch: folders.trashBatchId }).from(folders).where(eq(folders.id, id));
  // A retry by the owner re-closes the batch's docs; anyone else, or a folder trashed inside a larger batch, gets 404.
  if (folder.deleted && (folder.role !== 'owner' || !row?.batch)) return folderNotFound();
  if (folder.role !== 'owner') return refuse(403, 'forbidden', 'Only the owner can move this folder to Trash.');

  const batch = row?.batch ?? crypto.randomUUID();
  if (!folder.deleted) {
    const now = Date.now();
    // The subtree is read inside the write, so a folder created or a note moved in just before is in the batch.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE sub(id, depth) AS (
          SELECT id, 1 FROM folders WHERE id = ?3 AND deleted_at IS NULL
          UNION ALL SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id
            WHERE f.deleted_at IS NULL AND s.depth <= ${MAX_FOLDER_DEPTH}
        ) UPDATE folders SET deleted_at = ?1, trash_batch_id = ?2 WHERE id IN (SELECT id FROM sub)`)
        .bind(now, batch, id),
      env.DB.prepare('UPDATE docs SET deleted_at = ?1, trash_batch_id = ?2 WHERE folder_id IN (SELECT id FROM folders WHERE trash_batch_id = ?2) AND deleted_at IS NULL')
        .bind(now, batch),
    ]);
  }
  const [docIds, folderIds] = await Promise.all([
    db.select({ id: docs.id }).from(docs).where(eq(docs.trashBatchId, batch)).then((rows) => rows.map((r) => r.id)),
    db.select({ id: folders.id }).from(folders).where(eq(folders.trashBatchId, batch)).then((rows) => rows.map((r) => r.id)),
  ]);
  const closed = await closeDocs(env, docIds);
  if (!folder.deleted) await notify(env, await collectRecipients(env.DB, { docIds, folderIds }));
  if (!closed) return refuse(503, 'unavailable', 'The folder is in Trash, but some open notes haven’t closed yet. Try again.');
  return json({ trashBatchId: batch, docIds, folderIds }, 200, NO_STORE);
}

/** PATCH /api/docs/:id {folderId}: a note moves within its vault, keeping its filename unless the folder has it. */
export async function moveDoc(request: Request, env: FoldersEnv, docId: string, folderId: unknown): Promise<Response> {
  const principal = await signedIn(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const seen = await resolveDocAccess(db, principal, docId, shareTokenOf(request));
  if (!seen || seen.deleted) return notFound();
  // Authority to move comes from ownership alone: a link only decides whether the refusal may say so.
  const access = await resolveDocAccess(db, principal, docId);
  if (!access || !can(access.role, 'manage')) return ownerMoves('notes');
  const target = await liveFolder(db, principal, folderId);
  if (!target) return folderNotFound();
  if (!roleAtLeast(target.role, 'editor')) return refuse(403, 'forbidden', 'You can view that folder but not move notes into it.');
  const vault = await vaultOf(db, access.folderId);
  if (target.ownerUserId !== access.ownerUserId || (await vaultOf(db, folderId as string)) !== vault) {
    return refuse(409, 'other-vault', 'Notes can only move within their own vault.');
  }
  const recipients = await collectRecipients(env.DB, { docIds: [docId] });
  if (access.folderId !== folderId) {
    for (let attempt = 1; ; attempt += 1) {
      const [doc] = await db.select({ title: docs.title, filename: docs.filename }).from(docs).where(eq(docs.id, docId));
      const taken = await db.select({ filename: docs.filename }).from(docs)
        .where(and(eq(docs.folderId, folderId as string), isNull(docs.deletedAt), sql`${docs.id} <> ${docId}`));
      const occupied = new Set(taken.map((row) => row.filename));
      // The title projection owns filenames; a move only steps aside from a name the folder already holds.
      const filename = occupied.has(doc.filename) ? filenameFor(doc.title, occupied) : doc.filename;
      try {
        // The destination must still be live in the vault when the note lands (a trash may be under way).
        const moved = await env.DB.prepare(`WITH RECURSIVE ${upFrom(1)}
          UPDATE docs SET folder_id = ?1, filename = ?2 WHERE id = ?3 AND deleted_at IS NULL AND ${liveIn(4)}`)
          .bind(folderId, filename, docId, vault).run();
        if (!changed(moved)) return folderNotFound();
        break;
      } catch (error) {
        if (!isUnique(error) || attempt >= 5) throw error;
      }
    }
  }
  await notify(env, await collectRecipients(env.DB, { docIds: [docId] }, recipients));
  const [doc] = await db
    .select({ id: docs.id, folderId: docs.folderId, title: docs.title, filename: docs.filename, createdAt: docs.createdAt, updatedAt: docs.updatedAt })
    .from(docs).where(eq(docs.id, docId));
  return json({ doc, role: access.role }, 200, NO_STORE);
}

const FOLDER = /^\/api\/folders\/([^/]+)$/;
const MEMBERS = /^\/api\/folders\/([^/]+)\/members$/;
const LINKS = /^\/api\/folders\/([^/]+)\/links(?:\/([^/]+))?$/;

/** GET /api/folders/:id: the folder, and the vault around it unless the caller holds only a link to it. */
async function readFolder(request: Request, env: FoldersEnv, folderId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const access = await resolveFolderAccess(db, principal, folderId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  // A link holder sees the folder it was handed, never the vault around it.
  const folder = { id: folderId, name: access.name, kind: access.kind, ...(access.linkOnly ? {} : { vaultId: await vaultOf(db, folderId) }) };
  return json({ folder, role: access.role }, 200, NO_STORE);
}

/** `/api/folders` and everything under it. */
export function handleFolderRoutes(request: Request, env: FoldersEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/folders') {
    return request.method === 'POST' ? createFolder(request, env) : Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: 'POST' }));
  }
  const folder = FOLDER.exec(pathname);
  if (folder) {
    if (request.method === 'GET') return readFolder(request, env, folder[1]);
    if (request.method === 'PATCH') return updateFolder(request, env, folder[1]);
    if (request.method === 'DELETE') return trashFolder(request, env, folder[1]);
    return Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: 'GET, PATCH, DELETE' }));
  }
  const members = MEMBERS.exec(pathname);
  if (members) return handleMembers(request, env, { type: 'folder', id: members[1] });
  const links = LINKS.exec(pathname);
  if (links) return handleLinks(request, env, { type: 'folder', id: links[1] }, links[2] ?? null);
  return Promise.resolve(json({ error: 'not-found' }, 404));
}
