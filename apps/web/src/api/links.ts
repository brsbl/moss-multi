// Share links (T2.4, A§8): an owner creates, lists and revokes revocable tokenized links to a doc, folder or vault at
// viewer, commenter or editor. The link role is a ceiling (roles.ts foldRole): anonymous holders read at viewer and
// signing in lifts them to it. A revoked token answers like a forged one everywhere; closing the connections that
// presented it is the one kick path's (T2.5).
import { and, desc, eq, isNull } from 'drizzle-orm';
import { LINK_ROLES, type LinkRole } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { shareLinks } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { accessTo, type MemberTarget } from './members.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

export interface ShareLink {
  token: string;
  role: LinkRole;
  createdAt: number;
}

const isLinkRole = (value: unknown): value is LinkRole => typeof value === 'string' && (LINK_ROLES as readonly string[]).includes(value);

/** 24 random bytes, hex (A§6). */
const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

const ofTarget = (target: MemberTarget) => and(eq(shareLinks.targetType, target.type), eq(shareLinks.targetId, target.id), isNull(shareLinks.revokedAt));

async function listLinks(db: Db, target: MemberTarget): Promise<ShareLink[]> {
  const rows = await db
    .select({ token: shareLinks.token, role: shareLinks.role, createdAt: shareLinks.createdAt })
    .from(shareLinks)
    .where(ofTarget(target))
    .orderBy(desc(shareLinks.createdAt));
  return rows.flatMap((row) => (isLinkRole(row.role) ? [{ ...row, role: row.role }] : []));
}

/** `/api/{docs,folders}/:id/links` (GET, POST) and `/api/{docs,folders}/:id/links/:token` (DELETE). */
export async function handleLinks(request: Request, env: AuthEnv, target: MemberTarget, token: string | null): Promise<Response> {
  const allowed = token === null ? ['GET', 'POST'] : ['DELETE'];
  if (!allowed.includes(request.method)) return json({ error: 'method-not-allowed' }, 405, { allow: allowed.join(', ') });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  // A link holder learns nothing about the target's other links.
  if (principal.type === 'anonymous') return notFound();
  const db = createDb(env.DB);
  const access = await accessTo(db, principal, target);
  if (!access) return notFound();
  if (access.role !== 'owner') {
    return json({ error: 'forbidden', message: `Only the owner can manage links to this ${target.type === 'doc' ? 'note' : 'folder'}.` }, 403, NO_STORE);
  }
  if (request.method === 'GET') return json({ links: await listLinks(db, target) }, 200, NO_STORE);
  if (request.method === 'DELETE') {
    const result = await db.update(shareLinks).set({ revokedAt: Date.now() }).where(and(ofTarget(target), eq(shareLinks.token, token ?? '')));
    return result.meta.changes > 0 ? json({ revoked: true }, 200, NO_STORE) : notFound();
  }
  const body = await readJsonObject(request);
  if (!body || !isLinkRole(body.role)) {
    return json({ error: 'bad-request', message: 'Choose view, comment or edit access for the link.' }, 400, NO_STORE);
  }
  const link: ShareLink = { token: newToken(), role: body.role, createdAt: Date.now() };
  await db.insert(shareLinks).values({ ...link, targetType: target.type, targetId: target.id, createdBy: principal.id });
  return json({ link }, 201, NO_STORE);
}
