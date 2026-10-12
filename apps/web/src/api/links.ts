// Share links (T2.4, A§8): an owner creates, lists and revokes revocable tokenized links to a doc, folder or vault at
// viewer, commenter or editor. The link role is a ceiling (roles.ts foldRole): anonymous holders read at viewer and
// signing in lifts them to it. A revoked token answers like a forged one everywhere, and revoking it closes every
// connection that presented it, signed in or not, through the one kick path (T2.5) before the call answers.
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DAY_MS, SHARE_LINK_DAILY } from '@moss-multi/protocol/limits';
import { LINK_ROLES, type LinkRole } from '@moss-multi/protocol/roles';
import { docsOf, kick, KickFailed } from '@moss-multi/sync/fanout';
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { shareLinks } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { liveAndManaged } from './access.ts';
import { accessTo, manages, randomToken, type MemberTarget } from './members.ts';
import { changed, NO_STORE, notFound, overDailyBound, readJsonObject, unauthenticated } from './respond.ts';

export interface ShareLink {
  token: string;
  role: LinkRole;
  createdAt: number;
}

const isLinkRole = (value: unknown): value is LinkRole => typeof value === 'string' && (LINK_ROLES as readonly string[]).includes(value);

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
export type LinksEnv = AuthEnv & Partial<Pick<AppEnv, 'DocDO'>>;

const forbidden = (target: MemberTarget) =>
  json({ error: 'forbidden', message: `Only the owner can manage links to this ${target.type === 'doc' ? 'note' : 'folder'}.` }, 403, NO_STORE);

const KICK_FAILED = 'The link is revoked, but some open windows haven’t closed yet. Try again.';

export async function handleLinks(request: Request, env: LinksEnv, target: MemberTarget, token: string | null): Promise<Response> {
  const allowed = token === null ? ['GET', 'POST'] : ['DELETE'];
  if (!allowed.includes(request.method)) return json({ error: 'method-not-allowed' }, 405, { allow: allowed.join(', ') });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  // A link holder learns nothing about the target's other links.
  if (principal.type === 'anonymous') return notFound();
  const db = createDb(env.DB);
  const access = await accessTo(db, principal, target);
  if (!access) return notFound();
  if (access.role !== 'owner') return forbidden(target);
  if (request.method === 'GET') return json({ links: await listLinks(db, target) }, 200, NO_STORE);
  if (request.method === 'DELETE') {
    const tokenOf = and(eq(shareLinks.targetType, target.type), eq(shareLinks.targetId, target.id), eq(shareLinks.token, token ?? ''));
    // The caller must still manage the live target, so a demotion that commits first wins.
    const revoked = await env.DB.prepare(`UPDATE share_links SET revoked_at = ?1
      WHERE target_type = ?2 AND target_id = ?3 AND token = ?4 AND revoked_at IS NULL AND ${liveAndManaged(target.type, 3, 5)}`)
      .bind(Date.now(), target.type, target.id, token ?? '', principal.id).run();
    if (!changed(revoked)) {
      const now = await accessTo(db, principal, target);
      if (!now) return notFound();
      if (now.role !== 'owner') return forbidden(target);
    }
    // A retry after a failed kick finds the link already revoked and kicks again.
    const [row] = await db.select({ token: shareLinks.token }).from(shareLinks).where(tokenOf).limit(1);
    if (!row) return notFound();
    if (!env.DocDO) return json({ error: 'unavailable', message: KICK_FAILED }, 503, NO_STORE);
    try {
      await kick({ DB: env.DB, DocDO: env.DocDO }, await docsOf(env.DB, target), { tokens: [row.token] });
    } catch (error) {
      if (!(error instanceof KickFailed)) throw error;
      return json({ error: 'unavailable', message: KICK_FAILED }, 503, NO_STORE);
    }
    return json({ revoked: true }, 200, NO_STORE);
  }
  const body = await readJsonObject(request);
  if (!body || !isLinkRole(body.role)) {
    return json({ error: 'bad-request', message: 'Choose view, comment or edit access for the link.' }, 400, NO_STORE);
  }
  const link: ShareLink = { token: randomToken(), role: body.role, createdAt: Date.now() };
  // The caller must still manage the target when the link is written, so an owner demoted or removed while this
  // request was under way cannot hand themselves access back through a link (A§8).
  // At most SHARE_LINK_DAILY a day per person over all targets, revoked ones included, so making and revoking cannot add
  // rows without bound; charged to the maker (through `share_links_created_by_idx`), never to a target.
  const today = `(SELECT count(*) FROM share_links WHERE created_by = ?5 AND created_at > ?6 - ${DAY_MS})`;
  const inserted = await env.DB.prepare(`INSERT INTO share_links (token, target_type, target_id, role, created_by, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${manages(target, 3, 5)} AND ${today} < ${SHARE_LINK_DAILY}`)
    .bind(link.token, target.type, target.id, link.role, principal.id, link.createdAt).run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    const now = await accessTo(db, principal, target);
    if (!now) return notFound();
    // Still the owner, so the day's links ran out.
    if (now.role === 'owner') return overDailyBound(`You can make ${SHARE_LINK_DAILY} share links a day. Try again later.`);
    return forbidden(target);
  }
  return json({ link }, 201, NO_STORE);
}
