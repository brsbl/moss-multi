// The members API (T1.1, T2.4; A§8): who has access to a doc, folder or vault, and sharing it with a person by
// email. Only an owner shares, and emails and pending invites reach owners alone. Sharing is no account-enumeration
// oracle: an email with no account becomes a pending invite (redeemed through T2.8's /invite/$token), the answer is
// the same as for an email with one, and the owner sees both by email as pending until the grantee opens the item;
// each owner may make SHARES_PER_HOUR new shares an hour. A share only adds or raises; PATCH changes a member's or an
// invite's access and DELETE removes it, and lowering or removing a member goes through the one kick path (T2.5): every
// DocDO the grant reached closes that person's sockets before the call answers.
import { waitUntil } from 'cloudflare:workers';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { docsOf, kick, KickFailed, publishTo, withAgents } from '@moss-multi/sync/fanout';
import { ROLES, SHARE_ROLES, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, type Principal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { agents, docMembers, folderMembers, invites, user } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { actingUserId, managesDoc, managesFolder, MAX_FOLDER_DEPTH, resolveDocAccess, resolveFolderAccess } from './access.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

export type MemberTarget = { type: 'doc' | 'folder'; id: string };
export type MembersEnv = AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO' | 'DocDO'>>;

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

/** The owner first, then each grant in the order it was made, leaving out a person whose share is still pending. */
async function listMembers(db: Db, target: MemberTarget, ownerUserId: string, withEmails: boolean, pending: Set<string>): Promise<Member[]> {
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
      if (pending.has(people.get(grant.principalId)?.email.toLowerCase() ?? '')) continue;
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

/** Open invites in the order they were made (one per email, by invites_open_idx). */
async function listInvites(db: Db, target: MemberTarget): Promise<PendingInvite[]> {
  return db.select({ email: invites.email, role: invites.role }).from(invites).where(openInvite(target)).orderBy(sql`rowid`);
}

const changed = (result: D1Result | undefined) => (result?.meta?.changes ?? 0) > 0;

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SQL for a role's rank in ROLES order, so a write can only raise. */
const rank = (expression: string) => `CASE ${expression} ${ROLES.map((role, i) => `WHEN '${role}' THEN ${i}`).join(' ')} END`;

const grantTable = (target: MemberTarget): [string, string] => (target.type === 'doc' ? ['doc_members', 'doc_id'] : ['folder_members', 'folder_id']);

/** SQL that holds while user `?{user}` still manages the target `?{id}`, so a change loses to a demotion that commits
 * while the request is under way (docs/METHOD.md). Only a signed-in person manages. */
const manages = (target: MemberTarget, id: number, user: number) => (target.type === 'doc' ? managesDoc(id, user) : managesFolder(id, user));
const managerId = (caller: Principal) => (caller.type === 'user' ? caller.id : '');

/** After a write that changed nothing: the refusal when the caller no longer manages the target, else null. */
async function lostManage(db: Db, caller: Principal, target: MemberTarget): Promise<Response | null> {
  const access = await accessTo(db, caller, target);
  if (!access) return notFound();
  return access.role === 'owner' ? null : refuse(403, 'forbidden', `Only the owner can share this ${noun(target)}.`);
}

/**
 * Adds a person by email at a share role, or raises their role. Every new share is an open invite, which the owner
 * sees by email until the grantee first opens the item (`acceptShares`); a known email is also granted at once, an
 * unknown one waits for its invite to be redeemed. Both answer `{shared: {email, role}}` with the same status, so
 * neither the answer nor the member list says whether an account exists.
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
  const personId = person?.id ?? null;
  const [table, column] = grantTable(target);
  const now = Date.now();

  // One batch, each statement seeing the one before. The invite goes in only while the owner's last hour holds fewer
  // than SHARES_PER_HOUR (counted by the statement that inserts, so a burst can't pass), only for someone who is not
  // a member yet, and once per open email (a concurrent first share conflicts and becomes a repeat). A known account
  // is granted at its open invite's role, only when this share asks for no less (a refused lowering writes nothing).
  // Repeats and raises only ever raise the stored role. A known and an unknown email run the same statements (the
  // grant ones match nothing without an account), so the time a share takes says nothing either.
  const statements = [
    env.DB.prepare(`INSERT INTO invites (token, email, target_type, target_id, role, invited_by, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE (SELECT count(*) FROM invites WHERE invited_by = ?6 AND created_at > ?8) < ${SHARES_PER_HOUR}
        AND NOT EXISTS (SELECT 1 FROM ${table} WHERE ${column} = ?4 AND principal_id = ?9) AND ${manages(target, 4, 10)}
      ON CONFLICT DO NOTHING`).bind(randomToken(), email, target.type, target.id, role, inviter, now, now - HOUR_MS, personId, managerId(caller)),
    env.DB.prepare(`UPDATE invites SET role = ?4 WHERE target_type = ?1 AND target_id = ?2 AND email = ?3
      AND accepted_at IS NULL AND revoked_at IS NULL AND ${rank('role')} < ${rank('?4')} AND ${manages(target, 2, 5)}`)
      .bind(target.type, target.id, email, role, managerId(caller)),
    env.DB.prepare(`INSERT INTO ${table} (${column}, principal_id, principal_type, role, added_by, created_at)
      SELECT ?2, ?4, 'user', invites.role, ?6, ?7 FROM invites WHERE ?4 IS NOT NULL AND target_type = ?1 AND target_id = ?2
        AND email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL AND ${rank('invites.role')} <= ${rank('?5')}
        AND ${manages(target, 2, 8)}
      ON CONFLICT DO NOTHING`).bind(target.type, target.id, email, personId, role, caller.id, now, managerId(caller)),
    env.DB.prepare(`UPDATE ${table} SET role = ?2 WHERE ${column} = ?1 AND principal_id = ?3 AND ${rank('role')} < ${rank('?2')}
      AND ${manages(target, 1, 4)}`).bind(target.id, role, personId, managerId(caller)),
  ];
  const [admitted, , granted] = await env.DB.batch(statements);
  if (personId && changed(granted) && env.PrincipalDO) {
    // The grantee's open tabs refresh their vaults and shared items, off the response path so its timing says
    // nothing about whether the email has an account; the committed share stands if this fails.
    const notify = publishTo({ DB: env.DB, PrincipalDO: env.PrincipalDO }, personId, { type: 'vaults' })
      .catch((error: unknown) => console.error('workspace share notification failed', error));
    waitUntil(notify);
  }
  if (changed(admitted)) return json({ shared: { email, role } }, 201, NO_STORE);
  const lost = await lostManage(db, caller, target);
  if (lost) return lost;
  // Not a new share: the person already has access here, or the owner is over the hourly limit.
  const [invite] = await db.select({ role: invites.role }).from(invites).where(openInvite(target, email)).limit(1);
  const [grant] = await grantRows(db, target, personId ?? '');
  const held = [invite?.role, grant?.role].filter((r): r is Role => r !== undefined).sort((a, b) => ROLES.indexOf(b) - ROLES.indexOf(a))[0];
  if (held === undefined) {
    return refuse(429, 'rate-limited', 'You’ve shared with a lot of people in the last hour. Try again later.', { 'retry-after': '3600' });
  }
  if (lower(role, held)) {
    return refuse(409, 'demotion-unavailable', `${email} already has more access. To lower it, change it under People with access.`);
  }
  return json({ shared: { email, role } }, 200, NO_STORE);
}

/**
 * Redeems a signed-in user's pending email shares on a doc and on every folder above it when they open it; from then
 * the owner sees them by name. Only a share they hold a grant for is redeemed: an invite to an email that had no
 * account waits for its own link (T2.8).
 */
export async function acceptShares(db: D1Database, principal: Principal, docId: string, access: { ownerUserId: string; linkOnly: boolean }): Promise<void> {
  if (principal.type !== 'user' || access.linkOnly || access.ownerUserId === principal.id) return;
  await db.prepare(`WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT folders.id, folders.parent_id, 1 FROM folders JOIN docs ON docs.folder_id = folders.id WHERE docs.id = ?1
      UNION ALL SELECT folders.id, folders.parent_id, chain.depth + 1 FROM folders JOIN chain ON folders.id = chain.parent_id
        WHERE chain.depth < ${MAX_FOLDER_DEPTH}
    )
    UPDATE invites SET accepted_at = ?2, accepted_by = ?3
    WHERE email = ?4 AND accepted_at IS NULL AND revoked_at IS NULL AND (
      (target_type = 'doc' AND target_id = ?1 AND EXISTS (SELECT 1 FROM doc_members WHERE doc_id = ?1 AND principal_id = ?3))
      OR (target_type = 'folder' AND target_id IN (SELECT id FROM chain)
        AND EXISTS (SELECT 1 FROM folder_members WHERE folder_id = invites.target_id AND principal_id = ?3)))`)
    .bind(docId, Date.now(), principal.id, principal.email.toLowerCase()).run();
}

const KICK_FAILED = 'The change is saved, but some open windows haven’t closed yet. Try again.';

/**
 * Closes `principalIds` (with their agents) on every doc the target reaches, after the change committed. A DocDO that
 * does not acknowledge answers 503 so the owner retries; a retry kicks again.
 */
async function kickFrom(
  db: D1Database, env: MembersEnv, target: MemberTarget, principalIds: string[], at: number, notified = principalIds,
): Promise<Response | null> {
  if (!env.DocDO) return refuse(503, 'unavailable', KICK_FAILED);
  try {
    await kick({ DB: db, DocDO: env.DocDO }, await docsOf(db, target), { principalIds: await withAgents(db, principalIds) }, at);
  } catch (error) {
    if (!(error instanceof KickFailed)) throw error;
    return refuse(503, 'unavailable', KICK_FAILED);
  }
  // Their sidebar drops what they can no longer open, without a reload.
  const event = target.type === 'doc' ? { type: 'meta' as const, docIds: [target.id], folderIds: [] } : { type: 'vaults' as const };
  const principalDO = env.PrincipalDO;
  if (principalDO) {
    for (const id of notified) {
      waitUntil(publishTo({ DB: db, PrincipalDO: principalDO }, id, event).catch((error: unknown) => console.error('workspace kick notification failed', error)));
    }
  }
  return null;
}

/**
 * PATCH `{principalId | email, role}` changes access and DELETE `{principalId | email}` removes it. A member is named by
 * id: lowering or removing them kicks them (a raise waits for their reload, A§8). An invite still pending is named by
 * email and runs the same statements whether or not the email has an account. A known account was granted at once and
 * may be opening the note as the invite changes, so every change by email kicks; an unknown one kicks a fresh id, so
 * the work and the answer are the same.
 */
async function change(
  db: Db, env: MembersEnv, target: MemberTarget, ownerUserId: string, caller: Principal, body: Record<string, unknown>, remove: boolean,
): Promise<Response> {
  const role = body.role;
  if (!remove && !isShareRole(role)) return refuse(400, 'bad-request', 'Choose view, comment, edit or owner access.');
  const [table, column] = grantTable(target);
  const callerId = managerId(caller);
  if (typeof body.email === 'string') {
    const email = body.email.trim().toLowerCase();
    if (!EMAIL.test(email)) return refuse(400, 'bad-request', 'Enter an email address.');
    const [person] = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`).limit(1);
    const personId = person?.id ?? null;
    const open = `target_type = ?1 AND target_id = ?2 AND email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL`;
    const pendingGrant = `${column} = ?2 AND principal_id = ?4 AND EXISTS (SELECT 1 FROM invites WHERE ${open})`;
    // The grant statement first, while the invite it checks is still open; both match nothing for an unknown email.
    const [, changedInvite] = await env.DB.batch(remove
      ? [
          env.DB.prepare(`DELETE FROM ${table} WHERE ${pendingGrant} AND ${manages(target, 2, 5)}`).bind(target.type, target.id, email, personId, callerId),
          env.DB.prepare(`UPDATE invites SET revoked_at = ?4 WHERE ${open} AND ${manages(target, 2, 5)}`).bind(target.type, target.id, email, Date.now(), callerId),
        ]
      : [
          env.DB.prepare(`UPDATE ${table} SET role = ?5 WHERE ${pendingGrant} AND ${manages(target, 2, 6)}`).bind(target.type, target.id, email, personId, role, callerId),
          env.DB.prepare(`UPDATE invites SET role = ?4 WHERE ${open} AND ${manages(target, 2, 5)}`).bind(target.type, target.id, email, role, callerId),
        ]);
    if (!changed(changedInvite)) {
      const lost = await lostManage(db, caller, target);
      if (lost) return lost;
      // A retry of a removal whose kick failed finds the invite already revoked and no grant left: kick again, for a
      // known and an unknown email alike.
      const revoked = remove && await env.DB.prepare(`SELECT 1 FROM invites WHERE target_type = ?1 AND target_id = ?2 AND email = ?3
        AND revoked_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${table} WHERE ${column} = ?2 AND principal_id = ?4) LIMIT 1`)
        .bind(target.type, target.id, email, personId).first();
      if (!revoked) return refuse(404, 'not-found', 'That invite is no longer open.');
    }
    const failed = await kickFrom(env.DB, env, target, [personId ?? crypto.randomUUID()], Date.now(), personId ? [personId] : []);
    if (failed) return failed;
    return json(remove ? { removed: { email } } : { changed: { email, role } }, 200, NO_STORE);
  }
  const principalId = typeof body.principalId === 'string' ? body.principalId : '';
  // Compare-and-set on the role read, so whether this is a raise (which kicks nobody) is decided from the role it
  // replaced; a change that lands in between sends it round again.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [grant] = principalId ? await grantRows(db, target, principalId) : [];
    if (!grant) {
      const lost = await lostManage(db, caller, target);
      if (lost) return lost;
      // A retry of a removal whose kick failed: the grant is gone, so kick again (never the vault's owner).
      if (!remove || !principalId || principalId === ownerUserId) return refuse(404, 'not-found', 'That person no longer has access here.');
      return (await kickFrom(env.DB, env, target, [principalId], Date.now())) ?? json({ removed: { principalId } }, 200, NO_STORE);
    }
    let done: boolean;
    if (remove) {
      const [person] = grant.principalType === 'user'
        ? await db.select({ email: user.email }).from(user).where(eq(user.id, principalId)).limit(1) : [];
      // An open invite to them would grant again when redeemed; revoked first, while the caller's manage still holds.
      const [, deleted] = await env.DB.batch([
        env.DB.prepare(`UPDATE invites SET revoked_at = ?4 WHERE target_type = ?1 AND target_id = ?2 AND email = ?3
          AND accepted_at IS NULL AND revoked_at IS NULL AND ${manages(target, 2, 5)}`)
          .bind(target.type, target.id, person?.email.toLowerCase() ?? '', Date.now(), callerId),
        env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?1 AND principal_id = ?2 AND ${manages(target, 1, 3)}`).bind(target.id, principalId, callerId),
      ]);
      done = changed(deleted);
    } else {
      done = changed(await env.DB.prepare(`UPDATE ${table} SET role = ?3 WHERE ${column} = ?1 AND principal_id = ?2 AND role = ?4
        AND ${manages(target, 1, 5)}`).bind(target.id, principalId, role, grant.role, callerId).run());
    }
    if (!done) {
      const lost = await lostManage(db, caller, target);
      if (lost) return lost;
      continue;
    }
    const raise = !remove && lower(grant.role, role as Role);
    if (!raise) {
      const failed = await kickFrom(env.DB, env, target, [principalId], Date.now());
      if (failed) return failed;
    }
    return json(remove ? { removed: { principalId } } : { changed: { principalId, role } }, 200, NO_STORE);
  }
  return refuse(409, 'conflict', 'Their access changed while this was saving. Try again.');
}

