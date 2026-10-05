// Copy-link invites (T2.8; P:People "copy-link invites", no email is sent). Every share by email is an open invite
// (members.ts); its owner reads the invite's link here and hands it over. Following the link while signed in redeems
// it: possessing the token is the authority, as in glyphdown, so whoever signs in with it gets the invite's role,
// once, and the inviter hears who did. A share is also redeemed when its grantee explicitly opens the item: its URL
// (docs.ts) or its notice in the bell (notifications.ts), never a socket a background open made (T2.4 follow-up).
import { waitUntil } from 'cloudflare:workers';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { publishTo } from '@moss-multi/sync/fanout';
import { ROLES } from '@moss-multi/protocol/roles';
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { invites } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { accessTo, type MemberTarget } from './members.ts';
import { NO_STORE, notFound, unauthenticated } from './respond.ts';

export type InvitesEnv = AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>;

/** SQL for a role's rank in ROLES order, so a redemption only ever raises a grant. */
const rank = (expression: string) => `CASE ${expression} ${ROLES.map((role, i) => `WHEN '${role}' THEN ${i}`).join(' ')} END`;

const grantTable = (type: MemberTarget['type']): [string, string] => (type === 'doc' ? ['doc_members', 'doc_id'] : ['folder_members', 'folder_id']);

/** Tells a principal's open tabs to read again, off the response path; a failure loses only the push. */
export function notify(env: InvitesEnv, principalId: string, type: 'notifications' | 'vaults'): void {
  if (!env.PrincipalDO) return;
  waitUntil(publishTo({ DB: env.DB, PrincipalDO: env.PrincipalDO }, principalId, { type })
    .catch((error: unknown) => console.error(`workspace ${type} push failed`, error)));
}

/** The page that redeems an invite, on this deployment's own origin. */
export const inviteUrl = (env: AuthEnv, request: Request, token: string) =>
  new URL(`/invite/${token}`, env.BETTER_AUTH_URL ?? request.url).href;

/** GET `/api/{docs,folders}/:id/invites`: each open invite with its copyable link, for the target's owners only. */
export async function handleInviteLinks(request: Request, env: AuthEnv, target: MemberTarget): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  if (principal.type === 'anonymous') return notFound();
  const db = createDb(env.DB);
  const access = await accessTo(db, principal, target);
  if (!access) return notFound();
  if (access.role !== 'owner') return json({ error: 'forbidden', message: 'Only the owner can see invite links.' }, 403, NO_STORE);
  const rows = await db.select({ email: invites.email, role: invites.role, token: invites.token }).from(invites)
    .where(and(eq(invites.targetType, target.type), eq(invites.targetId, target.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    .orderBy(sql`rowid`);
  return json({ invites: rows.map(({ email, role, token }) => ({ email, role, url: inviteUrl(env, request, token) })) }, 200, NO_STORE);
}

/** The live owner of an invite's target, or null when it is gone or trashed. */
async function liveTarget(db: D1Database, type: MemberTarget['type'], id: string): Promise<string | null> {
  const table = type === 'doc' ? 'docs' : 'folders';
  const row = await db.prepare(`SELECT owner_user_id AS owner FROM ${table} WHERE id = ? AND deleted_at IS NULL`).bind(id).first<{ owner: string }>();
  return row?.owner ?? null;
}

/**
 * POST `/api/invites/:token/accept`: a signed-in person redeems the invite and learns where it leads. A forged,
 * revoked or spent token, and one whose item is gone, all get the one 404. The target's owner following the link
 * is sent on without spending it, since the owner is never a member.
 */
export async function acceptInvite(request: Request, env: InvitesEnv, token: string): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  if (principal.type !== 'user') return notFound();
  const invite = await env.DB.prepare(`SELECT target_type AS type, target_id AS id, invited_by AS inviter, accepted_by AS acceptedBy
      FROM invites WHERE token = ? AND revoked_at IS NULL`).bind(token)
    .first<{ type: MemberTarget['type']; id: string; inviter: string; acceptedBy: string | null }>();
  if (!invite || (invite.acceptedBy !== null && invite.acceptedBy !== principal.id)) return notFound();
  const owner = await liveTarget(env.DB, invite.type, invite.id);
  if (owner === null) return notFound();
  const target = { type: invite.type, id: invite.id };
  if (invite.acceptedBy !== null || owner === principal.id) return json({ target }, 200, NO_STORE);

  const now = Date.now();
  const [table, column] = grantTable(invite.type);
  // One batch, each statement seeing the last: the invite is spent only if still open, and the grant and the
  // inviter's notice follow only the spending this request did.
  const [spent] = await env.DB.batch([
    env.DB.prepare('UPDATE invites SET accepted_at = ?2, accepted_by = ?3 WHERE token = ?1 AND accepted_at IS NULL AND revoked_at IS NULL')
      .bind(token, now, principal.id),
    env.DB.prepare(`INSERT INTO ${table} (${column}, principal_id, principal_type, role, added_by, created_at)
      SELECT target_id, ?3, 'user', role, invited_by, ?2 FROM invites WHERE token = ?1 AND accepted_by = ?3 AND accepted_at = ?2
      ON CONFLICT (${column}, principal_id) DO UPDATE SET role = excluded.role WHERE ${rank('role')} < ${rank('excluded.role')}`)
      .bind(token, now, principal.id),
    env.DB.prepare(`INSERT INTO notifications (id, user_id, type, payload_json, created_at)
      SELECT ?4, invited_by, 'invite-accepted', json_object('targetType', target_type, 'targetId', target_id, 'by', ?3, 'invitedEmail', email), ?2
      FROM invites WHERE token = ?1 AND accepted_by = ?3 AND accepted_at = ?2`)
      .bind(token, now, principal.id, crypto.randomUUID()),
  ]);
  if (!spent?.meta?.changes) return notFound(); // someone else spent it in the meantime
  notify(env, invite.inviter, 'notifications');
  notify(env, principal.id, 'vaults');
  return json({ target }, 200, NO_STORE);
}

/**
 * The grantee opened a share's notice: their open email shares on that item are redeemed, as opening its URL does.
 * Only a share they hold a grant for; an invite to an email that had no account waits for its link.
 */
export async function redeemOpenedShare(db: D1Database, user: { id: string; email: string }, target: MemberTarget): Promise<void> {
  const [table, column] = grantTable(target.type);
  await db.prepare(`UPDATE invites SET accepted_at = ?3, accepted_by = ?4
      WHERE email = ?5 AND target_type = ?1 AND target_id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM ${table} WHERE ${column} = ?2 AND principal_id = ?4)`)
    .bind(target.type, target.id, Date.now(), user.id, user.email.toLowerCase()).run();
}

const ACCEPT = /^\/api\/invites\/([0-9a-f]{1,128})\/accept$/;

/** `/api/invites/*`. */
export async function handleInvites(request: Request, env: InvitesEnv): Promise<Response> {
  const match = ACCEPT.exec(new URL(request.url).pathname);
  if (!match) return notFound();
  return acceptInvite(request, env, match[1]);
}
