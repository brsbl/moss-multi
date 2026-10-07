// The members API (T1.1, T2.4, T2.5, T2.8; A§8): who has access to a doc, folder or vault, and sharing it with a person
// by email. Only an owner shares, and emails and pending invites reach owners alone. An email alone grants nothing
// (PRODUCT ruling 19): a share creates an invite bound to the email, a personal link the owner sends; access comes
// only when an account with that email redeems the link while signed in, and the invite then binds to it. The
// inviter's path reads and writes only invites, never an account found by the email, so its answer, the member list
// and their timing are the same whether or not the email has an account. Each owner may make SHARES_PER_HOUR new
// shares an hour. A share only adds or raises; PATCH changes a member's or an invite's access and DELETE removes it,
// and lowering or removing a member goes through the one kick path (T2.5): every DocDO the grant reached closes that
// person's sockets before the call answers.
import { waitUntil } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { docsOf, kick, KickFailed, publishTo, withAgents } from '@moss-multi/sync/fanout';
import { ROLES, SHARE_ROLES, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, type Principal } from '../auth/principal.ts';
import { createDb, inJson, type Db } from '../db/client.ts';
import { agents, docMembers, folderMembers, user } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { actingUserId, liveAndManaged, managesDoc, managesFolder, managesLive, reapDeadInvites, resolveDocAccess, resolveFolderAccess } from './access.ts';
import { changed, NO_STORE, notFound, readJsonObject, refuse, unauthenticated } from './respond.ts';

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

/** New shares (invites) one owner may make in an hour (A§18). */
export const SHARES_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const isShareRole = (value: unknown): value is ShareRole => typeof value === 'string' && (SHARE_ROLES as readonly string[]).includes(value);
const lower = (a: Role, b: Role) => ROLES.indexOf(a) < ROLES.indexOf(b);

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

