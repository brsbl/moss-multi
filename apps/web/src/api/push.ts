// POST /api/docs/:id/push (A§17): a CLI push. The acting user's PrincipalDO takes a push token first (an agent spends its
// owner's, so more keys add no rate and nobody else can fill the bucket; denied attempts count), then the DocDO
// re-authorizes the actor in its serialized write, merges against the base and lands the result (sync push.ts); with
// `suggest`, a suggester's merge is recorded as an open suggestion instead.
// Every answer is a PushResponse, refusals included, so the CLI can say why.
import { getServerByName } from 'partyserver';
import { MARKDOWN_CAP_BYTES, PUSH_RATE } from '@moss-multi/protocol/limits';
import type { PushResponse } from '@moss-multi/protocol/push';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { actingUserId, resolveDocAccess } from './access.ts';
import type { DocsEnv } from './docs.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

export const PUSH_ROUTE = /^\/api\/docs\/([^/]+)\/push$/;

const HASH = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

const answer = (body: PushResponse, status: number, headers: Record<string, string> = {}) => json(body, status, { ...NO_STORE, ...headers });

interface Verdict {
  ok: boolean;
  status?: number;
  reason?: string;
  applied?: number;
  failedHunks?: string[];
  deletedRatio?: number;
  message?: string;
  suggestionId?: string;
}

export async function handlePush(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  // The body is read before access resolves, so a stalled body cannot outlive a revocation or a trash.
  const body = await readJsonObject(request);
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  const person = actingUserId(principal) ?? principal.id;
  const limiter = await getServerByName(env.PrincipalDO, person);
  if (!(await limiter.takePushToken())) {
    const after = String(PUSH_RATE.windowMs / 1000);
    return answer({ ok: false, reason: 'rate-limited', retryAfterSec: Number(after) }, 429, { 'retry-after': after });
  }
  const { newText, baseHash, baseText, force, suggest } = body ?? {};
  // A suggestion needs suggester; an edit, editor (A§8 capabilities).
  if (!roleAtLeast(access.role, suggest === true ? 'suggester' : 'editor')) return answer({ ok: false, reason: 'forbidden' }, 403);
  if (typeof newText !== 'string' || typeof baseHash !== 'string' || !HASH.test(baseHash) || (baseText !== undefined && typeof baseText !== 'string')) {
    return json({ error: 'bad-request', message: 'A push needs newText and a sha-256 baseHash' }, 400, NO_STORE);
  }
  if (encoder.encode(newText).byteLength > MARKDOWN_CAP_BYTES) return answer({ ok: false, reason: 'too-large' }, 413);
  if (typeof baseText === 'string' && encoder.encode(baseText).byteLength > 2 * MARKDOWN_CAP_BYTES) return answer({ ok: false, reason: 'too-large' }, 413);
  const stub = await getServerByName(env.DocDO, docId);
  const verdict = (await stub.push({
    newText,
    baseHash,
    ...(typeof baseText === 'string' ? { baseText } : {}),
    force: force === true,
    suggest: suggest === true,
    authorName: principal.name,
    // An agent's push shows it, Bot-badged, in the face pile of everyone in the note (A§10.7).
    ...(principal.type === 'agent' ? { presence: { id: principal.id, name: principal.name } } : {}),
    reviewer: { id: principal.id, role: access.role },
    actor: {
      kind: principal.type,
      principalId: principal.id,
      sessionId: principal.type === 'user' ? principal.sessionId : null,
      shareToken: shareTokenOf(request),
    },
  })) as Verdict;
  if (verdict.ok && verdict.suggestionId) return answer({ ok: true, mode: 'suggest', suggestionId: verdict.suggestionId, failedHunks: verdict.failedHunks ?? [] }, 200);
  if (verdict.ok) return answer({ ok: true, mode: 'edit', applied: verdict.applied ?? 0, failedHunks: verdict.failedHunks ?? [] }, 200);
  switch (verdict.reason) {
    case 'base-missing': return answer({ ok: false, reason: 'base-missing' }, 409);
    case 'degenerate': return answer({ ok: false, reason: 'degenerate', deletedRatio: verdict.deletedRatio ?? 1 }, 409);
    case 'too-large': return answer({ ok: false, reason: 'too-large' }, 413);
    case 'suggest-refused': return answer({ ok: false, reason: 'suggest-refused', message: verdict.message ?? 'the suggestion was refused' }, 409);
    case 'push-unverified': return answer({ ok: false, reason: 'push-unverified', message: verdict.message ?? 'the push would not land exactly as pushed' }, 409);
    case 'role': return answer({ ok: false, reason: 'forbidden' }, 403);
    case 'base-mismatch': return json({ error: 'bad-request', message: 'baseText does not hash to baseHash' }, 400, NO_STORE);
    case 'trashed':
    case 'not-found': return notFound();
    case 'unauthenticated': return unauthenticated();
    case 'forbidden': return answer({ ok: false, reason: 'forbidden' }, 403);
    default: return json({ error: verdict.reason ?? 'refused' }, verdict.status ?? 409, NO_STORE);
  }
}