/** GET and POST `/api/{docs,folders}/:id/members`; PATCH and DELETE change and remove access. */
export async function handleMembers(request: Request, env: MembersEnv, target: MemberTarget): Promise<Response> {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return json({ error: 'method-not-allowed' }, 405, { allow: 'GET, POST, PATCH, DELETE' });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  // Link-only visitors may read content, never the identities of its collaborators.
  if (principal.type === 'anonymous') return notFound();
  const db = createDb(env.DB);
  const access = await accessTo(db, principal, target);
  if (!access) return notFound();
  const owner = access.role === 'owner';
  if (request.method === 'GET') {
    const pending = await listInvites(db, target);
    const members = await listMembers(db, target, access.ownerUserId, owner, new Set(pending.map((invite) => invite.email)));
    return json(owner ? { members, invites: pending } : { members }, 200, NO_STORE);
  }
  if (!owner) return refuse(403, 'forbidden', `Only the owner can share this ${noun(target)}.`);
  const body = await readJsonObject(request);
  if (!body) return refuse(400, 'bad-request', 'The request body must be a JSON object.');
  // Every write below re-checks manage in its own statement; reading again after the body only narrows the window.
  const current = await accessTo(db, principal, target);
  if (!current) return notFound();
  if (current.role !== 'owner') return refuse(403, 'forbidden', `Only the owner can share this ${noun(target)}.`);
  if (request.method === 'POST') return share(db, env, target, access.ownerUserId, principal, body);
  return change(db, env, target, access.ownerUserId, principal, body, request.method === 'DELETE');
}
