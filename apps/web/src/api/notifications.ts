// The bell's notices (T2.8, A§8): D1 rows written beside the event, pushed to the recipient's tabs through their
// PrincipalDO, and re-checked against the reader's live access whenever they are read, so a notice about an item they
// can no longer open is left out, title and all (L§1.6 D-G6). An email is never an authority (PRODUCT ruling 19), so
// nothing tells an account about an invite before it holds the link: the invite events are an inviter hearing that
// their invite was accepted, and share notices left from before the ruling. Comment notices (T4.4) are a mention and
// a reply to the reader's thread, written by comments.ts.
import { inArray, sql } from 'drizzle-orm';
import type { Principal } from '../auth/principal.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs, folders, user } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess, resolveFolderAccess } from './access.ts';
import { notify, type InvitesEnv } from './invites.ts';
import { NO_STORE, readJsonObject, unauthenticated } from './respond.ts';

const TYPES = ['share-invite', 'invite-accepted', 'mention', 'comment-reply'] as const;
type NoticeType = (typeof TYPES)[number];

/** How many of the newest notices the bell shows. */
export const NOTICE_LIMIT = 50;

type Reader = Extract<Principal, { type: 'user' }>;

export interface Notice {
  id: string;
  type: NoticeType;
  read: boolean;
  createdAt: number;
  /** Who acted: the sharer, or the person who accepted an invite. */
  by: string;
  target: { type: 'doc' | 'folder'; id: string; title: string; kind: 'doc' | 'folder' | 'vault' };
  /** An accepted invite sent to another address than the one it was accepted with. */
  invitedEmail?: string;
  /** The comment a mention or reply notice is about. */
  commentId?: string;
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
  commentId?: string;
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
      ...(typeof value.commentId === 'string' ? { commentId: value.commentId } : {}),
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

async function listNotices(d1: D1Database, reader: Reader): Promise<Notice[]> {
  const db = createDb(d1);
  const rows = await db.all<Row>(sql`SELECT id, type, payload_json AS payload, created_at AS createdAt, read_at AS readAt
    FROM notifications WHERE user_id = ${reader.id} AND type IN (SELECT value FROM json_each(${JSON.stringify(TYPES)}))
    ORDER BY created_at DESC, rowid DESC LIMIT ${NOTICE_LIMIT}`);
  const live: { row: Row; payload: Payload }[] = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    if (!payload) continue;
    if (await reachable(db, reader, payload)) live.push({ row, payload });
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
    if (payload.commentId) notice.commentId = payload.commentId;
    return notice;
  });
}

const MAX_IDS = 100;

/** POST `/api/notifications/read` `{ids}`: marks the caller's notices read. */
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
