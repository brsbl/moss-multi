// The comment REST API (docs/design/comments.md §4, §12), for a commenter or above: create and reply, resolve, edit,
// delete and react. The author is the server principal, never the body; the PrincipalDO counts 60 comment operations a
// minute per principal; the DocDO re-authorizes the actor in the same serialized write (A§8), enforces authorship and writes the records through writeComments.
// After a create or reply the Worker writes the bell's rows: mentioned people and the thread's author on a reply, each
// a user re-checked against their live access, never the actor and never an agent.
import { getServerByName } from 'partyserver';
import { MAX_QUOTE } from '@moss-multi/core/anchor-frame';
import { COMMENT_OP_RATE, COMMENT_TEXT_MAX } from '@moss-multi/protocol/limits';
import type { CommentActor, CommentDeleteScope, CommentListing, CommentResult } from '@moss-multi/sync';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { resolvePrincipal, shareTokenOf, type Principal } from '../auth/principal.ts';
import { createDb, inJson, type Db } from '../db/client.ts';
import { agents, user } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess } from './access.ts';
import type { DocsEnv } from './docs.ts';
import { notify } from './invites.ts';
import { JSON_BODY_MAX_BYTES, NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

/** A create or edit body: the longest text and quote the DocDO takes, every UTF-16 unit escaped, plus the fields. */
export const COMMENT_BODY_MAX_BYTES = (COMMENT_TEXT_MAX + MAX_QUOTE) * 6 + JSON_BODY_MAX_BYTES;

/** Moss's marker ids, which the client proposes so its composer can show the comment before the record arrives. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Mentioned people notified per comment; more mentions are kept in the text but notify nobody. */
export const MENTIONS_NOTIFIED = 20;
/** A person mention in moss's comment encoding: U+2063 `@person:Name` U+2062 principal id U+2064 (comments.md §12). */
const PERSON_MENTION = /⁣@person:[^⁢⁣⁤]*⁢([^⁢⁣⁤]+)⁤/g;

type Actor = Exclude<Principal, { type: 'anonymous' }>;

/** The principal ids a comment's text mentions, in order, once each. */
export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(PERSON_MENTION)].map((match) => match[1]!.trim()).filter(Boolean))];
}

/**
 * Who the DocDO re-resolves inside its serialized write (A§8 pull validation): the principal with its session or key
 * and the request's share token, so a change committed after admission still refuses the write.
 */
function actorOf(principal: Actor, request: Request): CommentActor {
  return {
    kind: principal.type,
    principalId: principal.id,
    sessionId: principal.type === 'user' ? principal.sessionId : null,
    shareToken: shareTokenOf(request),
  };
}

/** Resolves the caller as a commenter or above on `docId` and reads the body; the DocDO re-checks it at the write. */
async function admit(request: Request, env: DocsEnv, docId: string): Promise<{ principal: Actor; actor: CommentActor; body: Record<string, unknown> } | Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return json({ error: 'unauthenticated', message: 'Sign in to comment' }, 401, NO_STORE);
  // The body is read before access resolves, so a stalled body cannot outlive a revocation or a trash.
  const body: Record<string, unknown> = request.method === 'DELETE' ? {} : ((await readJsonObject(request, COMMENT_BODY_MAX_BYTES)) ?? {});
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, 'commenter')) return json({ error: 'forbidden', message: "You can't comment on this note." }, 403, NO_STORE);
  return { principal, actor: actorOf(principal, request), body };
}

async function takeToken(env: DocsEnv, principal: Actor): Promise<Response | null> {
  const principalDO = await getServerByName(env.PrincipalDO, principal.id);
  if (await principalDO.takeCommentToken()) return null;
  return json({ error: 'rate-limited' }, 429, { ...NO_STORE, 'retry-after': String(COMMENT_OP_RATE.windowMs / 1000) });
}

const bad = () => json({ error: 'bad-request' }, 400, NO_STORE);
const refused = (result: Extract<CommentResult, { ok: false }>) => json({ error: result.error }, result.status, NO_STORE);
const sourceOf = (principal: Actor) => (principal.type === 'agent' ? 'external' : 'user');

