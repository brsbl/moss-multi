// Copy-link invites (T2.8; P:People "copy-link invites", no email is sent; A§8). Every share by email is an invite
// bound to the email and a random token, never to an account (members.ts). Its owner reads the invite's link here
// and hands it over; the invitee redeems it, from the link or from its notice in their bell, by following it signed
// in (or signed up) with the invite's email, once, at its role, and the inviter hears who did. Anyone else who follows
// it hears only that it is for another email, the same answer as for a forged, spent, withdrawn or dead invite, so a
// link never tells its holder whether the email has an account. An invite dies when its inviter stops managing the
// item or the item goes to Trash, checked inside the redeeming write.
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

/** The one refusal every account but the invite's own hears, whatever the cause. */
export const INVITE_ELSEWHERE = 'This invite is for another email. Sign in with the address it was sent to, or ask for a new link.';
const elsewhere = () => json({ error: 'invite-unavailable', message: INVITE_ELSEWHERE }, 404, NO_STORE);

/** The live owner of an invite's target, or null when it is gone or trashed. */
async function liveTarget(db: D1Database, type: MemberTarget['type'], id: string): Promise<string | null> {
  const table = type === 'doc' ? 'docs' : 'folders';
  const row = await db.prepare(`SELECT owner_user_id AS owner FROM ${table} WHERE id = ? AND deleted_at IS NULL`).bind(id).first<{ owner: string }>();
  return row?.owner ?? null;
}

interface InviteRow {
  type: MemberTarget['type'];
  id: string;
  email: string;
  inviter: string;
  acceptedBy: string | null;
  revokedAt: number | null;
}

/**
 * POST `/api/invites/:token/accept`: the invited person, signed in with the invite's email, redeems it and learns
 * where it leads. Every other account does the same work and hears `elsewhere`, except the target's owner following
 * her own link, who is sent on without spending it (the owner is never a member).
 */
export async function acceptInvite(request: Request, env: InvitesEnv, token: string): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  if (principal.type !== 'user') return elsewhere();
  const invite = await env.DB.prepare(`SELECT target_type AS type, target_id AS id, email, invited_by AS inviter,
      accepted_by AS acceptedBy, revoked_at AS revokedAt FROM invites WHERE token = ?`)
    .bind(token).first<InviteRow>();
  if (!invite) return elsewhere();
  const target = { type: invite.type, id: invite.id };
  if (principal.email.toLowerCase() !== invite.email) {
    const owner = await liveTarget(env.DB, invite.type, invite.id);
    return owner === principal.id && invite.revokedAt === null ? json({ target }, 200, NO_STORE) : elsewhere();
  }
  // From here the caller holds the invite's email: what it learns is about its own invite.
  if (invite.acceptedBy === principal.id) return (await liveTarget(env.DB, invite.type, invite.id)) ? json({ target }, 200, NO_STORE) : elsewhere();
  if (invite.acceptedBy !== null || invite.revokedAt !== null) return elsewhere();

  const now = Date.now();
  const [table, column] = grantTable(invite.type);
  // One batch, each statement seeing the last: the invite is spent only while it is open, its target live and its
  // inviter still managing it (so a trash or a revocation that commits first wins), and the grant and the inviter's
  // notice follow only the spending this request did. A grant only ever rises.
  const [spent] = await env.DB.batch([
    env.DB.prepare(`UPDATE invites SET accepted_at = ?2, accepted_by = ?3
      WHERE token = ?1 AND email = ?6 AND accepted_at IS NULL AND revoked_at IS NULL AND target_id = ?4 AND invited_by = ?5
        AND ${liveAndManaged(invite.type, 4, 5)}`)
      .bind(token, now, principal.id, invite.id, invite.inviter, invite.email),
    env.DB.prepare(`INSERT INTO ${table} (${column}, principal_id, principal_type, role, added_by, created_at)
      SELECT target_id, ?3, 'user', role, invited_by, ?2 FROM invites WHERE token = ?1 AND accepted_by = ?3 AND accepted_at = ?2
      ON CONFLICT (${column}, principal_id) DO UPDATE SET role = excluded.role WHERE ${rank('role')} < ${rank('excluded.role')}`)
      .bind(token, now, principal.id),
    env.DB.prepare(`INSERT INTO notifications (id, user_id, type, payload_json, created_at)
      SELECT ?4, invited_by, 'invite-accepted', json_object('targetType', target_type, 'targetId', target_id, 'by', ?3, 'invitedEmail', email), ?2
      FROM invites WHERE token = ?1 AND accepted_by = ?3 AND accepted_at = ?2`)
      .bind(token, now, principal.id, crypto.randomUUID()),
  ]);
  if (!spent?.meta?.changes) return elsewhere(); // dead, trashed, spent or withdrawn in the meantime
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
