// The one access resolver (A§8): a principal's role on a doc is the MAX of ownership, its grant on the doc, its grants
// on every folder up to the vault, and a presented share link, folded by protocol/roles.ts (the link is a ceiling).
// Agents act with their owner's access, and a grant to the agent itself adds by MAX.
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { foldRole, type Role } from '@moss-multi/protocol/roles';
import type { Principal } from '../auth/principal.ts';
import { inJson, type Db } from '../db/client.ts';
import { docMembers, docs, folderMembers, folders, shareLinks } from '../db/schema.ts';

/** Folder levels from a doc's folder up to its vault that grants and links are read on (A§8). */
export const MAX_FOLDER_DEPTH = 11;

export interface DocAccess {
  role: Role;
  ownerUserId: string;
  folderId: string;
  deleted: boolean;
}

export interface FolderAccess {
  role: Role;
  ownerUserId: string;
  kind: 'folder' | 'vault';
  deleted: boolean;
}

/** The user whose access a principal exercises; null for a share token alone. */
export function actingUserId(principal: Principal): string | null {
  return principal.type === 'user' ? principal.id : principal.type === 'agent' ? principal.ownerUserId : null;
}

/** The ids a grant row may name for this principal: the user, or the agent and the user it acts for. */
function grantees(principal: Principal): string[] {
  return principal.type === 'user' ? [principal.id] : principal.type === 'agent' ? [principal.id, principal.ownerUserId] : [];
}

/** `folderId` and its ancestors, nearest first, at most MAX_FOLDER_DEPTH of them; a cycle or a missing parent ends it. */
async function folderChain(db: Db, folderId: string): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT id, parent_id, 1 FROM folders WHERE id = ${folderId}
      UNION ALL
      SELECT folders.id, folders.parent_id, chain.depth + 1 FROM folders JOIN chain ON folders.id = chain.parent_id
      WHERE chain.depth < ${MAX_FOLDER_DEPTH}
    )
    SELECT id FROM chain ORDER BY depth`);
  return rows.map((row) => row.id);
}

/** Grants on the folders of `chain`, and on the doc when there is one. */
async function grantRoles(db: Db, ids: string[], chain: string[], docId: string | null): Promise<Role[]> {
  if (ids.length === 0) return [];
  const [onDoc, onFolders] = await Promise.all([
    docId === null
      ? []
      : db.select({ role: docMembers.role }).from(docMembers).where(and(eq(docMembers.docId, docId), inArray(docMembers.principalId, ids))),
    chain.length === 0
      ? []
      : db
          .select({ role: folderMembers.role })
          .from(folderMembers)
          .where(and(inArray(folderMembers.folderId, chain), inArray(folderMembers.principalId, ids))),
  ]);
  return [...onDoc, ...onFolders].map((row) => row.role);
}

/** The role of a live link covering the doc (its own link, or one on any folder of its chain), else null. */
async function linkRole(db: Db, token: string | null, docId: string, chain: string[]): Promise<Role | null> {
  if (!token) return null;
  const [link] = await db
    .select({ targetType: shareLinks.targetType, targetId: shareLinks.targetId, role: shareLinks.role })
    .from(shareLinks)
    .where(and(eq(shareLinks.token, token), isNull(shareLinks.revokedAt)))
    .limit(1);
  if (!link) return null;
  const covers = link.targetType === 'doc' ? link.targetId === docId : chain.includes(link.targetId);
  return covers ? link.role : null;
}

/**
 * The caller's role on a doc, or null for a missing doc and for one the caller cannot open, alike. `shareToken` is a
 * link a signed-in caller presented; an anonymous principal carries its own.
 */
export async function resolveDocAccess(db: Db, principal: Principal, docId: string, shareToken: string | null = null): Promise<DocAccess | null> {
  const [doc] = await db
    .select({ ownerUserId: docs.ownerUserId, folderId: docs.folderId, deletedAt: docs.deletedAt })
    .from(docs)
    .where(eq(docs.id, docId))
    .limit(1);
  if (!doc) return null;
  const chain = await folderChain(db, doc.folderId);
  const token = principal.type === 'anonymous' ? principal.shareToken : shareToken;
  const [grants, link] = await Promise.all([grantRoles(db, grantees(principal), chain, docId), linkRole(db, token, docId, chain)]);
  const role = foldRole({ owner: actingUserId(principal) === doc.ownerUserId, grants, link, anonymous: principal.type === 'anonymous' });
  if (role === null) return null;
  return { role, ownerUserId: doc.ownerUserId, folderId: doc.folderId, deleted: doc.deletedAt !== null };
}

/** The caller's role on a folder or vault through ownership and grants on it and its ancestors; null without access. */
export async function resolveFolderAccess(db: Db, principal: Principal, folderId: string): Promise<FolderAccess | null> {
  const [folder] = await db
    .select({ ownerUserId: folders.ownerUserId, kind: folders.kind, deletedAt: folders.deletedAt })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1);
  if (!folder) return null;
  const grants = await grantRoles(db, grantees(principal), await folderChain(db, folderId), null);
  const role = foldRole({ owner: actingUserId(principal) === folder.ownerUserId, grants, link: null, anonymous: principal.type === 'anonymous' });
  if (role === null) return null;
  return { role, ownerUserId: folder.ownerUserId, kind: folder.kind, deleted: folder.deletedAt !== null };
}

/** Batched folder closure for discovery; the same MAX fold and depth bound as individual reads. */
export async function accessibleFolders(db: Db, principal: Principal) {
  const ids = grantees(principal);
  const [rows, grants] = await Promise.all([
    db.select().from(folders),
    ids.length ? db.select().from(folderMembers).where(inArray(folderMembers.principalId, ids)) : [],
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.flatMap((row) => {
    const chain: string[] = [];
    let current: typeof row | undefined = row;
    while (current && chain.length < MAX_FOLDER_DEPTH && !chain.includes(current.id)) {
      if (current.deletedAt !== null) return [];
      chain.push(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    const root = byId.get(chain[chain.length - 1]);
    if (root?.kind !== 'vault') return [];
    const role = foldRole({ owner: actingUserId(principal) === row.ownerUserId,
      grants: grants.filter((grant) => chain.includes(grant.folderId)).map((grant) => grant.role), link: null,
      anonymous: principal.type === 'anonymous' });
    return role ? [{ ...row, role, vaultId: root.id }] : [];
  });
}

/** The discovery closure for lists, search and backlinks (A§8). Link grants do not imply discovery. */
export async function accessibleDocs(db: Db, principal: Principal, folders: Awaited<ReturnType<typeof accessibleFolders>>) {
  const ids = grantees(principal);
  const grants = ids.length ? await db.select().from(docMembers).where(inArray(docMembers.principalId, ids)) : [];
  const folderIds = folders.map((folder) => folder.id);
  const ownerId = actingUserId(principal);
  const rows = await db.select().from(docs).where(and(isNull(docs.deletedAt), or(
    ownerId ? eq(docs.ownerUserId, ownerId) : sql`0`,
    inJson(docs.id, grants.map((grant) => grant.docId)),
    inJson(docs.folderId, folderIds),
  )));
  return rows.flatMap((row) => {
    const folderRole = folders.find((folder) => folder.id === row.folderId)?.role;
    const role = foldRole({ owner: ownerId === row.ownerUserId,
      grants: [...grants.filter((grant) => grant.docId === row.id).map((grant) => grant.role), ...(folderRole ? [folderRole] : [])],
      link: null, anonymous: principal.type === 'anonymous' });
    return role ? [{ ...row, role }] : [];
  });
}
