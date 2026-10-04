// The members API (T1.1, T2.4; A§8): who has access to a doc, folder or vault, and sharing it with a person by
// email. Only an owner shares, and emails and pending invites reach owners alone. Sharing is no account-enumeration
// oracle: an email with no account becomes a pending invite (redeemed through T2.8's /invite/$token) and the answer
// is the same as for an email with one, and each owner may make SHARES_PER_HOUR new shares an hour. Lowering or
// removing access waits for the one kick path (T2.5), so a share here only adds or raises.
import { waitUntil } from 'cloudflare:workers';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { publishTo } from '@moss-multi/sync/fanout';
import { ROLES, SHARE_ROLES, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, type Principal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { agents, docMembers, folderMembers, invites, user } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { actingUserId, resolveDocAccess, resolveFolderAccess } from './access.ts';
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

/** An email shared with before anyone signed up with it; the owner's view only. */
export interface PendingInvite {
  email: string;
  role: Role;
}

/** New shares (grants and pending invites) one owner may make in an hour (A§18). */
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
async function grantRows(db: Db, target: MemberTarget, principalId?: string) {
  if (target.type === 'doc') {
    return db
      .select({ principalId: docMembers.principalId, principalType: docMembers.principalType, role: docMembers.role })
      .from(docMembers)
      .where(and(eq(docMembers.docId, target.id), principalId === undefined ? undefined : eq(docMembers.principalId, principalId)))
      .orderBy(sql`rowid`);
  }
  return db
    .select({ principalId: folderMembers.principalId, principalType: folderMembers.principalType, role: folderMembers.role })
    .from(folderMembers)
    .where(and(eq(folderMembers.folderId, target.id), principalId === undefined ? undefined : eq(folderMembers.principalId, principalId)))
    .orderBy(sql`rowid`);
}

/** The owner first, then each grant in the order it was made. */
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

const openInvite = (target: MemberTarget, email?: string) => and(
  eq(invites.targetType, target.type), eq(invites.targetId, target.id), isNull(invites.acceptedAt), isNull(invites.revokedAt),
  email === undefined ? undefined : eq(invites.email, email),
);

/** Pending invites in the order they were made, one row per email at its highest role. */
async function listInvites(db: Db, target: MemberTarget): Promise<PendingInvite[]> {
  const rows = await db.select({ email: invites.email, role: invites.role }).from(invites).where(openInvite(target)).orderBy(sql`rowid`);
  const byEmail = new Map<string, Role>();
  for (const row of rows) {
    const held = byEmail.get(row.email);
    if (!held || lower(held, row.role)) byEmail.set(row.email, row.role);
  }
  return [...byEmail].map(([email, role]) => ({ email, role }));
}

async function heldRole(db: Db, target: MemberTarget, personId: string | null, email: string): Promise<Role | null> {
  if (personId !== null) return (await grantRows(db, target, personId))[0]?.role ?? null;
  return (await listInvites(db, target)).find((row) => row.email === email)?.role ?? null;
}

const changed = (result: D1Result | undefined) => (result?.meta?.changes ?? 0) > 0;

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Adds a person by email at a share role, or raises their role. A known email is granted at once; an unknown one
 * becomes a pending invite. Both answer `{shared: {email, role}}` with the same status, so the answer says nothing
 * about whether an account exists.
 */
async function share(db: Db, env: MembersEnv, target: MemberTarget, ownerUserId: string, caller: Principal, body: Record<string, unknown>): Promise<Response> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return refuse(400, 'bad-request', 'Enter an email address.');
  if (!isShareRole(body.role)) return refuse(400, 'bad-request', 'Choose view, comment, edit or owner access.');
  const role = body.role;
  const inviter = actingUserId(caller) ?? caller.id;
  const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, ownerUserId)).limit(1);
  if (owner && owner.email.toLowerCase() === email) return refuse(409, 'already-owner', `That person owns this ${noun(target)}.`);
  const [person] = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`).limit(1);
  const answer = (status: 200 | 201) => json({ shared: { email, role } }, status, NO_STORE);

  const held = await heldRole(db, target, person?.id ?? null, email);
  if (held !== null) {
    if (lower(role, held)) {
      return refuse(409, 'demotion-unavailable', `${email} already has more access. Lowering access isn’t available yet.`);
    }
    if (role !== held) {
      if (!person) await db.update(invites).set({ role }).where(openInvite(target, email));
      else if (target.type === 'doc') await db.update(docMembers).set({ role }).where(and(eq(docMembers.docId, target.id), eq(docMembers.principalId, person.id)));
      else await db.update(folderMembers).set({ role }).where(and(eq(folderMembers.folderId, target.id), eq(folderMembers.principalId, person.id)));
    }
    return answer(200);
  }

  // Every new share writes an invites row (an already-accepted one for a known account), admitted only while the
  // owner's last hour holds fewer than SHARES_PER_HOUR, in the one statement that inserts it, so a burst can't pass.
  const now = Date.now();
  const token = randomToken();
  const statements = [env.DB.prepare(`INSERT INTO invites (token, email, target_type, target_id, role, invited_by, created_at, accepted_at, accepted_by)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
    WHERE (SELECT count(*) FROM invites WHERE invited_by = ?6 AND created_at > ?10) < ${SHARES_PER_HOUR}`)
    .bind(token, email, target.type, target.id, role, inviter, now, person ? now : null, person?.id ?? null, now - HOUR_MS)];
  if (person) {
    const [table, column] = target.type === 'doc' ? ['doc_members', 'doc_id'] : ['folder_members', 'folder_id'];
    statements.push(env.DB.prepare(`INSERT INTO ${table} (${column}, principal_id, principal_type, role, added_by, created_at)
      SELECT ?1, ?2, 'user', ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM invites WHERE token = ?6)
      ON CONFLICT DO NOTHING`).bind(target.id, person.id, role, caller.id, now, token));
  }
  const [admitted, granted] = await env.DB.batch(statements);
  if (!changed(admitted)) {
    return refuse(429, 'rate-limited', 'You’ve shared with a lot of people in the last hour. Try again later.', { 'retry-after': '3600' });
  }
  if (person && !changed(granted)) {
    // A concurrent share of this person committed first: answer against the role that is now stored.
    return share(db, env, target, ownerUserId, caller, body);
  }
  if (person && env.PrincipalDO) {
    // The grantee's open tabs refresh their vaults and shared items, off the response path so its timing says
    // nothing about whether the email has an account; the committed share stands if this fails.
    const notify = publishTo({ DB: env.DB, PrincipalDO: env.PrincipalDO }, person.id, { type: 'vaults' })
      .catch((error: unknown) => console.error('workspace share notification failed', error));
    waitUntil(notify);
  }
  return answer(201);
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
    return json(owner ? { members, invites: await listInvites(db, target) } : { members }, 200, NO_STORE);
  }
  if (!owner) return refuse(403, 'forbidden', `Only the owner can share this ${noun(target)}.`);
  const body = await readJsonObject(request);
  if (!body) return refuse(400, 'bad-request', 'The request body must be a JSON object.');
  return share(db, env, target, access.ownerUserId, principal, body);
}
