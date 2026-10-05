// The members API (T1.1, A§8): who has access to a doc, folder or vault, and sharing it with a person by email. Only
// the owner shares, emails reach the owner alone, and a missing target answers like an inaccessible one. Lowering or
// removing access waits for the one kick path (T2.5), so a grant here only adds or raises.
import { and, eq, sql } from 'drizzle-orm';
import { ROLES, SHARE_ROLES, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, type Principal } from '../auth/principal.ts';
import { createDb, inJson, type Db } from '../db/client.ts';
import { agents, docMembers, folderMembers, user } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess, resolveFolderAccess } from './access.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

export type MemberTarget = { type: 'doc' | 'folder'; id: string };

export interface Member {
  principalId: string;
  principalType: 'user' | 'agent';
  name: string;
  /** The owner's view only. */
  email?: string;
  role: Role;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const isShareRole = (value: unknown): value is ShareRole => typeof value === 'string' && (SHARE_ROLES as readonly string[]).includes(value);

const refuse = (status: number, error: string, message: string) => json({ error, message }, status, NO_STORE);

/** Member identities require ownership or grants; a share link grants content access only. */
async function accessTo(db: Db, principal: Principal, target: MemberTarget): Promise<{ role: Role; ownerUserId: string } | null> {
  const access = target.type === 'doc'
    ? await resolveDocAccess(db, principal, target.id)
    : await resolveFolderAccess(db, principal, target.id);
  return access && !access.deleted ? access : null;
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

async function currentRole(db: Db, target: MemberTarget, principalId: string): Promise<Role | null> {
  const [row] = await grantRows(db, target, principalId);
  return row?.role ?? null;
}

/** Adds a person by email at a share role, or raises their role; a lower role is refused until T2.5's kick path. */
async function share(db: Db, target: MemberTarget, ownerUserId: string, caller: Principal, body: Record<string, unknown>): Promise<Response> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return refuse(400, 'bad-request', 'Enter an email address.');
  if (!isShareRole(body.role)) return refuse(400, 'bad-request', 'Choose view, comment or edit access.');
  const role = body.role;
  const [person] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`)
    .limit(1);
  if (!person) return refuse(422, 'no-account', 'No one has signed up with that email yet.');
  const what = target.type === 'doc' ? 'note' : 'folder';
  if (person.id === ownerUserId) return refuse(409, 'already-owner', `That person owns this ${what}.`);
  const member: Member = { principalId: person.id, principalType: 'user', name: person.name, email: person.email, role };

  const held = await currentRole(db, target, person.id);
  if (held === null) {
    const row = { principalId: person.id, principalType: 'user' as const, role, addedBy: caller.id, createdAt: Date.now() };
    const inserted = target.type === 'doc'
      ? await db.insert(docMembers).values({ docId: target.id, ...row }).onConflictDoNothing()
      : await db.insert(folderMembers).values({ folderId: target.id, ...row }).onConflictDoNothing();
    if (inserted.meta.changes > 0) return json({ member }, 201, NO_STORE);
  }
  // Already a member (or a concurrent share just made them one): same role, a raise, or a refused demotion.
  const now = held ?? (await currentRole(db, target, person.id)) ?? role;
  if (ROLES.indexOf(role) < ROLES.indexOf(now)) {
    return refuse(409, 'demotion-unavailable', `${person.name} already has more access. Lowering access isn’t available yet.`);
  }
  if (role !== now) {
    if (target.type === 'doc') {
      await db.update(docMembers).set({ role }).where(and(eq(docMembers.docId, target.id), eq(docMembers.principalId, person.id)));
    } else {
      await db.update(folderMembers).set({ role }).where(and(eq(folderMembers.folderId, target.id), eq(folderMembers.principalId, person.id)));
    }
  }
  return json({ member }, 200, NO_STORE);
}

/** GET and POST `/api/{docs,folders}/:id/members`. */
export async function handleMembers(request: Request, env: AuthEnv, target: MemberTarget): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET, POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  // Link-only visitors may read content, never the identities of its collaborators.
  if (principal.type === 'anonymous') return notFound();
  const db = createDb(env.DB);
  const access = await accessTo(db, principal, target);
  if (!access) return notFound();
  if (request.method === 'GET') {
    return json({ members: await listMembers(db, target, access.ownerUserId, access.role === 'owner') }, 200, NO_STORE);
  }
  if (access.role !== 'owner') return refuse(403, 'forbidden', `Only the owner can share this ${target.type === 'doc' ? 'note' : 'folder'}.`);
  const body = await readJsonObject(request);
  if (!body) return refuse(400, 'bad-request', 'The request body must be a JSON object.');
  return share(db, target, access.ownerUserId, principal, body);
}

const FOLDER_MEMBERS = /^\/api\/folders\/([^/]+)\/members$/;

/** `/api/folders/*`: members only until the folders API (T2.2). */
export function handleFolders(request: Request, env: AuthEnv): Promise<Response> {
  const match = FOLDER_MEMBERS.exec(new URL(request.url).pathname);
  if (!match) return Promise.resolve(json({ error: 'not-found' }, 404));
  return handleMembers(request, env, { type: 'folder', id: match[1] });
}
