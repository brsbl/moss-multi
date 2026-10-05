// The DocDO's pull validation (A§8): before any frame applies, the DocDO reads the doc's access epoch and its sockets'
// credentials, and re-resolves each socket admitted under an older epoch through the one resolver (api/access.ts).
import { and, eq, isNull } from 'drizzle-orm';
import type { AccessCheck, SocketIdentity } from '@moss-multi/sync';
import { readStamp } from '@moss-multi/sync/access-epoch';
import { resolveDocAccess } from '../api/access.ts';
import type { Principal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { agents } from '../db/schema.ts';

/** The principal a socket stands for now: an agent only while its key is live. */
async function principalOf(db: Db, socket: SocketIdentity): Promise<Principal | null> {
  if (socket.kind === 'user') {
    return { type: 'user', id: socket.principalId, name: '', email: '', sessionId: socket.sessionId ?? '', credential: 'bearer' };
  }
  if (socket.kind === 'agent') {
    const [agent] = await db.select({ id: agents.id, name: agents.name, ownerUserId: agents.ownerUserId }).from(agents)
      .where(and(eq(agents.id, socket.principalId), isNull(agents.revokedAt))).limit(1);
    return agent ? { type: 'agent', ...agent } : null;
  }
  return socket.shareToken ? { type: 'anonymous', id: 'anonymous', name: 'Anonymous', shareToken: socket.shareToken } : null;
}

export function docAccessCheck(env: { DB: D1Database }): AccessCheck {
  const db = createDb(env.DB);
  return {
    stamp: (docId, sessions, agentIds) => readStamp(env.DB, docId, sessions, agentIds),
    resolve: async (docId, socket) => {
      const principal = await principalOf(db, socket);
      if (!principal) return null;
      // A signed-in socket carries a link only when the link lifted its role, so it is re-resolved with that link.
      const access = await resolveDocAccess(db, principal, docId, principal.type === 'anonymous' ? null : socket.shareToken);
      if (!access) return null;
      return access.deleted ? 'deleted' : access.role;
    },
  };
}
