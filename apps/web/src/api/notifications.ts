// The bell's notices (T2.8, A§8). A share's notice is derived from its invite on the reader's own path: the open
// invites to the reader's email become notices when they read the bell, so the inviter's path never looks up an
// account. An accepted invite's notice is a row written when it is redeemed. Every notice is re-checked whenever it
// is read: a share's while its invite is live (open, its item live and its inviter still managing it) or, once the
// reader redeemed it, while they can open the item; the rest are left out, title and all (L§1.6 D-G6). Pushes go
// through the recipient's PrincipalDO.
import { inArray, sql } from 'drizzle-orm';
import type { Principal } from '../auth/principal.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs, folders, user } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { managesLive, resolveDocAccess, resolveFolderAccess } from './access.ts';
import { notify, type InvitesEnv } from './invites.ts';
import { NO_STORE, readJsonObject, unauthenticated } from './respond.ts';

/** How many of the newest notices the bell shows. */
export const NOTICE_LIMIT = 50;

type Reader = Extract<Principal, { type: 'user' }>;

export interface Notice {
  id: string;
  type: 'share-invite' | 'invite-accepted';
  read: boolean;
  createdAt: number;
  /** Who acted: the sharer, or the person who accepted an invite. */
  by: string;
  target: { type: 'doc' | 'folder'; id: string; title: string; kind: 'doc' | 'folder' | 'vault' };
  /** An accepted invite sent to another address than the one it was accepted with. */
  invitedEmail?: string;
  /** A share's invite token, which the reader follows to redeem it (invites.ts). */
  invite?: string;
}

interface Row {
  id: string;
  type: string;
  payload: string;
  createdAt: number;
  readAt: number | null;
}

interface Payload {
  targetType: 'doc' | 'folder';
  targetId: string;
  by: string;
  invitedEmail?: string;
  invite?: string;
}

function parsePayload(text: string): Payload | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if ((value.targetType !== 'doc' && value.targetType !== 'folder') || typeof value.targetId !== 'string' || typeof value.by !== 'string') return null;
    return {
      targetType: value.targetType,
      targetId: value.targetId,
      by: value.by,
      ...(typeof value.invitedEmail === 'string' ? { invitedEmail: value.invitedEmail } : {}),
      ...(typeof value.invite === 'string' ? { invite: value.invite } : {}),
    };
  } catch {
    return null;
  }
}

/** Whether the reader can still open the item through ownership or a grant (a link alone is not membership). */
async function reachable(db: Db, principal: Principal, payload: Payload): Promise<boolean> {
  const access = payload.targetType === 'doc'
    ? await resolveDocAccess(db, principal, payload.targetId)
    : await resolveFolderAccess(db, principal, payload.targetId);
  return access !== null && !access.deleted && !access.linkOnly;
}

/** A share's notice shows while its invite is live, or while the reader who redeemed it can open the item. */
async function liveShare(d1: D1Database, db: Db, reader: Reader, payload: Payload & { invite: string }): Promise<boolean> {
  const invite = await d1.prepare(`SELECT invited_by AS inviter, accepted_by AS acceptedBy, accepted_at AS acceptedAt, revoked_at AS revokedAt
      FROM invites WHERE token = ?`).bind(payload.invite)
    .first<{ inviter: string; acceptedBy: string | null; acceptedAt: number | null; revokedAt: number | null }>();
  if (!invite || invite.revokedAt !== null) return false;
  if (invite.acceptedAt === null) return managesLive(d1, payload.targetType, payload.targetId, invite.inviter);
  return invite.acceptedBy === reader.id && reachable(db, reader, payload);
}

/** The open invites to the reader's email become their share notices, once each (keyed by the invite). */
async function deriveShareNotices(d1: D1Database, reader: Reader): Promise<void> {
  await d1.prepare(`INSERT INTO notifications (id, user_id, type, payload_json, created_at)
      SELECT 'invite:' || token, ?1, 'share-invite',
        json_object('targetType', target_type, 'targetId', target_id, 'by', invited_by, 'invite', token), created_at
      FROM invites WHERE email = ?2 AND accepted_at IS NULL AND revoked_at IS NULL AND invited_by <> ?1
      ON CONFLICT (id) DO NOTHING`)
    .bind(reader.id, reader.email.toLowerCase()).run();
}

