// Trash and restore (A§8, A§11; PRODUCT Notes): DELETE /api/docs/:id sends a note to Trash, POST
// /api/docs/:id/restore brings it back, and GET /api/trash/:id is the one owner read path for a trashed note (its
// Trash view). Only the owner trashes and restores, on ownership alone, never on a grant or a share link; a link
// only decides whether a refusal may say so. D1 is the one source of truth, and the DocDO fails closed (A§8): a trash
// holds the doc closed (every socket 4410) before the row is stamped, then settles the doc from the row; a restore
// clears the row before the doc settles open. A step that fails leaves the doc closed or the row unchanged, never a
// live doc behind a trashed row. Everyone who could see the note hears about either change.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getServerByName } from 'partyserver';
import { availableFilename } from '@moss-multi/core/filenames';
import { can } from '@moss-multi/protocol/roles';
import { TRASHED_ACTION } from '@moss-multi/protocol/retention';
import { collectRecipients, publishRecipients, type FanoutEnv } from '@moss-multi/sync/fanout';
import { resolvePrincipal, shareTokenOf, type Principal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs, folders } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { folderChain, resolveDocAccess, type DocAccess } from './access.ts';
import type { FoldersEnv } from './folders.ts';
import { NO_STORE, notFound, unauthenticated } from './respond.ts';

const refuse = (status: number, error: string, message: string) => json({ error, message }, status, NO_STORE);

async function signedIn(request: Request, env: FoldersEnv): Promise<Principal | null> {
  const principal = await resolvePrincipal(request, env);
  return principal && principal.type !== 'anonymous' ? principal : null;
}

/**
 * The one owner read path for a trashed note (A§8): the caller manages it by ownership alone. Every owner GET of a
 * trashed note goes through here; everyone else, and every mutation but restore, meets the one 404.
 */
export async function ownerOfTrashed(db: Db, principal: Principal, docId: string): Promise<DocAccess | null> {
  const access = await resolveDocAccess(db, principal, docId);
  return access?.deleted && can(access.role, 'manage') ? access : null;
}

/** A committed change is never failed by its notification (T2.1). */
async function notify(env: FoldersEnv, docId: string): Promise<void> {
  if (!env.PrincipalDO) return;
  try {
    await publishRecipients({ DB: env.DB, PrincipalDO: env.PrincipalDO } as FanoutEnv, await collectRecipients(env.DB, { docIds: [docId] }));
  } catch (error) {
    console.error('workspace trash notification failed', error);
  }
}

const unavailable = (message: string) => refuse(503, 'unavailable', message);

/** A settle whose failure leaves the doc as it was: held closed, or reopened at its next admission (A§8). */
async function settleQuietly(stub: { settle(hold?: string): Promise<unknown> }, hold?: string): Promise<boolean> {
  try {
    await stub.settle(hold);
    return true;
  } catch (error) {
    console.error('DocDO settle failed', error);
    return false;
  }
}

