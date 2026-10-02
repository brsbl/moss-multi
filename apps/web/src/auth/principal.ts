// Who is calling (A§7): an agent key, then a session (bearer or cookie), then a share token alone.
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db/client.ts';
import { agents } from '../db/schema.ts';
import { createAuth, type AuthEnv } from './auth.ts';

export const AGENT_KEY_PREFIX = 'mm_sk_';
export const SHARE_PARAM = 'share';
export const SHARE_HEADER = 'x-moss-share';

export type Principal =
  | { type: 'user'; id: string; name: string; email: string; sessionId: string }
  /** Acts with its owner's access (A§8). */
  | { type: 'agent'; id: string; name: string; ownerUserId: string }
  /** A share-link holder with no session, capped at viewer (A§8). */
  | { type: 'anonymous'; id: 'anonymous'; name: 'Anonymous'; shareToken: string };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function shareTokenOf(request: Request): string | null {
  return new URL(request.url).searchParams.get(SHARE_PARAM) || request.headers.get(SHARE_HEADER) || null;
}

export async function resolvePrincipal(request: Request, env: AuthEnv): Promise<Principal | null> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (bearer?.startsWith(AGENT_KEY_PREFIX)) {
    // A key that is unknown or revoked is a failed credential: no fallback to the cookie or a share token.
    const [agent] = await createDb(env.DB)
      .select({ id: agents.id, name: agents.name, ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.keyHash, await sha256Hex(bearer)), isNull(agents.revokedAt)))
      .limit(1);
    return agent ? { type: 'agent', ...agent } : null;
  }
  if (bearer || request.headers.has('cookie')) {
    const found = await createAuth(env).api.getSession({ headers: request.headers });
    if (found) {
      const { user, session } = found;
      return { type: 'user', id: user.id, name: user.name, email: user.email, sessionId: session.id };
    }
  }
  const shareToken = shareTokenOf(request);
  return shareToken ? { type: 'anonymous', id: 'anonymous', name: 'Anonymous', shareToken } : null;
}