export async function createComment(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const admitted = await admit(request, env, docId);
  if (admitted instanceof Response) return admitted;
  const { principal, actor, body } = admitted;
  const { id, text, parentId, anchor } = body;
  if (typeof id !== 'string' || !ID.test(id) || typeof text !== 'string') return bad();
  if (parentId !== undefined && (typeof parentId !== 'string' || !ID.test(parentId))) return bad();
  if (anchor !== undefined && (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor))) return bad();
  const limited = await takeToken(env, principal);
  if (limited) return limited;
  const stub = await getServerByName(env.DocDO, docId);
  const result = (await stub.createComment({
    actor,
    author: principal.id,
    source: sourceOf(principal),
    id,
    text,
    ...(parentId !== undefined ? { parentId: parentId as string } : {}),
    ...(anchor !== undefined ? { anchor: anchor as never } : {}),
  })) as CommentResult;
  if (!result.ok) return refused(result);
  await notifyComment(env, docId, principal, { commentId: id, text, rootAuthor: result.rootAuthor });
  return json({ comment: { id: result.id, quote: result.quote } }, 201, NO_STORE);
}

/**
 * POST /api/docs/:id/comments/:commentId/resolve `{resolved}` (comments.md §12): a commenter or above resolves or
 * reopens a thread; it counts against the same per-principal comment rate as a create.
 */
export async function resolveComment(request: Request, env: DocsEnv, docId: string, commentId: string): Promise<Response> {
  const admitted = await admit(request, env, docId);
  if (admitted instanceof Response) return admitted;
  const { principal, actor, body } = admitted;
  const { resolved } = body;
  if (!ID.test(commentId) || typeof resolved !== 'boolean') return bad();
  const limited = await takeToken(env, principal);
  if (limited) return limited;
  const stub = await getServerByName(env.DocDO, docId);
  const result = (await stub.resolveComment({ actor, id: commentId, resolved, by: sourceOf(principal) })) as CommentResult;
  if (!result.ok) return refused(result);
  return json({ comment: { id: commentId, resolved } }, 200, NO_STORE);
}

/** PATCH /api/docs/:id/comments/:commentId `{text}`: the author edits their comment (403 for anyone else). */
export async function editComment(request: Request, env: DocsEnv, docId: string, commentId: string): Promise<Response> {
  const admitted = await admit(request, env, docId);
  if (admitted instanceof Response) return admitted;
  const { principal, actor, body } = admitted;
  const { text } = body;
  if (!ID.test(commentId) || typeof text !== 'string') return bad();
  const limited = await takeToken(env, principal);
  if (limited) return limited;
  const stub = await getServerByName(env.DocDO, docId);
  const result = (await stub.editComment({ actor, id: commentId, author: principal.id, text })) as CommentResult;
  if (!result.ok) return refused(result);
  return json({ comment: { id: commentId } }, 200, NO_STORE);
}

/**
 * DELETE /api/docs/:id/comments/:commentId[?scope=thread]: the author deletes their comment; a thread delete is the
 * root author's. Deleting a root with replies promotes the oldest reply (comments.md §12).
 */
export async function deleteComment(request: Request, env: DocsEnv, docId: string, commentId: string): Promise<Response> {
  const admitted = await admit(request, env, docId);
  if (admitted instanceof Response) return admitted;
  const { principal, actor } = admitted;
  const scope = new URL(request.url).searchParams.get('scope') ?? 'comment';
  if (!ID.test(commentId) || (scope !== 'comment' && scope !== 'thread')) return bad();
  const limited = await takeToken(env, principal);
  if (limited) return limited;
  const stub = await getServerByName(env.DocDO, docId);
  const result = (await stub.deleteComment({ actor, id: commentId, author: principal.id, scope: scope as CommentDeleteScope })) as CommentResult;
  if (!result.ok) return refused(result);
  return json({ deleted: { id: commentId, ...(result.promoted ? { promoted: result.promoted } : {}) } }, 200, NO_STORE);
}

/** POST /api/docs/:id/comments/:commentId/reactions `{emoji, on}`: the caller's own reaction, added or removed. */
export async function reactComment(request: Request, env: DocsEnv, docId: string, commentId: string): Promise<Response> {
  const admitted = await admit(request, env, docId);
  if (admitted instanceof Response) return admitted;
  const { principal, actor, body } = admitted;
  const { emoji, on } = body;
  if (!ID.test(commentId) || typeof emoji !== 'string' || typeof on !== 'boolean') return bad();
  const limited = await takeToken(env, principal);
  if (limited) return limited;
  const stub = await getServerByName(env.DocDO, docId);
  const result = (await stub.reactComment({ actor, id: commentId, principal: principal.id, emoji, on })) as CommentResult;
  if (!result.ok) return refused(result);
  return json({ reaction: { id: commentId, emoji, on } }, 200, NO_STORE);
}