/** The owner first, then each grant in the order it was made. A grant comes only from a redeemed invite. */
async function listMembers(db: Db, target: MemberTarget, ownerUserId: string, withEmails: boolean): Promise<Member[]> {
  const grants = await grantRows(db, target);
  const userIds = [ownerUserId, ...grants.filter((g) => g.principalType === 'user').map((g) => g.principalId)];
  const agentIds = grants.filter((g) => g.principalType === 'agent').map((g) => g.principalId);
  const [users, agentRows] = await Promise.all([
    db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inJson(user.id, userIds)),
    agentIds.length > 0 ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inJson(agents.id, agentIds)) : [],
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

export const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SQL for a role's rank in ROLES order, so a write can only raise. */
export const rank = (expression: string) => `CASE ${expression} ${ROLES.map((role, i) => `WHEN '${role}' THEN ${i}`).join(' ')} END`;

export const grantTable = (type: MemberTarget['type']): [string, string] => (type === 'doc' ? ['doc_members', 'doc_id'] : ['folder_members', 'folder_id']);

/** SQL that holds while user `?{user}` still manages the target `?{id}`, so a change loses to a demotion that commits
 * while the request is under way (docs/METHOD.md). Only a signed-in person manages. */
export const manages = (target: MemberTarget, id: number, user: number) => (target.type === 'doc' ? managesDoc(id, user) : managesFolder(id, user));
const managerId = (caller: Principal) => (caller.type === 'user' ? caller.id : '');

/** After a write that changed nothing: the refusal when the caller no longer manages the target, else null. */
async function lostManage(db: Db, caller: Principal, target: MemberTarget): Promise<Response | null> {
  const access = await accessTo(db, caller, target);
  if (!access) return notFound();
  return access.role === 'owner' ? null : refuse(403, 'forbidden', `Only the owner can share this ${noun(target)}.`);
}

/**
 * Invites a person by email at a share role, or raises their open invite. The email alone grants nothing
 * (PRODUCT ruling 19): every answer and write derives from the open invite for this email on this target alone, never
 * from an account or an earlier redemption, so a new share is a fresh invite (201), a repeat or raise answers 200, a
 * lowering of an open invite 409 and the hourly limit 429, alike for any email. An open invite whose inviter no longer
 * manages the target is withdrawn and replaced by a fresh one at this share's role. A caller who lost the target
 * meanwhile gets 404 and writes nothing. A share grants nothing: an account with the email redeems the invite's link
 * while signed in, and the invite binds to it (invites.ts).
 */
async function share(env: MembersEnv, target: MemberTarget, ownerUserId: string, caller: Principal, body: Record<string, unknown>): Promise<Response> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return refuse(400, 'bad-request', 'Enter an email address.');
  if (!isShareRole(body.role)) return refuse(400, 'bad-request', 'Choose view, comment, suggest, edit or owner access.');
  const role = body.role;
  const inviter = actingUserId(caller) ?? caller.id;
  // The vault owner is visible to every owner already; this reads that account by its id, never by the email.
  const owner = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?1').bind(ownerUserId).first<{ email: string }>();
  if (owner && owner.email.toLowerCase() === email) return refuse(409, 'already-owner', `That person owns this ${noun(target)}.`);
  const now = Date.now();
  const openInvite = `SELECT token, invited_by AS inviter, role FROM invites WHERE target_type = ?1 AND target_id = ?2
    AND email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL`;
  const open = await env.DB.prepare(openInvite).bind(target.type, target.id, email).first<{ token: string; inviter: string }>();

  // One batch, each statement seeing the one before, the same statements for every email.
  const [, admitted] = await env.DB.batch([
    // A dead open invite (its inviter no longer manages the target) is withdrawn, so this share replaces it.
    env.DB.prepare(`UPDATE invites SET revoked_at = ?3 WHERE token = ?1 AND invited_by = ?2 AND accepted_at IS NULL
        AND revoked_at IS NULL AND NOT (${liveAndManaged(target.type, 4, 2)})`)
      .bind(open?.token ?? '', open?.inviter ?? '', now, target.id),
    // A new open invite, only while the inviter's last hour holds fewer than SHARES_PER_HOUR (counted by the statement
    // that inserts, so a burst can't pass), once per open email (a concurrent first share conflicts and is a repeat).
    // It and the raise below re-check that the caller still manages the live target, so a move, trash or revocation
    // that committed after the access check wins (A§8) and a dead invite is never written back.
    env.DB.prepare(`INSERT INTO invites (token, email, target_type, target_id, role, invited_by, created_at)
        SELECT ?5, ?3, ?1, ?2, ?4, ?6, ?7
        WHERE (SELECT count(*) FROM invites WHERE invited_by = ?6 AND created_at > ?8) < ${SHARES_PER_HOUR}
          AND ${liveAndManaged(target.type, 2, 6)}
        ON CONFLICT DO NOTHING`)
      .bind(target.type, target.id, email, role, randomToken(), inviter, now, now - HOUR_MS),
    env.DB.prepare(`UPDATE invites SET role = ?4 WHERE target_type = ?1 AND target_id = ?2 AND email = ?3
        AND accepted_at IS NULL AND revoked_at IS NULL AND ${rank('role')} < ${rank('?4')} AND ${liveAndManaged(target.type, 2, 5)}`)
      .bind(target.type, target.id, email, role, inviter),
  ]);
  if (changed(admitted)) return json({ shared: { email, role } }, 201, NO_STORE);
  // The caller lost the target meanwhile: the answer an absent target gets, whatever the email.
  if (!await managesLive(env.DB, target.type, target.id, inviter)) return notFound();
  // Not a new invite: the email has an open invite here, or the inviter is over the hourly limit.
  const held = (await env.DB.prepare(openInvite).bind(target.type, target.id, email).first<{ role: Role }>())?.role;
  if (held === undefined) {
    return refuse(429, 'rate-limited', 'You’ve shared with a lot of people in the last hour. Try again later.', { 'retry-after': '3600' });
  }
  if (lower(role, held)) {
    return refuse(409, 'demotion-unavailable', `${email} is already invited with more access. To lower it, change it under People with access.`);
  }
  return json({ shared: { email, role } }, 200, NO_STORE);
}

