// The one access resolver (A§8). M0 knows owners only: an agent acts with its owner's access. T1.1 adds doc and
// folder-chain grants and the link ceiling, keeping this signature.
import { eq } from 'drizzle-orm';
import type { Role } from '@moss-multi/protocol/roles';
import type { Principal } from '../auth/principal.ts';
import type { Db } from '../db/client.ts';
import { docs } from '../db/schema.ts';

export interface DocAccess {
  role: Role;
  ownerUserId: string;
  folderId: string;
  deleted: boolean;
}

/** Null for a missing doc and for one the principal cannot open, alike. */
export async function resolveDocAccess(db: Db, principal: Principal, docId: string): Promise<DocAccess | null> {
  const [doc] = await db
    .select({ ownerUserId: docs.ownerUserId, folderId: docs.folderId, deletedAt: docs.deletedAt })
    .from(docs)
    .where(eq(docs.id, docId))
    .limit(1);
  if (!doc) return null;
  const actingUser = principal.type === 'user' ? principal.id : principal.type === 'agent' ? principal.ownerUserId : null;
  if (actingUser !== doc.ownerUserId) return null;
  return { role: 'owner', ownerUserId: doc.ownerUserId, folderId: doc.folderId, deleted: doc.deletedAt !== null };
}
