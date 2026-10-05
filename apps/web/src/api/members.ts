// The members API (T1.1, T2.4, T2.8; A§8): who has access to a doc, folder or vault, and sharing it with a person by
// email. Only an owner shares, and emails and pending invites reach owners alone. Whether an email has an account is
// never observable to anyone but that account's holder: a share is an invite bound to the email and a random token,
// never to an account, and grants nothing until the invitee redeems it signed in with that email (invites.ts). The
// inviter's path reads and writes only the invite and what earlier redemptions of it made, so its answer, the member
// list and their timing are the same whether or not the email has an account. Each owner may make SHARES_PER_HOUR
// new shares an hour. Lowering or removing access waits for the one kick path (T2.5), so a share only adds or raises.
import { waitUntil } from 'cloudflare:workers';
import { eq, inArray, sql } from 'drizzle-orm';
import { publishTo } from '@moss-multi/sync/fanout';
import { ROLES, SHARE_ROLES, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, type Principal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { agents, docMembers, folderMembers, user } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { actingUserId, liveAndManaged, managesLive, resolveDocAccess, resolveFolderAccess } from './access.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

export type MemberTarget = { type: 'doc' | 'folder'; id: string };
export type MembersEnv = AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>;

export interface Member {
  principalId: string;
  principalType: 'user' | 'agent';
  name: string;
  /** The owner's view only. */
  email?: string;
  role: Role;
}

/** An email shared with and not yet redeemed; the owner's view only. */
export interface PendingInvite {
  email: string;
  role: Role;
}

/** New shares (invites) one owner may make in an hour (A§18). */
export const SHARES_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const isShareRole = (value: unknown): value is ShareRole => typeof value === 'string' && (SHARE_ROLES as readonly string[]).includes(value);
const lower = (a: Role, b: Role) => ROLES.indexOf(a) < ROLES.indexOf(b);

const refuse = (status: number, error: string, message: string, headers: Record<string, string> = {}) =>
  json({ error, message }, status, { ...NO_STORE, ...headers });

const noun = (target: MemberTarget) => (target.type === 'doc' ? 'note' : 'folder');

/** Member identities require ownership or grants; a share link grants content access only. */
export async function accessTo(db: Db, principal: Principal, target: MemberTarget): Promise<{ role: Role; ownerUserId: string } | null> {
  const access = target.type === 'doc'
    ? await resolveDocAccess(db, principal, target.id)
    : await resolveFolderAccess(db, principal, target.id);
  return access && !access.deleted && !access.linkOnly ? access : null;
}

/** The target's grants in the order they were made (rowid is insertion order). */
async function grantRows(db: Db, target: MemberTarget) {
  if (target.type === 'doc') {
    return db
      .select({ principalId: docMembers.principalId, principalType: docMembers.principalType, role: docMembers.role })
      .from(docMembers)
      .where(eq(docMembers.docId, target.id))
      .orderBy(sql`rowid`);
  }
  return db
    .select({ principalId: folderMembers.principalId, principalType: folderMembers.principalType, role: folderMembers.role })
    .from(folderMembers)
    .where(eq(folderMembers.folderId, target.id))
    .orderBy(sql`rowid`);
}

/** The owner first, then each grant in the order it was made. A grant comes only from a redeemed invite. */
async function listMembers(db: Db, target: MemberTarget, ownerUserId: string, withEmails: boolean): Promise<Member[]> {
  const grants = await grantRows(db, target);
  const userIds = [ownerUserId, ...grants.filter((g) => g.principalType === 'user').map((g) => g.principalId)];
  const agentIds = grants.filter((g) => g.principalType === 'agent').map((g) => g.principalId);
  const [users, agentRows] = await Promise.all([
    db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, userIds)),
    agentIds.length > 0 ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
  ]);
  const people = new Map(users.map((u) => [u.id, u]));
  const bots = new Map(agentRows.map((a) => [a.id, a]));
  const person = (id: string, role: Role): Member | null => {
    const found = people.get(id);
    if (!found) return null;
    return { principalId: id, principalType: 'user', name: found.name, ...(withEmails ? { email: found.email } : {}), role };
  };
  const members: Member[] = [];
  const owner = person(ownerUserId, 'owner');
  if (owner) members.push(owner);
  for (const grant of grants) {
    if (grant.principalType === 'user') {
      const member = person(grant.principalId, grant.role);
      if (member) members.push(member);
    } else {
      const bot = bots.get(grant.principalId);
      if (bot) members.push({ principalId: bot.id, principalType: 'agent', name: bot.name, role: grant.role });
    }
  }
  return members;
}