const AGENT_ROLE_CAP = 'An agent can have at most edit access.';
const AGENT_NOT_FOUND = 'You have no agent with that ID. Copy it from your agent’s row in Settings → Agents.';
/** Inside a guarded write: the agent `?2` is live and owned by the caller, bound at `?caller`. */
const liveOwnAgent = (caller: number) => `EXISTS (SELECT 1 FROM agents WHERE id = ?2 AND owner_user_id = ?${caller} AND revoked_at IS NULL)`;

async function ownsLiveAgent(db: D1Database, agentId: string, callerId: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS ok FROM agents WHERE id = ?1 AND owner_user_id = ?2 AND revoked_at IS NULL').bind(agentId, callerId).first()) !== null;
}

/**
 * Shares the target with one of the caller's own agents by its id (A§8; PRODUCT ruling 20: an id is a label, never
 * consent, so another person's agent, a co-owner's included, gets the 404 an unknown or revoked id gets). An agent acts
 * at most as an editor. A new grant answers 201, a repeat or raise 200, a lowering 409 (as for an invite). The write
 * re-checks that the caller still manages the live target and still owns the live agent.
 */
async function shareAgent(env: MembersEnv, target: MemberTarget, caller: Principal, agentId: string, body: Record<string, unknown>): Promise<Response> {
  if (!isShareRole(body.role)) return refuse(400, 'bad-request', 'Choose view, comment, edit or owner access.');
  const role = body.role;
  if (role === 'owner') return refuse(400, 'bad-request', AGENT_ROLE_CAP);
  const callerId = managerId(caller);
  const agent = await env.DB.prepare('SELECT id, name FROM agents WHERE id = ?1 AND owner_user_id = ?2 AND revoked_at IS NULL')
    .bind(agentId, callerId).first<{ id: string; name: string }>();
  if (!agent) return refuse(404, 'agent-not-found', AGENT_NOT_FOUND);
  const [table, column] = grantTable(target.type);
  const liveAgent = liveOwnAgent(4);
  const [inserted, raised] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO ${table} (${column}, principal_id, principal_type, role, added_by, created_at)
        SELECT ?1, ?2, 'agent', ?3, ?4, ?5 WHERE ${liveAndManaged(target.type, 1, 4)} AND ${liveAgent}
        ON CONFLICT DO NOTHING`).bind(target.id, agent.id, role, callerId, Date.now()),
    env.DB.prepare(`UPDATE ${table} SET role = ?3 WHERE ${column} = ?1 AND principal_id = ?2 AND ${rank('role')} < ${rank('?3')}
        AND ${liveAndManaged(target.type, 1, 4)} AND ${liveAgent}`).bind(target.id, agent.id, role, callerId),
  ]);
  const shared = { agentId: agent.id, name: agent.name, role };
  if (changed(inserted)) return json({ shared }, 201, NO_STORE);
  if (changed(raised)) return json({ shared }, 200, NO_STORE);
  if (!await managesLive(env.DB, target.type, target.id, callerId)) return notFound();
  // Revoked or handed over meanwhile: refused as at the read, whatever grant it already holds.
  if (!await ownsLiveAgent(env.DB, agent.id, callerId)) return refuse(404, 'agent-not-found', AGENT_NOT_FOUND);
  const [grant] = await grantRows(createDb(env.DB), target, agent.id);
  if (!grant) return refuse(404, 'agent-not-found', AGENT_NOT_FOUND);
  if (lower(role, grant.role)) {
    return refuse(409, 'demotion-unavailable', `${agent.name} already has more access. To lower it, change it under People with access.`);
  }
  return json({ shared }, 200, NO_STORE);
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
 * id: lowering or removing them kicks them (a raise waits for their reload, A§8). An invite still open is named by
 * email; it has granted nothing, so changing it kicks nobody.
 */
async function change(
  db: Db, env: MembersEnv, target: MemberTarget, ownerUserId: string, caller: Principal, body: Record<string, unknown>, remove: boolean,
): Promise<Response> {
  const role = body.role;
  if (!remove && !isShareRole(role)) return refuse(400, 'bad-request', 'Choose view, comment, suggest, edit or owner access.');
  const [table, column] = grantTable(target.type);
  const callerId = managerId(caller);
  if (typeof body.email === 'string') {
    const email = body.email.trim().toLowerCase();
    if (!EMAIL.test(email)) return refuse(400, 'bad-request', 'Enter an email address.');
    // An open invite grants nothing until it is redeemed (PRODUCT ruling 19), so this writes the invite alone and kicks
    // nobody, and never reads an account by the email. An invite redeemed first is a member now, changed by id.
    const open = `target_type = ?1 AND target_id = ?2 AND email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL`;
    const written = remove
      ? env.DB.prepare(`UPDATE invites SET revoked_at = ?4 WHERE ${open} AND ${manages(target, 2, 5)}`).bind(target.type, target.id, email, Date.now(), callerId)
      : env.DB.prepare(`UPDATE invites SET role = ?4 WHERE ${open} AND ${manages(target, 2, 5)}`).bind(target.type, target.id, email, role, callerId);
    if (!changed(await written.run())) {
      const lost = await lostManage(db, caller, target);
      if (lost) return lost;
      return refuse(404, 'not-found', 'That invite is no longer open.');
    }
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
    if (!remove && grant.principalType === 'agent' && role === 'owner') return refuse(400, 'bad-request', AGENT_ROLE_CAP);
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
        // Invites they sent die with their manage, for good (A§8).
        reapDeadInvites(env.DB, Date.now()),
      ]);
      done = changed(deleted);
    } else {
      // PRODUCT ruling 20: any manager may lower an agent's grant, but only its owner raises it, while the key is live.
      const agentRaise = grant.principalType === 'agent' && lower(grant.role, role as Role);
      const [updated] = await env.DB.batch([
        env.DB.prepare(`UPDATE ${table} SET role = ?3 WHERE ${column} = ?1 AND principal_id = ?2 AND role = ?4
          AND ${manages(target, 1, 5)}${agentRaise ? ` AND ${liveOwnAgent(5)}` : ''}`).bind(target.id, principalId, role, grant.role, callerId),
        reapDeadInvites(env.DB, Date.now()),
      ]);
      done = changed(updated);
      if (!done && agentRaise && !await ownsLiveAgent(env.DB, principalId, callerId)) {
        return (await lostManage(db, caller, target)) ?? refuse(404, 'agent-not-found', AGENT_NOT_FOUND);
      }
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
    const members = await listMembers(db, target, access.ownerUserId, owner);
    if (!owner) return json({ members }, 200, NO_STORE);
    const invites = (await liveInvites(env.DB, target)).map(({ email, role }) => ({ email, role }));
    return json({ members, invites }, 200, NO_STORE);
  }
  if (!owner) return refuse(403, 'forbidden', `Only the owner can share this ${noun(target)}.`);
  const body = await readJsonObject(request);
  if (!body) return refuse(400, 'bad-request', 'The request body must be a JSON object.');
  // Every write below re-checks manage in its own statement, so a demotion that lands while the body arrives wins.
  if (request.method === 'POST') {
    return typeof body.agentId === 'string'
      ? shareAgent(env, target, principal, body.agentId, body)
      : share(env, target, access.ownerUserId, principal, body);
  }
  return change(db, env, target, access.ownerUserId, principal, body, request.method === 'DELETE');
}

