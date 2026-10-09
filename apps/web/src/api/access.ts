// The one access resolver (A§8): a principal's role on a doc is the MAX of ownership, its grant on the doc, its grants
// on every folder up to the vault, and a presented share link, folded by protocol/roles.ts (the link is a ceiling).
// Agents act with their owner's access, and a grant to the agent itself adds by MAX, but never above editor.
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
  /** Only a presented share link opens it: no ownership and no grant. */
  linkOnly: boolean;
  /** The presented link raised the role above what ownership and grants give. */
  viaLink: boolean;
}

export interface FolderAccess {
  role: Role;
  ownerUserId: string;
  kind: 'folder' | 'vault';
  name: string;
  deleted: boolean;
  /** Only a presented folder link opens it: no ownership and no grant. */
  linkOnly: boolean;
}

/** A live share link by its token, or null for a forged or revoked one. */
export async function liveLink(db: Db, token: string | null) {
  if (!token) return null;
  const [link] = await db
    .select({ targetType: shareLinks.targetType, targetId: shareLinks.targetId, role: shareLinks.role })
    .from(shareLinks)
    .where(and(eq(shareLinks.token, token), isNull(shareLinks.revokedAt)))
    .limit(1);
  return link ?? null;
}

/** The user whose access a principal exercises; null for a share token alone. */
export function actingUserId(principal: Principal): string | null {
  return principal.type === 'user' ? principal.id : principal.type === 'agent' ? principal.ownerUserId : null;
}

/**
 * SQL rows: user `?{user}` and every agent that acts or acted for them (through `agents_owner_idx`), the `created_by`
 * values a per-person bound charges to that user (A§18).
 */
export const actingAs = (user: number) => `(SELECT ?${user} UNION ALL SELECT id FROM agents WHERE owner_user_id = ?${user})`;

/** Live notes made by acting user `?{user}` or their agents, anywhere, through `docs_created_by_idx`. */
export const liveNotesBy = (user: number) =>
  `(SELECT count(*) FROM docs WHERE created_by IN ${actingAs(user)} AND deleted_at IS NULL)`;

/** The ids a grant row may name for this principal: the user, or the agent and the user it acts for. */
export function grantees(principal: Principal): string[] {
  return principal.type === 'user' ? [principal.id] : principal.type === 'agent' ? [principal.id, principal.ownerUserId] : [];
}