/**
 * The target's live invites in the order they were made: open, and made by someone who still manages the target
 * (A§8). An invite whose inviter lost manage can never be redeemed, so the owner neither sees it nor gets its link.
 */
export async function liveInvites(db: D1Database, target: MemberTarget): Promise<{ email: string; role: Role; token: string }[]> {
  const { results } = await db.prepare(`SELECT email, role, token, invited_by AS inviter FROM invites
      WHERE target_type = ?1 AND target_id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY rowid`)
    .bind(target.type, target.id).all<{ email: string; role: Role; token: string; inviter: string }>();
  const managing = new Map<string, boolean>();
  for (const inviter of new Set(results.map((row) => row.inviter))) managing.set(inviter, await managesLive(db, target.type, target.id, inviter));
  return results.filter((row) => managing.get(row.inviter)).map(({ email, role, token }) => ({ email, role, token }));
}

const changed = (result: D1Result | undefined) => (result?.meta?.changes ?? 0) > 0;

export const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SQL for a role's rank in ROLES order, so a write can only raise. */
export const rank = (expression: string) => `CASE ${expression} ${ROLES.map((role, i) => `WHEN '${role}' THEN ${i}`).join(' ')} END`;

export const grantTable = (type: MemberTarget['type']): [string, string] => (type === 'doc' ? ['doc_members', 'doc_id'] : ['folder_members', 'folder_id']);

/**
 * Tells the open tabs of whoever holds `email`, if anyone, that their bell changed. It runs after the response is
 * sent (waitUntil) for every share alike, so nothing the inviter receives, nor when, depends on whether the email
 * has an account; a failure loses only the push (the bell reads the invite itself, notifications.ts).
 */
function pushToInvitee(env: MembersEnv, email: string): void {
  const principals = env.PrincipalDO;
  if (!principals) return;
  waitUntil((async () => {
    const holder = await env.DB.prepare('SELECT id FROM "user" WHERE lower(email) = ?1').bind(email).first<{ id: string }>();
    if (holder) await publishTo({ DB: env.DB, PrincipalDO: principals }, holder.id, { type: 'notifications' });
  })().catch((error: unknown) => console.error('invite notification failed', error)));
}

/**
 * Invites a person by email at a share role, or raises their invite or, once they have redeemed one here, their
 * grant. Every answer and write derives from the email's invites on this target alone: a new share is a fresh open
 * invite (201), a repeat or raise answers 200, a lowering 409 and the hourly limit 429, for an email with an account
 * exactly as for one without. An open invite whose inviter no longer manages the target is withdrawn and replaced by
 * a fresh one at this share's role.
 */