async function listNotices(d1: D1Database, reader: Reader): Promise<Notice[]> {
  const db = createDb(d1);
  await deriveShareNotices(d1, reader);
  const rows = await db.all<Row>(sql`SELECT id, type, payload_json AS payload, created_at AS createdAt, read_at AS readAt
    FROM notifications WHERE user_id = ${reader.id} AND type IN ('share-invite', 'invite-accepted')
    ORDER BY created_at DESC, rowid DESC LIMIT ${NOTICE_LIMIT}`);
  const live: { row: Row; payload: Payload }[] = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    if (!payload) continue;
    const invite = payload.invite;
    const shown = invite === undefined ? await reachable(db, reader, payload) : await liveShare(d1, db, reader, { ...payload, invite });
    if (shown) live.push({ row, payload });
  }
  const ids = (type: Payload['targetType']) => [...new Set(live.filter((n) => n.payload.targetType === type).map((n) => n.payload.targetId))];
  const people = [...new Set(live.map((n) => n.payload.by))];
  const [docRows, folderRows, userRows] = await Promise.all([
    ids('doc').length ? db.select({ id: docs.id, title: docs.title }).from(docs).where(inArray(docs.id, ids('doc'))) : [],
    ids('folder').length ? db.select({ id: folders.id, name: folders.name, kind: folders.kind }).from(folders).where(inArray(folders.id, ids('folder'))) : [],
    people.length ? db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, people)) : [],
  ]);
  const docTitles = new Map(docRows.map((d) => [d.id, d.title.trim() || 'Untitled']));
  const folderNames = new Map(folderRows.map((f) => [f.id, f]));
  const names = new Map(userRows.map((u) => [u.id, u]));
  return live.map(({ row, payload }) => {
    const folder = folderNames.get(payload.targetId);
    const actor = names.get(payload.by);
    const notice: Notice = {
      id: row.id,
      type: row.type as Notice['type'],
      read: row.readAt !== null,
      createdAt: row.createdAt,
      by: actor?.name ?? 'Someone',
      target: payload.targetType === 'doc'
        ? { type: 'doc', id: payload.targetId, title: docTitles.get(payload.targetId) ?? 'Untitled', kind: 'doc' }
        : { type: 'folder', id: payload.targetId, title: folder?.name ?? 'a folder', kind: folder?.kind ?? 'folder' },
    };
    if (payload.invitedEmail && actor && payload.invitedEmail !== actor.email.toLowerCase()) notice.invitedEmail = payload.invitedEmail;
    if (payload.invite) notice.invite = payload.invite;
    return notice;
  });
}

const MAX_IDS = 100;

/** POST `/api/notifications/read` `{ids}`: marks the caller's notices read. Reading redeems nothing (invites.ts). */
async function markRead(request: Request, env: InvitesEnv, reader: Reader): Promise<Response> {
  const body = await readJsonObject(request);
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string')) {
    return json({ error: 'bad-request', message: 'Send the ids of the notices to mark read.' }, 400, NO_STORE);
  }
  const marked = ids.length === 0 ? 0 : (await env.DB.prepare(`UPDATE notifications SET read_at = ?1
      WHERE user_id = ?2 AND read_at IS NULL AND id IN (SELECT value FROM json_each(?3))`)
    .bind(Date.now(), reader.id, JSON.stringify(ids)).run()).meta.changes ?? 0;
  // The caller's other tabs clear the same badge.
  if (marked > 0) notify(env, reader.id, 'notifications');
  return json({ marked }, 200, NO_STORE);
}

/** `/api/notifications` (GET) and `/api/notifications/read` (POST), for a signed-in person. */
export async function handleNotifications(request: Request, env: InvitesEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const allowed = pathname === '/api/notifications' ? 'GET' : 'POST';
  if (request.method !== allowed) return json({ error: 'method-not-allowed' }, 405, { allow: allowed });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type !== 'user') return unauthenticated();
  if (allowed === 'POST') return markRead(request, env, principal);
  return json({ notifications: await listNotices(env.DB, principal) }, 200, NO_STORE);
}
