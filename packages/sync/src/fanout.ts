import { getServerByName } from 'partyserver';
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import type { PrincipalDO } from './principal-do.ts';

export interface FanoutEnv {
  DB: D1Database;
  PrincipalDO: DurableObjectNamespace<PrincipalDO>;
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