/** DELETE /api/docs/:id: the owner's note goes to Trash; a repeat by the owner re-closes it. */
export async function trashDoc(request: Request, env: FoldersEnv, docId: string): Promise<Response> {
  const principal = await signedIn(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const seen = await resolveDocAccess(db, principal, docId, shareTokenOf(request));
  const owned = await ownerOfTrashed(db, principal, docId);
  if (!seen || (seen.deleted && !owned)) return notFound();
  const stub = await getServerByName(env.DocDO, docId);
  if (!seen.deleted) {
    // Authority comes from ownership alone: a link only decides whether the refusal may say so.
    const access = await resolveDocAccess(db, principal, docId);
    if (!access || !can(access.role, 'manage')) return refuse(403, 'forbidden', 'Only the note’s owner can move it to Trash.');
    const batch = crypto.randomUUID();
    try {
      await stub.trash(batch);
    } catch (error) {
      console.error('DocDO trash failed', error);
      await settleQuietly(stub, batch);
      return unavailable('The note couldn’t be moved to Trash right now. Try again.');
    }
    try {
      await db.update(docs).set({ deletedAt: Date.now(), trashBatchId: batch }).where(and(eq(docs.id, docId), isNull(docs.deletedAt)));
    } catch (error) {
      console.error('trash write failed', error);
      await settleQuietly(stub, batch);
      return unavailable('The note couldn’t be moved to Trash right now. Try again.');
    }
    await notify(env, docId);
    // A settle that fails leaves the hold, which keeps the doc closed until the DocDO's alarm settles it.
    await settleQuietly(stub, batch);
  } else if (!(await settleQuietly(stub))) {
    return unavailable('The note is in Trash, but it hasn’t closed for everyone yet. Try again.');
  }
  const [row] = await db.select({ deletedAt: docs.deletedAt }).from(docs).where(eq(docs.id, docId));
  return json({ doc: { id: docId, trashedAt: row?.deletedAt ?? null }, ...TRASHED_ACTION }, 200, NO_STORE);
}

/** The live folder a restored note returns to: its own when it is live in its vault, else the vault's root. */
async function homeFor(db: Db, folderId: string): Promise<string | null> {
  const chain = await folderChain(db, folderId);
  const rows = await db.select({ id: folders.id, kind: folders.kind, deletedAt: folders.deletedAt }).from(folders)
    .where(sql`${folders.id} IN (${sql.join(chain.map((id) => sql`${id}`), sql`, `)})`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const vault = byId.get(chain.at(-1) ?? '');
  if (vault?.kind !== 'vault' || vault.deletedAt !== null) return null;
  return chain.every((id) => byId.get(id)?.deletedAt === null) ? folderId : vault.id;
}

const isUnique = (error: unknown) => /UNIQUE/i.test(`${error} ${(error as { cause?: unknown })?.cause ?? ''}`);

/** POST /api/docs/:id/restore: the owner's note comes back where it can live, under a free filename. */
export async function restoreDoc(request: Request, env: FoldersEnv, docId: string): Promise<Response> {
  const principal = await signedIn(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const access = await resolveDocAccess(db, principal, docId);
  if (!access || !can(access.role, 'manage')) return notFound();
  if (access.deleted) {
    const folderId = await homeFor(db, access.folderId);
    if (!folderId) return notFound();
    for (let attempt = 1; ; attempt += 1) {
      const [doc] = await db.select({ filename: docs.filename }).from(docs).where(eq(docs.id, docId));
      const taken = await db.select({ filename: docs.filename }).from(docs)
        .where(and(eq(docs.folderId, folderId), isNull(docs.deletedAt), sql`${docs.id} <> ${docId}`));
      const occupied = new Set(taken.map((row) => row.filename));
      const filename = occupied.has(doc.filename) ? availableFilename(doc.filename.replace(/\.md$/, ''), occupied) : doc.filename;
      try {
        await db.update(docs).set({ deletedAt: null, trashBatchId: null, folderId, filename }).where(eq(docs.id, docId));
        break;
      } catch (error) {
        if (isUnique(error) && attempt < 5) continue;
        console.error('restore write failed', error);
        return unavailable('The note couldn’t be restored right now. Try again.');
      }
    }
    await notify(env, docId);
    // The row is live first, so the doc never admits a socket the row refuses; a settle that fails here leaves the
    // doc closed until its next admission settles it from the row.
    await settleQuietly(await getServerByName(env.DocDO, docId));
  }
  const [doc] = await db
    .select({ id: docs.id, folderId: docs.folderId, title: docs.title, filename: docs.filename, createdAt: docs.createdAt, updatedAt: docs.updatedAt })
    .from(docs).where(eq(docs.id, docId));
  return json({ doc, role: access.role }, 200, NO_STORE);
}

/** GET /api/trash/:id: the owner's trashed note and its markdown, for the read-only Trash view. */
export async function readTrashed(request: Request, env: FoldersEnv, docId: string): Promise<Response> {
  const principal = await signedIn(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  if (!(await ownerOfTrashed(db, principal, docId))) return notFound();
  const [doc] = await db
    .select({ id: docs.id, folderId: docs.folderId, title: docs.title, createdAt: docs.createdAt, updatedAt: docs.updatedAt, trashedAt: docs.deletedAt })
    .from(docs).where(eq(docs.id, docId));
  if (!doc) return notFound();
  const markdown = await (await getServerByName(env.DocDO, docId)).exportMarkdown();
  return json({ doc, markdown }, 200, NO_STORE);
}

/** `/api/trash/:id`. */
export function handleTrash(request: Request, env: FoldersEnv): Promise<Response> {
  const match = /^\/api\/trash\/([^/]+)$/.exec(new URL(request.url).pathname);
  if (!match) return Promise.resolve(notFound());
  if (request.method !== 'GET') return Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: 'GET' }));
  return readTrashed(request, env, decodeURIComponent(match[1]));
}
