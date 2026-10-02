// POST /api/feedback (A§6, A§9 analytics): moss's Feedback dialog writes one row per submission.
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { feedback as feedbackTable } from '../db/schema.ts';
import { json } from '../worker/route.ts';

const MAX_BODY = 10_000;
const MAX_PAGE = 2_000;

/** A cookie-authenticated write needs a same-origin `Origin` (L§4.9). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(request.url).origin;
}

export async function feedback(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type !== 'user') return json({ error: 'unauthenticated' }, 401);
  const input = (await request.json().catch(() => null)) as { body?: unknown; email?: unknown; page?: unknown } | null;
  const text = typeof input?.body === 'string' ? input.body.trim() : '';
  if (!text || text.length > MAX_BODY) return json({ error: 'invalid-body' }, 400);
  const email = typeof input?.email === 'string' && input.email.trim() ? `\n\nReply to: ${input.email.trim().slice(0, 320)}` : '';
  const page = typeof input?.page === 'string' ? input.page.slice(0, MAX_PAGE) : null;
  await createDb(env.DB)
    .insert(feedbackTable)
    .values({ id: crypto.randomUUID(), userId: principal.id, body: `${text}${email}`, page, createdAt: Date.now() });
  return json({ ok: true }, 201);
}