/** Whether `userId` can open the doc through ownership or a grant now (a link alone is not membership). */
async function canOpen(db: Db, userId: string, docId: string): Promise<boolean> {
  const reader: Principal = { type: 'user', id: userId, name: '', email: '', sessionId: '', credential: 'cookie' };
  const access = await resolveDocAccess(db, reader, docId);
  return access !== null && !access.deleted && !access.linkOnly;
}

/**
 * The bell's rows for a new comment (comments.md §12): `mention` for each mentioned person and `comment-reply` for the
 * thread's author on a reply, one row per person. Only user accounts get rows (an agent has no bell), each re-checked
 * against the live grant, and never the actor. A failure here loses only the notices, never the comment.
 */
async function notifyComment(env: DocsEnv, docId: string, actor: Actor, comment: { commentId: string; text: string; rootAuthor?: string }): Promise<void> {
  try {
    const wanted = new Map<string, 'mention' | 'comment-reply'>();
    for (const id of mentionedIds(comment.text).slice(0, MENTIONS_NOTIFIED)) wanted.set(id, 'mention');
    if (comment.rootAuthor && !wanted.has(comment.rootAuthor)) wanted.set(comment.rootAuthor, 'comment-reply');
    wanted.delete(actor.id);
    if (!wanted.size) return;
    const db = createDb(env.DB);
    const people = await db.select({ id: user.id }).from(user).where(inJson(user.id, [...wanted.keys()]));
    const recipients: string[] = [];
    for (const { id } of people) if (await canOpen(db, id, docId)) recipients.push(id);
    if (!recipients.length) return;
    const now = Date.now();
    const payload = JSON.stringify({ targetType: 'doc', targetId: docId, by: actor.id, commentId: comment.commentId });
    await env.DB.batch(recipients.map((id) => env.DB.prepare(`INSERT INTO notifications (id, user_id, type, payload_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)`).bind(crypto.randomUUID(), id, wanted.get(id)!, payload, now)));
    for (const id of recipients) notify(env, id, 'notifications');
  } catch (error) {
    console.error('comment notifications failed', error);
  }
}

/** Each author's display name and kind: a person by their name, an agent by its own; never an email. */
async function authorsOf(db: Db, ids: string[]): Promise<Map<string, { id: string; name: string; type: 'user' | 'agent' }>> {
  const out = new Map<string, { id: string; name: string; type: 'user' | 'agent' }>();
  if (!ids.length) return out;
  const [people, bots] = await Promise.all([
    db.select({ id: user.id, name: user.name }).from(user).where(inJson(user.id, ids)),
    db.select({ id: agents.id, name: agents.name }).from(agents).where(inJson(agents.id, ids)),
  ]);
  for (const { id, name } of people) out.set(id, { id, name, type: 'user' });
  for (const { id, name } of bots) out.set(id, { id, name, type: 'agent' });
  return out;
}

/**
 * GET /api/docs/:id/comments (A§17 `comments`): every comment thread for any reader, each root followed by its
 * replies, with authors named; the DocDO re-authorizes the reader in its serialized turn (A§8).
 */
export async function listDocComments(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const access = await resolveDocAccess(db, principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (principal.type === 'anonymous') return json({ error: 'unauthenticated', message: 'Sign in to read comments' }, 401, NO_STORE);
  const stub = await getServerByName(env.DocDO, docId);
  const result = (await stub.listComments({ reviewer: { id: principal.id, role: access.role }, actor: actorOf(principal, request) })) as
    { ok: true; comments: CommentListing[] } | { ok: false; status: number; reason: string };
  if (!result.ok) return result.status === 404 ? notFound() : json({ error: result.reason }, result.status, NO_STORE);
  const names = await authorsOf(db, [...new Set(result.comments.map((comment) => comment.author))]);
  const comments = result.comments.map((comment) => ({
    ...comment,
    author: names.get(comment.author) ?? { id: comment.author, name: 'Someone', type: 'user' as const },
  }));
  return json({ comments }, 200, NO_STORE);
}
