// The suggestion review REST API (docs/design/suggestions.md §4, §8): GET .../suggestions/:sid/preview for any reader,
// POST .../accept {previewHash, digest} and .../reject for an editor or above, POST .../withdraw for a suggester or
// above (the DocDO checks that the caller is the author). Each is counted per principal by its PrincipalDO, and the
// DocDO re-authorizes the actor in the same serialized turn as the action (A§8), so the Worker's role is never the
// last word. A new live suggestion writes the bell's rows for the people who can review it.
import { getServerByName } from 'partyserver';
import { SUGGEST_PREVIEW_RATE, SUGGEST_REVIEW_RATE } from '@moss-multi/protocol/limits';
import { roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { resolvePrincipal, shareTokenOf, type Principal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess } from './access.ts';
import type { DocsEnv } from './docs.ts';
import { notify, type InvitesEnv } from './invites.ts';
import { NO_STORE, notFound, readJsonObject } from './respond.ts';

/** Record ids, as the DocDO mints them. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[A-Za-z0-9_-]{1,128}$/;

export const SUGGESTION_ROUTE = /^\/api\/docs\/([^/]+)\/suggestions\/([^/]+)\/(preview|accept|reject|withdraw)$/;

type Action = 'preview' | 'accept' | 'reject' | 'withdraw';
type Actor = Exclude<Principal, { type: 'anonymous' }>;

const FLOOR: Record<Action, Role> = { preview: 'viewer', accept: 'editor', reject: 'editor', withdraw: 'suggester' };

const MESSAGE: Record<Action, string> = {
  preview: "You can't open this note.",
  accept: 'Only an editor can accept a suggestion.',
  reject: 'Only an editor can reject a suggestion.',
  withdraw: 'Only its author can withdraw a suggestion.',
};

interface Verdict {
  ok: boolean;
  status?: number;
  reason?: string;
  hunks?: unknown[];
  hash?: string;
  digest?: string;
  closed?: boolean;
}

/** `/api/docs/:id/suggestions/:sid/{preview,accept,reject,withdraw}`. */
export async function handleSuggestion(request: Request, env: DocsEnv, docId: string, sid: string, action: Action): Promise<Response> {
  const method = action === 'preview' ? 'GET' : 'POST';
  if (request.method !== method) return json({ error: 'method-not-allowed' }, 405, { allow: method });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return json({ error: 'unauthenticated', message: 'Sign in to review suggestions' }, 401, NO_STORE);
  // The body is read before access resolves, so a stalled body cannot outlive a revocation or a trash.
  const body = method === 'POST' ? ((await readJsonObject(request)) ?? {}) : {};
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, FLOOR[action])) return json({ error: 'forbidden', message: MESSAGE[action] }, 403, NO_STORE);
  if (!ID.test(sid)) return json({ error: 'bad-request' }, 400, NO_STORE);
  const { previewHash, digest } = body as { previewHash?: unknown; digest?: unknown };
  if (action === 'accept' && (typeof previewHash !== 'string' || !HASH.test(previewHash) || typeof digest !== 'string' || !HASH.test(digest))) {
    return json({ error: 'bad-request' }, 400, NO_STORE);
  }
  const principalDO = await getServerByName(env.PrincipalDO, principal.id);
  const allowed = action === 'preview' ? await principalDO.takePreviewToken() : await principalDO.takeReviewToken();
  if (!allowed) {
    const window = action === 'preview' ? SUGGEST_PREVIEW_RATE.windowMs : SUGGEST_REVIEW_RATE.windowMs;
    return json({ error: 'rate-limited' }, 429, { ...NO_STORE, 'retry-after': String(window / 1000) });
  }
  const input = {
    id: sid,
    reviewer: { id: principal.id, role: access.role },
    actor: {
      kind: principal.type,
      principalId: principal.id,
      sessionId: principal.type === 'user' ? principal.sessionId : null,
      shareToken: shareTokenOf(request),
    },
  };
  const stub = await getServerByName(env.DocDO, docId);
  let verdict: Verdict;
  if (action === 'preview') verdict = (await stub.previewSuggestion(input)) as Verdict;
  else if (action === 'accept') verdict = (await stub.acceptSuggestion({ ...input, previewHash: previewHash as string, digest: digest as string })) as Verdict;
  else if (action === 'reject') verdict = (await stub.rejectSuggestion(input)) as Verdict;
  else verdict = (await stub.withdrawSuggestion(input)) as Verdict;
  if (!verdict.ok) {
    const status = verdict.status ?? 409;
    return json({ error: verdict.reason ?? 'refused' }, status === 404 ? 404 : status, NO_STORE);
  }
  if (action === 'preview') {
    return json({ preview: { hunks: verdict.hunks ?? [], hash: verdict.hash, digest: verdict.digest, ...(verdict.closed ? { closed: true } : {}) } }, 200, NO_STORE);
  }
  const status = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'withdrawn';
  return json({ suggestion: { id: sid, status } }, 200, NO_STORE);
}

/**
 * The bell's rows for a new live suggestion (PRODUCT: the inbox notifies on suggestion): one `suggestion` row for the
 * doc's owner and each person granted editor or owner on it, each re-checked against their live access, never the
 * author and never an agent. A failure here loses only the notices, never the suggestion.
 */
export async function notifySuggestion(env: Pick<InvitesEnv, 'DB' | 'PrincipalDO'>, notice: { docId: string; author: string; record: string }): Promise<void> {
  try {
    const owners = await env.DB.prepare(`SELECT owner_user_id AS id FROM docs WHERE id = ?1 AND deleted_at IS NULL
      UNION SELECT principal_id AS id FROM doc_members WHERE doc_id = ?1 AND principal_type = 'user' AND role IN ('editor', 'owner')`)
      .bind(notice.docId).all<{ id: string }>();
    const db = createDb(env.DB);
    const recipients: string[] = [];
    for (const { id } of owners.results) {
      if (id === notice.author) continue;
      const reader: Principal = { type: 'user', id, name: '', email: '', sessionId: '', credential: 'cookie' };
      const access = await resolveDocAccess(db, reader, notice.docId);
      if (access && !access.deleted && !access.linkOnly && roleAtLeast(access.role, 'editor')) recipients.push(id);
    }
    if (!recipients.length) return;
    const payload = JSON.stringify({ targetType: 'doc', targetId: notice.docId, by: notice.author, suggestionId: notice.record });
    const now = Date.now();
    await env.DB.batch(recipients.map((id) => env.DB.prepare(`INSERT INTO notifications (id, user_id, type, payload_json, created_at)
      VALUES (?1, ?2, 'suggestion', ?3, ?4)`).bind(crypto.randomUUID(), id, payload, now)));
    for (const id of recipients) notify(env as InvitesEnv, id, 'notifications');
  } catch (error) {
    console.error('suggestion notifications failed', error);
  }
}
