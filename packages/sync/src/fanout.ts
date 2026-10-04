import { getServerByName } from 'partyserver';
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import type { PrincipalDO } from './principal-do.ts';

export interface FanoutEnv {
  DB: D1Database;
  PrincipalDO: DurableObjectNamespace<PrincipalDO>;
}

/** Discovery access, including trash recipients. Link-only readers must never discover siblings. */
export async function principalsWithAccess(db: D1Database, docId: string): Promise<string[]> {
  const rows = await db.prepare(`WITH RECURSIVE chain(id, parent_id, depth) AS (
    SELECT f.id, f.parent_id, 1 FROM folders f JOIN docs d ON d.folder_id = f.id WHERE d.id = ?1
    UNION ALL SELECT f.id, f.parent_id, c.depth + 1 FROM folders f JOIN chain c ON f.id = c.parent_id WHERE c.depth < 11
  ), recipients(id) AS (
    SELECT owner_user_id FROM docs WHERE id = ?1
    UNION SELECT principal_id FROM doc_members WHERE doc_id = ?1
    UNION SELECT principal_id FROM folder_members WHERE folder_id IN (SELECT id FROM chain)
  ) SELECT id FROM recipients
    UNION SELECT a.id FROM agents a JOIN recipients r ON a.owner_user_id = r.id WHERE a.revoked_at IS NULL`)
    .bind(docId).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function publishTo(env: FanoutEnv, principalId: string, event: WorkspaceEvent): Promise<void> {
  const principal = await getServerByName(env.PrincipalDO, principalId);
  await principal.publish(event);
}

/** Each recipient receives only the changed ids they can discover, never a vault-wide batch. */
export async function publishMeta(env: FanoutEnv, docIds: string[]): Promise<void> {
  const recipients = new Map<string, string[]>();
  for (const docId of new Set(docIds)) {
    for (const principalId of await principalsWithAccess(env.DB, docId)) {
      const ids = recipients.get(principalId) ?? [];
      ids.push(docId);
      recipients.set(principalId, ids);
    }
  }
  await Promise.all([...recipients].map(([id, ids]) => publishTo(env, id, { type: 'meta', docIds: ids, folderIds: [] })));
}