async function share(env: MembersEnv, target: MemberTarget, ownerUserId: string, caller: Principal, body: Record<string, unknown>): Promise<Response> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return refuse(400, 'bad-request', 'Enter an email address.');
  if (!isShareRole(body.role)) return refuse(400, 'bad-request', 'Choose view, comment, edit or owner access.');
  const role = body.role;
  const inviter = actingUserId(caller) ?? caller.id;
  // The vault owner is visible to every owner already; this reads that account by its id, never by the email.
  const owner = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?1').bind(ownerUserId).first<{ email: string }>();
  if (owner && owner.email.toLowerCase() === email) return refuse(409, 'already-owner', `That person owns this ${noun(target)}.`);
  const [table, column] = grantTable(target.type);
  const now = Date.now();
  const open = await env.DB.prepare(`SELECT token, invited_by AS inviter FROM invites WHERE target_type = ?1 AND target_id = ?2
      AND email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL`)
    .bind(target.type, target.id, email).first<{ token: string; inviter: string }>();
  // Someone who redeemed an invite to this email here and still holds its grant: a member the owner already sees.
  const redeemed = `SELECT g.role FROM invites i JOIN ${table} g ON g.${column} = i.target_id AND g.principal_id = i.accepted_by
    WHERE i.target_type = ?1 AND i.target_id = ?2 AND i.email = ?3 AND i.accepted_by IS NOT NULL`;

  // One batch, each statement seeing the one before, the same statements for every email.
  const [, , admitted, raisedInvite] = await env.DB.batch([
    // A dead open invite (its inviter no longer manages the target) is withdrawn, so this share replaces it.
    env.DB.prepare(`UPDATE invites SET revoked_at = ?3 WHERE token = ?1 AND invited_by = ?2 AND accepted_at IS NULL
        AND revoked_at IS NULL AND NOT (${liveAndManaged(target.type, 4, 2)})`)
      .bind(open?.token ?? '', open?.inviter ?? '', now, target.id),
    // A member by a redeemed invite is raised in place, never lowered.
    env.DB.prepare(`UPDATE ${table} SET role = ?4 WHERE ${column} = ?2 AND ${rank('role')} < ${rank('?4')}
        AND principal_id IN (SELECT accepted_by FROM invites WHERE target_type = ?1 AND target_id = ?2 AND email = ?3)`)
      .bind(target.type, target.id, email, role),
    // A new open invite, only while the inviter's last hour holds fewer than SHARES_PER_HOUR (counted by the statement
    // that inserts, so a burst can't pass), for someone not a member yet, once per open email (a concurrent first
    // share conflicts and becomes a repeat).
    env.DB.prepare(`INSERT INTO invites (token, email, target_type, target_id, role, invited_by, created_at)
        SELECT ?5, ?3, ?1, ?2, ?4, ?6, ?7
        WHERE (SELECT count(*) FROM invites WHERE invited_by = ?6 AND created_at > ?8) < ${SHARES_PER_HOUR}
          AND NOT EXISTS (${redeemed})
        ON CONFLICT DO NOTHING`)
      .bind(target.type, target.id, email, role, randomToken(), inviter, now, now - HOUR_MS),
    env.DB.prepare(`UPDATE invites SET role = ?4 WHERE target_type = ?1 AND target_id = ?2 AND email = ?3
        AND accepted_at IS NULL AND revoked_at IS NULL AND ${rank('role')} < ${rank('?4')}`)
      .bind(target.type, target.id, email, role),
  ]);
  if (changed(admitted) || changed(raisedInvite)) pushToInvitee(env, email);
  if (changed(admitted)) return json({ shared: { email, role } }, 201, NO_STORE);
  // Not a new invite: the email holds an open invite or is a member here, or the inviter is over the hourly limit.
  const { results } = await env.DB.prepare(`SELECT role FROM invites WHERE target_type = ?1 AND target_id = ?2 AND email = ?3
      AND accepted_at IS NULL AND revoked_at IS NULL UNION ALL ${redeemed}`)
    .bind(target.type, target.id, email).all<{ role: Role }>();
  const held = results.map((row) => row.role).sort((a, b) => ROLES.indexOf(b) - ROLES.indexOf(a))[0];
  if (held === undefined) {
    return refuse(429, 'rate-limited', 'You’ve shared with a lot of people in the last hour. Try again later.', { 'retry-after': '3600' });
  }
  if (lower(role, held)) {
    return refuse(409, 'demotion-unavailable', `${email} already has more access. Lowering access isn’t available yet.`);
  }
  return json({ shared: { email, role } }, 200, NO_STORE);
}

/** GET and POST `/api/{docs,folders}/:id/members`. */
export async function handleMembers(request: Request, env: MembersEnv, target: MemberTarget): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET, POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  // Link-only visitors may read content, never the identities of its collaborators.
  if (principal.type === 'anonymous') return notFound();
  const db = createDb(env.DB);
  const access = await accessTo(db, principal, target);
  if (!access) return notFound();
  const owner = access.role === 'owner';
  if (request.method === 'GET') {
    const members = await listMembers(db, target, access.ownerUserId, owner);
    if (!owner) return json({ members }, 200, NO_STORE);
    const invites = (await liveInvites(env.DB, target)).map(({ email, role }) => ({ email, role }));
    return json({ members, invites }, 200, NO_STORE);
  }
  if (!owner) return refuse(403, 'forbidden', `Only the owner can share this ${noun(target)}.`);
  const body = await readJsonObject(request);
  if (!body) return refuse(400, 'bad-request', 'The request body must be a JSON object.');
  return share(env, target, access.ownerUserId, principal, body);
}