/** `folderId` and its ancestors, nearest first, at most MAX_FOLDER_DEPTH of them; a cycle or a missing parent ends it. */
export async function folderChain(db: Db, folderId: string): Promise<string[]> {
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

/** A statement parameter's index (`?N`), or an SQL expression such as an outer row's column. */
type Arg = number | string;
const arg = (value: Arg) => (typeof value === 'number' ? `?${value}` : value);

/**
 * SQL that holds while user `?{user}` manages doc `?{doc}` (A§8): it owns the vault, or holds an `owner` grant on the
 * doc or a folder of its chain. It is `can(resolveDocAccess(user, doc).role, 'manage')` for a signed-in person, so a
 * write that conditions on it loses to a revocation that commits first.
 */
export const managesDoc = (doc: Arg, user: Arg) => `(EXISTS (SELECT 1 FROM docs WHERE id = ${arg(doc)} AND owner_user_id = ${arg(user)})
  OR EXISTS (SELECT 1 FROM doc_members WHERE doc_id = ${arg(doc)} AND principal_id = ${arg(user)} AND role = 'owner')
  OR EXISTS (WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT f.id, f.parent_id, 1 FROM folders f JOIN docs d ON d.folder_id = f.id WHERE d.id = ${arg(doc)}
      UNION ALL SELECT f.id, f.parent_id, chain.depth + 1 FROM folders f JOIN chain ON f.id = chain.parent_id
        WHERE chain.depth < ${MAX_FOLDER_DEPTH}
    ) SELECT 1 FROM folder_members m JOIN chain ON m.folder_id = chain.id WHERE m.principal_id = ${arg(user)} AND m.role = 'owner'))`;

/** SQL that holds while user `?{user}` owns folder `?{folder}`'s vault, or holds a grant whose role matches `roles` (a
 * fixed predicate, never request data) on the folder or one above it. */
const chainHolds = (folder: Arg, user: Arg, roles: "= 'owner'" | "IN ('editor', 'owner')") => `(EXISTS (SELECT 1 FROM folders WHERE id = ${arg(folder)} AND owner_user_id = ${arg(user)})
  OR EXISTS (WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT id, parent_id, 1 FROM folders WHERE id = ${arg(folder)}
      UNION ALL SELECT f.id, f.parent_id, chain.depth + 1 FROM folders f JOIN chain ON f.id = chain.parent_id
        WHERE chain.depth < ${MAX_FOLDER_DEPTH}
    ) SELECT 1 FROM folder_members m JOIN chain ON m.folder_id = chain.id WHERE m.principal_id = ${arg(user)} AND m.role ${roles}))`;

/** SQL that holds while user `?{user}` manages folder `?{folder}`: it owns the vault, or holds an `owner` grant on the
 * folder or one above it (managesDoc's folder half). */
export const managesFolder = (folder: Arg, user: Arg) => chainHolds(folder, user, "= 'owner'");

/** SQL that holds while doc or folder `?{id}` is live and user `?{user}` manages it. */
export const liveAndManaged = (type: 'doc' | 'folder', id: Arg, user: Arg) => type === 'doc'
  ? `EXISTS (SELECT 1 FROM docs WHERE id = ${arg(id)} AND deleted_at IS NULL) AND ${managesDoc(id, user)}`
  : `EXISTS (SELECT 1 FROM folders WHERE id = ${arg(id)} AND deleted_at IS NULL) AND ${managesFolder(id, user)}`;

/** The invites a write can kill: those on a folder's subtree (its docs included), on one doc, or sent by one inviter. */
export type ReapScope = { folderId: string } | { docId: string } | { inviter: string };

/**
 * Withdraws, at ?1, every open invite in `scope` that has died (A§8): its target is gone or in Trash, or its inviter
 * no longer manages it. Each write that trashes, deletes or moves something, or takes a grant away, runs this in its
 * own batch over what it touched, so a death is recorded where it happens and a restore or a regained grant never
 * brings an invite back. A subtree is read inside the statement, so a folder or note added to it just before is in it.
 */
export function reapDeadInvites(db: D1Database, now: number, scope: ReapScope): D1PreparedStatement {
  const [cte, scoped, id] = 'folderId' in scope
    ? [`WITH RECURSIVE sub(id, depth) AS (
        SELECT id, 1 FROM folders WHERE id = ?2
        UNION ALL SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id WHERE s.depth <= ${MAX_FOLDER_DEPTH}
      ) `, `((target_type = 'folder' AND target_id IN (SELECT id FROM sub))
        OR (target_type = 'doc' AND target_id IN (SELECT d.id FROM docs d JOIN sub ON d.folder_id = sub.id)))`, scope.folderId]
    : 'docId' in scope ? ['', `target_type = 'doc' AND target_id = ?2`, scope.docId] : ['', 'invited_by = ?2', scope.inviter];
  return db.prepare(`${cte}UPDATE invites SET revoked_at = ?1
  WHERE ${scoped} AND accepted_at IS NULL AND revoked_at IS NULL AND NOT (CASE target_type
    WHEN 'doc' THEN (${liveAndManaged('doc', 'invites.target_id', 'invites.invited_by')})
    ELSE (${liveAndManaged('folder', 'invites.target_id', 'invites.invited_by')}) END)`).bind(now, id);
}

/** Whether user `userId` manages the live doc or folder `id` now (liveAndManaged, read on its own). */
export async function managesLive(db: D1Database, type: 'doc' | 'folder', id: string, userId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT (${liveAndManaged(type, 1, 2)}) AS ok`).bind(id, userId).first<{ ok: number }>();
  return row?.ok === 1;
}

/** SQL that holds while user `?{user}` may edit in folder `?{folder}`: it owns the vault, or holds an `editor` or
 * `owner` grant on the folder or an ancestor. A move re-checks its destination with it in the same statement. */
export const editsFolder = (folder: number, user: number) => chainHolds(folder, user, "IN ('editor', 'owner')");

/** Who a write stands for, bound into the write's own statement so its guard re-checks it there (editsLiveDoc). */
export interface WriteActor {
  kind: 'user' | 'agent';
  /** The person, or the agent. */
  id: string;
  /** The user whose access it exercises. */
  userId: string;
  /** A person's session; null for an agent, whose credential is its key row. */
  sessionId: string | null;
  shareToken: string | null;
}

/** The actor for a signed-in principal and the link it presented; a share token alone never writes. */
export function writeActor(principal: Principal, shareToken: string | null): WriteActor | null {
  if (principal.type === 'user') return { kind: 'user', id: principal.id, userId: principal.id, sessionId: principal.sessionId, shareToken };
  if (principal.type === 'agent') return { kind: 'agent', id: principal.id, userId: principal.ownerUserId, sessionId: null, shareToken };
  return null;
}

/** editsLiveDoc's six parameters, in order, from `?{at}`. */
export const writeActorArgs = (actor: WriteActor, now: number) =>
  [actor.kind, actor.id, actor.userId, actor.sessionId, actor.shareToken, now] as const;

/**
 * SQL that holds while doc `?{doc}` is live and the actor bound at `?{at}`… (writeActorArgs) can still edit it (A§8):
 * its session or key is live, and it owns the vault, holds an editor or owner grant on the doc or a folder of its
 * chain, or presents a live editor link covering the doc. A write that conditions on it loses to a revocation, a
 * demotion or a trash that commits first, whatever was resolved before the write's body arrived.
 */
export const editsLiveDoc = (doc: Arg, at: number) => {
  const [kind, id, user, session, token, now] = [0, 1, 2, 3, 4, 5].map((n) => `?${at + n}`);
  const d = arg(doc);
  return `(EXISTS (SELECT 1 FROM docs WHERE id = ${d} AND deleted_at IS NULL)
  AND (CASE ${kind}
    WHEN 'user' THEN EXISTS (SELECT 1 FROM session WHERE id = ${session} AND user_id = ${id} AND expires_at > ${now})
    WHEN 'agent' THEN EXISTS (SELECT 1 FROM agents WHERE id = ${id} AND owner_user_id = ${user} AND revoked_at IS NULL)
    ELSE 0 END)
  AND (EXISTS (SELECT 1 FROM docs WHERE id = ${d} AND owner_user_id = ${user})
    OR EXISTS (SELECT 1 FROM doc_members WHERE doc_id = ${d} AND principal_id IN (${id}, ${user}) AND role IN ('editor', 'owner'))
    OR EXISTS (SELECT 1 FROM share_links WHERE token = ${token} AND revoked_at IS NULL AND role = 'editor' AND target_type = 'doc' AND target_id = ${d})
    OR EXISTS (WITH RECURSIVE chain(id, parent_id, depth) AS (
        SELECT f.id, f.parent_id, 1 FROM folders f JOIN docs ON docs.folder_id = f.id WHERE docs.id = ${d}
        UNION ALL SELECT f.id, f.parent_id, chain.depth + 1 FROM folders f JOIN chain ON f.id = chain.parent_id
          WHERE chain.depth < ${MAX_FOLDER_DEPTH}
      ) SELECT 1 FROM chain WHERE
        EXISTS (SELECT 1 FROM folder_members m WHERE m.folder_id = chain.id AND m.principal_id IN (${id}, ${user}) AND m.role IN ('editor', 'owner'))
        OR EXISTS (SELECT 1 FROM share_links l WHERE l.token = ${token} AND l.revoked_at IS NULL AND l.role = 'editor'
          AND l.target_type = 'folder' AND l.target_id = chain.id))))`;
};

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

/** The role of a live link covering the doc (its own link, or one on any folder of its chain), else null. A folder
 * (docId null) is covered only by a link on it or an ancestor. */
async function linkRole(db: Db, token: string | null, docId: string | null, chain: string[]): Promise<Role | null> {
  const link = await liveLink(db, token);
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
  const sources = { owner: actingUserId(principal) === doc.ownerUserId, grants, anonymous: principal.type === 'anonymous', agent: principal.type === 'agent' };
  const role = foldRole({ ...sources, link });
  if (role === null) return null;
  const withoutLink = foldRole({ ...sources, link: null });
  return {
    role, ownerUserId: doc.ownerUserId, folderId: doc.folderId, deleted: doc.deletedAt !== null,
    linkOnly: withoutLink === null, viaLink: withoutLink !== role,
  };
}

/**
 * The caller's role on a folder or vault through ownership and grants on it and its ancestors, and a presented
 * folder link on it or an ancestor (a ceiling, as for docs); null without access.
 */
export async function resolveFolderAccess(db: Db, principal: Principal, folderId: string, shareToken: string | null = null): Promise<FolderAccess | null> {
  const [folder] = await db
    .select({ ownerUserId: folders.ownerUserId, kind: folders.kind, name: folders.name, deletedAt: folders.deletedAt })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1);
  if (!folder) return null;
  const chain = await folderChain(db, folderId);
  const token = principal.type === 'anonymous' ? principal.shareToken : shareToken;
  const [grants, link] = await Promise.all([grantRoles(db, grantees(principal), chain, null), linkRole(db, token, null, chain)]);
  const sources = { owner: actingUserId(principal) === folder.ownerUserId, grants, anonymous: principal.type === 'anonymous', agent: principal.type === 'agent' };
  const role = foldRole({ ...sources, link });
  if (role === null) return null;
  const linkOnly = foldRole({ ...sources, link: null }) === null;
  return { role, ownerUserId: folder.ownerUserId, kind: folder.kind, name: folder.name, deleted: folder.deletedAt !== null, linkOnly };
}

/**
 * The folders discovery folds for a principal: those its acting user owns, those it is granted and their descendants
 * a grant reaches (MAX_FOLDER_DEPTH levels with the granted one), and every ancestor of those within the same bound,
 * which the vault-root and deleted-ancestor checks walk. Nothing from a vault the principal has no part in.
 */
function discoveryRows(db: Db, owner: string | null, ids: string[]) {
  return db.select().from(folders).where(sql`${folders.id} IN (
    WITH RECURSIVE down(id, depth) AS (
      SELECT folder_id, 1 FROM folder_members WHERE principal_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
      UNION SELECT f.id, down.depth + 1 FROM folders f JOIN down ON f.parent_id = down.id WHERE down.depth < ${MAX_FOLDER_DEPTH}
    ), scoped(id) AS (
      SELECT id FROM folders WHERE owner_user_id = ${owner}
      UNION SELECT id FROM down
    ), up(id, parent_id, depth) AS (
      SELECT f.id, f.parent_id, 1 FROM folders f JOIN scoped ON f.id = scoped.id
      UNION SELECT f.id, f.parent_id, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id WHERE up.depth < ${MAX_FOLDER_DEPTH}
    )
    SELECT id FROM up)`);
}

/** Batched folder closure for discovery; the same MAX fold and depth bound as individual reads. */
export async function accessibleFolders(db: Db, principal: Principal) {
  const ids = grantees(principal);
  const owner = actingUserId(principal);
  const [rows, grants] = await Promise.all([
    owner || ids.length ? discoveryRows(db, owner, ids) : [],
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
      anonymous: principal.type === 'anonymous', agent: principal.type === 'agent' });
    return role ? [{ ...row, role, vaultId: root.id }] : [];
  });
}

/**
 * The discovery closure for lists, search and backlinks (A§8), or just the docs `only` names among it, which is all
 * that is read then. Link grants do not imply discovery.
 */
export async function accessibleDocs(db: Db, principal: Principal, folders: Awaited<ReturnType<typeof accessibleFolders>>,
  only: readonly string[] | null = null) {
  const ids = grantees(principal);
  const grants = ids.length ? await db.select().from(docMembers)
    .where(and(inArray(docMembers.principalId, ids), only ? inJson(docMembers.docId, only) : undefined)) : [];
  const folderIds = folders.map((folder) => folder.id);
  const ownerId = actingUserId(principal);
  const rows = await db.select().from(docs).where(and(isNull(docs.deletedAt), only ? inJson(docs.id, only) : undefined, or(
    ownerId ? eq(docs.ownerUserId, ownerId) : sql`0`,
    inJson(docs.id, grants.map((grant) => grant.docId)),
    inJson(docs.folderId, folderIds),
  )));
  return rows.flatMap((row) => {
    const folderRole = folders.find((folder) => folder.id === row.folderId)?.role;
    const role = foldRole({ owner: ownerId === row.ownerUserId,
      grants: [...grants.filter((grant) => grant.docId === row.id).map((grant) => grant.role), ...(folderRole ? [folderRole] : [])],
      link: null, anonymous: principal.type === 'anonymous', agent: principal.type === 'agent' });
    return role ? [{ ...row, role }] : [];
  });
}
