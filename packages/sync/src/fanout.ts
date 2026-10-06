import { getServerByName } from 'partyserver';
import { ROLES, type Role } from '@moss-multi/protocol/roles';
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import type { DocDO, RecheckInput } from './doc-do.ts';
import type { PrincipalDO } from './principal-do.ts';

export interface FanoutEnv {
  DB: D1Database;
  PrincipalDO: DurableObjectNamespace<PrincipalDO>;
}

/** The kick path reaches DocDOs. */
export interface KickEnv {
  DB: D1Database;
  DocDO: DurableObjectNamespace<DocDO>;
}

/** A recipient DocDO did not acknowledge a recheck; the caller answers 503 so the owner can retry (A§8). */
export class KickFailed extends Error {
  constructor(readonly docIds: string[]) {
    super(`${docIds.length} doc(s) did not acknowledge the recheck`);
    this.name = 'KickFailed';
  }
}

/** The ids each principal hears about, in the order they changed. */
export type Recipients = Map<string, { docIds: Set<string>; folderIds: Set<string> }>;

const AGENTS_OF_RECIPIENTS = `SELECT id FROM recipients
    UNION SELECT a.id FROM agents a JOIN recipients r ON a.owner_user_id = r.id WHERE a.revoked_at IS NULL`;

/** Discovery access, including trash recipients. Link-only readers must never discover siblings. */
export async function principalsWithAccess(db: D1Database, docId: string): Promise<string[]> {
  const rows = await db.prepare(`WITH RECURSIVE chain(id, parent_id, depth) AS (
    SELECT f.id, f.parent_id, 1 FROM folders f JOIN docs d ON d.folder_id = f.id WHERE d.id = ?1
    UNION ALL SELECT f.id, f.parent_id, c.depth + 1 FROM folders f JOIN chain c ON f.id = c.parent_id WHERE c.depth < 11
  ), recipients(id) AS (
    SELECT owner_user_id FROM docs WHERE id = ?1
    UNION SELECT principal_id FROM doc_members WHERE doc_id = ?1
    UNION SELECT principal_id FROM folder_members WHERE folder_id IN (SELECT id FROM chain)
  ) ${AGENTS_OF_RECIPIENTS}`)
    .bind(docId).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/** Who can discover a folder: its vault's owner and the grantees on it or an ancestor, with their agents. */
export async function principalsWithFolderAccess(db: D1Database, folderId: string): Promise<string[]> {
  const rows = await db.prepare(`WITH RECURSIVE chain(id, parent_id, depth) AS (
    SELECT id, parent_id, 1 FROM folders WHERE id = ?1
    UNION ALL SELECT f.id, f.parent_id, c.depth + 1 FROM folders f JOIN chain c ON f.id = c.parent_id WHERE c.depth < 11
  ), recipients(id) AS (
    SELECT owner_user_id FROM folders WHERE id = ?1
    UNION SELECT principal_id FROM folder_members WHERE folder_id IN (SELECT id FROM chain)
  ) ${AGENTS_OF_RECIPIENTS}`)
    .bind(folderId).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/**
 * Adds everyone who can discover each changed doc or folder now. A move is collected before and after it, so the
 * people who lose sight of an item hear about it as well as those who gain it.
 */
export async function collectRecipients(
  db: D1Database, change: { docIds?: Iterable<string>; folderIds?: Iterable<string> }, into: Recipients = new Map(),
): Promise<Recipients> {
  const entry = (principalId: string) => {
    const ids = into.get(principalId) ?? { docIds: new Set<string>(), folderIds: new Set<string>() };
    into.set(principalId, ids);
    return ids;
  };
  for (const docId of new Set(change.docIds ?? [])) {
    for (const principalId of await principalsWithAccess(db, docId)) entry(principalId).docIds.add(docId);
  }
  for (const folderId of new Set(change.folderIds ?? [])) {
    for (const principalId of await principalsWithFolderAccess(db, folderId)) entry(principalId).folderIds.add(folderId);
  }
  return into;
}

export async function publishTo(env: FanoutEnv, principalId: string, event: WorkspaceEvent): Promise<void> {
  const principal = await getServerByName(env.PrincipalDO, principalId);
  await principal.publish(event);
}

/** One `meta` event per recipient, naming only the ids that recipient can discover. */
export async function publishRecipients(env: FanoutEnv, recipients: Recipients): Promise<void> {
  await Promise.all([...recipients].map(([id, ids]) =>
    publishTo(env, id, { type: 'meta', docIds: [...ids.docIds], folderIds: [...ids.folderIds] })));
}

/** Each recipient receives only the changed ids they can discover, never a vault-wide batch. */
export async function publishMeta(env: FanoutEnv, docIds: string[]): Promise<void> {
  await publishRecipients(env, await collectRecipients(env.DB, { docIds }));
}

/** Folder levels a subtree query walks, as the resolver does (A§8). */
const DEPTH = 11;

/**
 * The DocDOs a grant or link on `target` reaches (A§8 Recipients): the doc itself, or every live doc in the folder's
 * live subtree (one folder-tree query); a vault is a folder.
 */
export async function docsOf(db: D1Database, target: { type: 'doc' | 'folder'; id: string }): Promise<string[]> {
  if (target.type === 'doc') return [target.id];
  const rows = await db.prepare(`WITH RECURSIVE sub(id, depth) AS (
      SELECT id, 1 FROM folders WHERE id = ?1 AND deleted_at IS NULL
      UNION ALL SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id
        WHERE f.deleted_at IS NULL AND s.depth <= ${DEPTH}
    ) SELECT d.id AS id FROM docs d JOIN sub ON d.folder_id = sub.id WHERE d.deleted_at IS NULL`).bind(target.id).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/** A person's live agents act with that person's access, so whatever lowers the person lowers them too (A§8). */
export async function withAgents(db: D1Database, principalIds: string[]): Promise<string[]> {
  if (principalIds.length === 0) return [];
  const rows = await db.prepare(`SELECT id FROM agents WHERE revoked_at IS NULL AND owner_user_id IN (${principalIds.map(() => '?').join(', ')})`)
    .bind(...principalIds).all<{ id: string }>();
  return [...new Set([...principalIds, ...rows.results.map((row) => row.id)])];
}

/**
 * The one kick path (A§8): an awaited recheck on every recipient DocDO, which persists the revocation (waking a
 * hibernated DO) and closes what it names. Call it after the change commits, with `at` taken then, so a socket whose
 * role was resolved before the commit is refused. Throws KickFailed naming the docs that did not acknowledge.
 */
export async function kick(env: KickEnv, docIds: string[], revocation: Omit<RecheckInput, 'at'>, at = Date.now()): Promise<void> {
  const empty = !revocation.everyone && !revocation.principalIds?.length && !revocation.tokens?.length && !revocation.sessions?.length;
  if (empty || docIds.length === 0) return;
  const unique = [...new Set(docIds)];
  const results = await Promise.allSettled(unique.map(async (docId) => {
    const stub = await getServerByName(env.DocDO, docId);
    await stub.recheck({ ...revocation, at });
  }));
  const failed = unique.filter((_, i) => results[i].status === 'rejected');
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') console.error(`DocDO recheck failed for ${unique[i]}`, result.reason);
  }
  if (failed.length > 0) throw new KickFailed(failed);
}

/** Sign-out (A§7): the session's PrincipalDO rechecks every doc it opened and closes its workspace sockets. */
export async function endSession(env: FanoutEnv, principalId: string, sessionId: string): Promise<void> {
  const principal = await getServerByName(env.PrincipalDO, principalId);
  await principal.endSession(sessionId);
}

/** An agent key's revocation (A§8) reaches the agent's PrincipalDO registry. */
export async function revokeAgentKey(env: FanoutEnv, agentId: string): Promise<void> {
  const principal = await getServerByName(env.PrincipalDO, agentId);
  await principal.revokePrincipal();
}

/** Who reaches a doc through grants and links, and at what role, for comparing before and after a move. */
export interface DocReach {
  roles: Map<string, Role>;
  tokens: Set<string>;
}

const rank = (role: string) => ROLES.indexOf(role as Role);

/** The grants (owner, doc and folder chain) and live links that reach each doc, read in one pass per doc. */
export async function reachOf(db: D1Database, docIds: string[]): Promise<Map<string, DocReach>> {
  const reach = new Map<string, DocReach>();
  for (const docId of new Set(docIds)) {
    const chain = `WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT f.id, f.parent_id, 1 FROM folders f JOIN docs d ON d.folder_id = f.id WHERE d.id = ?1
      UNION ALL SELECT f.id, f.parent_id, c.depth + 1 FROM folders f JOIN chain c ON f.id = c.parent_id WHERE c.depth < ${DEPTH}
    )`;
    const [grants, links] = await db.batch<{ principal_id?: string; role?: string; token?: string }>([
      db.prepare(`${chain} SELECT owner_user_id AS principal_id, 'owner' AS role FROM docs WHERE id = ?1
        UNION ALL SELECT principal_id, role FROM doc_members WHERE doc_id = ?1
        UNION ALL SELECT principal_id, role FROM folder_members WHERE folder_id IN (SELECT id FROM chain)`).bind(docId),
      db.prepare(`${chain} SELECT token FROM share_links WHERE revoked_at IS NULL
        AND ((target_type = 'doc' AND target_id = ?1) OR (target_type = 'folder' AND target_id IN (SELECT id FROM chain)))`).bind(docId),
    ]);
    const roles = new Map<string, Role>();
    for (const row of grants.results) {
      if (!row.principal_id || !row.role || rank(row.role) < 0) continue;
      if (rank(row.role) > rank(roles.get(row.principal_id) ?? '')) roles.set(row.principal_id, row.role as Role);
    }
    reach.set(docId, { roles, tokens: new Set(links.results.flatMap((row) => (row.token ? [row.token] : []))) });
  }
  return reach;
}

/**
 * After a move: everyone whose grant role on a doc fell or vanished, with their agents, and every link that no longer
 * reaches it, are kicked from that doc (A§8 covered events).
 */
export async function kickLosses(env: KickEnv, before: Map<string, DocReach>, at = Date.now()): Promise<void> {
  const after = await reachOf(env.DB, [...before.keys()]);
  const failed: string[] = [];
  for (const [docId, was] of before) {
    const now = after.get(docId) ?? { roles: new Map(), tokens: new Set() };
    const lowered = [...was.roles].filter(([id, role]) => rank(now.roles.get(id) ?? '') < rank(role)).map(([id]) => id);
    const tokens = [...was.tokens].filter((token) => !now.tokens.has(token));
    try {
      await kick(env, [docId], { principalIds: await withAgents(env.DB, lowered), tokens }, at);
    } catch (error) {
      if (!(error instanceof KickFailed)) throw error;
      failed.push(...error.docIds);
    }
  }
  if (failed.length > 0) throw new KickFailed(failed);
}
