// POST /api/feedback (A§6, A§9 analytics): moss's Feedback dialog writes one row per submission.
import { DAY_MS, FEEDBACK_DAILY } from '@moss-multi/protocol/limits';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { json } from '../worker/route.ts';
import { changed, overDailyBound, readJsonObject } from './respond.ts';

const MAX_BODY = 10_000;
const MAX_PAGE = 2_000;
// The body, page and email at six bytes a character (a JSON-escaped control character), with room for the keys.
const MAX_REQUEST_BYTES = 128 * 1024;

export async function feedback(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type !== 'user') return json({ error: 'unauthenticated' }, 401);
  const input = await readJsonObject(request, MAX_REQUEST_BYTES);
  const text = typeof input?.body === 'string' ? input.body.trim() : '';
  if (!text || text.length > MAX_BODY) return json({ error: 'invalid-body' }, 400);
  const email = typeof input?.email === 'string' && input.email.trim() ? `\n\nReply to: ${input.email.trim().slice(0, 320)}` : '';
  const page = typeof input?.page === 'string' ? input.page.slice(0, MAX_PAGE) : null;
  const inserted = await env.DB.prepare(`INSERT INTO feedback (id, user_id, body, page, created_at) SELECT ?1, ?2, ?3, ?4, ?5
    WHERE (SELECT count(*) FROM feedback WHERE user_id = ?2 AND created_at > ?5 - ${DAY_MS}) < ${FEEDBACK_DAILY}`)
    .bind(crypto.randomUUID(), principal.id, `${text}${email}`, page, Date.now()).run();
  if (!changed(inserted)) return overDailyBound(`You can send ${FEEDBACK_DAILY} messages a day. Thank you, and try again tomorrow.`);
  return json({ ok: true }, 201);
}
