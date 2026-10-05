// Copy-link invites (T2.8; P:People "copy-link invites", no email is sent; A§8; PRODUCT ruling 19). Every share by
// email is an invite: a personal link the owner reads here and sends, its email only a label. Whoever follows the link
// while signed in (or after signing up through it) redeems it, once, at its role; the invite then binds to that
// account and the inviter hears who did. Owning the email grants nothing, so registering someone's address gets a
// squatter nothing without the link. A forged, spent, withdrawn or dead link gets one answer. An invite dies when its
// inviter stops managing the item or the item goes to Trash, checked inside the redeeming write.
import { waitUntil } from 'cloudflare:workers';
import { publishTo } from '@moss-multi/sync/fanout';
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { liveAndManaged } from './access.ts';
import { accessTo, grantTable, liveInvites, rank, type MemberTarget } from './members.ts';
import { NO_STORE, notFound, unauthenticated } from './respond.ts';

export type InvitesEnv = AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>;

/** Tells a principal's open tabs to read again, off the response path; a failure loses only the push. */
export function notify(env: InvitesEnv, principalId: string, type: 'notifications' | 'vaults'): void {
  if (!env.PrincipalDO) return;
  waitUntil(publishTo({ DB: env.DB, PrincipalDO: env.PrincipalDO }, principalId, { type })
    .catch((error: unknown) => console.error(`workspace ${type} push failed`, error)));
}

/** The page that redeems an invite, on this deployment's own origin. */
export const inviteUrl = (env: AuthEnv, request: Request, token: string) =>
  new URL(`/invite/${token}`, env.BETTER_AUTH_URL ?? request.url).href;

/** GET `/api/{docs,folders}/:id/invites`: each live invite with its copyable link, for the target's owners only. */
export async function handleInviteLinks(request: Request, env: AuthEnv, target: MemberTarget): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  if (principal.type === 'anonymous') return notFound();
  const access = await accessTo(createDb(env.DB), principal, target);
  if (!access) return notFound();
  if (access.role !== 'owner') return json({ error: 'forbidden', message: 'Only the owner can see invite links.' }, 403, NO_STORE);
  const rows = await liveInvites(env.DB, target);
  return json({ invites: rows.map(({ email, role, token }) => ({ email, role, url: inviteUrl(env, request, token) })) }, 200, NO_STORE);
}

/** The one refusal for a link that admits nobody, whatever the cause. */
export const INVITE_CLOSED = 'This invite link has already been used or is no longer open. Ask the person who shared it for a new one.';
const closed = () => json({ error: 'invite-unavailable', message: INVITE_CLOSED }, 404, NO_STORE);

/** The live owner of an invite's target, or null when it is gone or trashed. */
async function liveTarget(db: D1Database, type: MemberTarget['type'], id: string): Promise<string | null> {
  const table = type === 'doc' ? 'docs' : 'folders';
  const row = await db.prepare(`SELECT owner_user_id AS owner FROM ${table} WHERE id = ? AND deleted_at IS NULL`).bind(id).first<{ owner: string }>();
  return row?.owner ?? null;
}

interface InviteRow {
  type: MemberTarget['type'];
  id: string;
  inviter: string;
  acceptedBy: string | null;
  revokedAt: number | null;
}

/**
 * POST `/api/invites/:token/accept`: a signed-in person redeems the invite and learns where it leads; it binds to
 * them. Following it again leads them there again; the target's owner is sent on without spending it (the owner is
 * never a member). Every other case gets `closed`.
 */
export async function acceptInvite(request: Request, env: InvitesEnv, token: string): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  if (principal.type !== 'user') return closed();
  const invite = await env.DB.prepare(`SELECT target_type AS type, target_id AS id, invited_by AS inviter,
      accepted_by AS acceptedBy, revoked_at AS revokedAt FROM invites WHERE token = ?`)
    .bind(token).first<InviteRow>();
  if (!invite || invite.revokedAt !== null) return closed();
  const target = { type: invite.type, id: invite.id };
  const owner = await liveTarget(env.DB, invite.type, invite.id);
  if (owner === null) return closed();
  if (owner === principal.id || invite.acceptedBy === principal.id) return json({ target }, 200, NO_STORE);
  if (invite.acceptedBy !== null) return closed();

  const now = Date.now();
  const [table, column] = grantTable(invite.type);
  // One batch, each statement seeing the last: the invite is spent only while it is open, its target live and its
  // inviter still managing it (so a trash or a revocation that commits first wins), and the grant and the inviter's
  // notice follow only the spending this request did. A grant only ever rises.
  const [spent] = await env.DB.batch([
    env.DB.prepare(`UPDATE invites SET accepted_at = ?2, accepted_by = ?3
      WHERE token = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND target_id = ?4 AND invited_by = ?5
        AND ${liveAndManaged(invite.type, 4, 5)}`)
      .bind(token, now, principal.id, invite.id, invite.inviter),
    env.DB.prepare(`INSERT INTO ${table} (${column}, principal_id, principal_type, role, added_by, created_at)
      SELECT target_id, ?3, 'user', role, invited_by, ?2 FROM invites WHERE token = ?1 AND accepted_by = ?3 AND accepted_at = ?2
      ON CONFLICT (${column}, principal_id) DO UPDATE SET role = excluded.role WHERE ${rank('role')} < ${rank('excluded.role')}`)
      .bind(token, now, principal.id),
    env.DB.prepare(`INSERT INTO notifications (id, user_id, type, payload_json, created_at)
      SELECT ?4, invited_by, 'invite-accepted', json_object('targetType', target_type, 'targetId', target_id, 'by', ?3, 'invitedEmail', email), ?2
      FROM invites WHERE token = ?1 AND accepted_by = ?3 AND accepted_at = ?2`)
      .bind(token, now, principal.id, crypto.randomUUID()),
  ]);
  if (!spent?.meta?.changes) return closed(); // dead, trashed, spent or withdrawn in the meantime
  notify(env, invite.inviter, 'notifications');
  notify(env, principal.id, 'vaults');
  return json({ target }, 200, NO_STORE);
}

const ACCEPT = /^\/api\/invites\/([0-9a-f]{1,128})\/accept$/;

/** `/api/invites/*`. */
export async function handleInvites(request: Request, env: InvitesEnv): Promise<Response> {
  const match = ACCEPT.exec(new URL(request.url).pathname);
  if (!match) return notFound();
  return acceptInvite(request, env, match[1]);
}
